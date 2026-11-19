import { decodeTxError } from "@qorechain/sdk";
import { decodeTx, type DecodedMsg } from "./decode.js";
import { addressesOf, enrich, fromMessages, parseEvents, type AbciEvent, type ChainEvent } from "./events.js";
import { evmToQor, isEvmAddress, isQorAddress } from "./address.js";
import { parseCoins, type Coin } from "./amount.js";

/** The ABCI result of one transaction, as in /block_results and /tx_search. */
export interface AbciTxResult {
  code: number;
  codespace?: string;
  log?: string;
  gas_used?: string;
  gas_wanted?: string;
  events: AbciEvent[];
}

/** Everything QoreWatch knows about one transaction. */
export interface TxRecord {
  height: number;
  /** Upper-case hex Cosmos transaction hash (what explore.qore.network uses). */
  hash: string;
  /** Block time, ISO 8601. */
  time: string;
  /** Position in its block. */
  index: number;
  code: number;
  failed: boolean;
  /** A readable reason when the transaction failed (on the native lane or in the EVM). */
  failReason?: string;
  memo: string;
  messages: DecodedMsg[];
  /** The account that signed (and normally paid for) the transaction. */
  signer?: string;
  /** Signed with QoreChain's hybrid secp256k1 + ML-DSA-87 signature. */
  hybridSigned: boolean;
  /** The chain recorded that this transaction carried only a classical signature. */
  classicalOnly: boolean;
  fee: Coin[];
  feeGranter?: string;
  /** Present for EVM transactions. */
  evmHash?: string;
  events: ChainEvent[];
  /** Every qor1 address the transaction touches (signer, senders, recipients, granters…). */
  addresses: string[];
}

export interface RawTx {
  /** base64 transaction bytes. */
  tx: string;
  result: AbciTxResult;
  height: number | string;
  time: string;
  index?: number;
  /** Known hash (tx_search); computed from the bytes otherwise. */
  hash?: string;
}

/** Build a TxRecord from raw CometBFT data. Never throws on unknown message types. */
export async function buildTx(raw: RawTx): Promise<TxRecord> {
  const body = decodeTx(raw.tx);
  const hash = (raw.hash ?? (await sha256Hex(Buffer.from(raw.tx, "base64")))).toUpperCase();
  const r = raw.result;
  const events = parseEvents(r.events ?? []);
  enrich(events, body.messages);
  for (const ev of fromMessages(body.messages)) {
    // Message-derived facts that an event already covers are skipped.
    if (!events.some((e) => e.kind === ev.kind)) events.push(ev);
  }
  const signer = findSigner(r.events ?? [], body.messages, body.feePayer);
  const evmTx = events.find((e) => e.kind === "evm_tx");
  const failed = r.code !== 0 || !!(evmTx && evmTx.kind === "evm_tx" && evmTx.failed);
  let failReason: string | undefined;
  if (r.code !== 0) {
    try {
      failReason = decodeTxError({ code: r.code, codespace: r.codespace ?? "sdk", rawLog: r.log ?? "" }).message;
    } catch {
      failReason = r.log || `code ${r.code}`;
    }
  } else if (evmTx && evmTx.kind === "evm_tx" && evmTx.failed) {
    failReason = `EVM: ${evmTx.failed}`;
  }
  const classicalOnly = events.some((e) => e.kind === "classical_only");
  const hybridSigned =
    body.hybridSignature || (r.events ?? []).some((e) => e.type === "pqc_hybrid_verify" && e.attributes.some((a) => a.key === "status" && a.value === "verified"));
  const feeEvent = (r.events ?? []).find((e) => e.type === "tx" && e.attributes.some((a) => a.key === "fee"));
  const fee = feeEvent ? parseCoins(feeEvent.attributes.find((a) => a.key === "fee")!.value) : body.feeAmount.map((c) => ({ denom: c.denom, amount: BigInt(c.amount) }));

  const addrs = new Set<string>();
  if (signer) addrs.add(signer);
  for (const ev of events) for (const a of addressesOf(ev)) addrs.add(a);
  for (const a of messageAddresses(body.messages)) addrs.add(a);

  return {
    height: Number(raw.height),
    hash,
    time: raw.time,
    index: raw.index ?? 0,
    code: r.code,
    failed,
    ...(failReason ? { failReason } : {}),
    memo: body.memo,
    messages: body.messages,
    ...(signer ? { signer } : {}),
    hybridSigned,
    classicalOnly,
    fee,
    ...(body.feeGranter ? { feeGranter: body.feeGranter } : {}),
    ...(evmTx && evmTx.kind === "evm_tx" ? { evmHash: evmTx.hash } : {}),
    events,
    addresses: [...addrs],
  };
}

/** The signer: the fee payer, the account in the ante handler's acc_seq, or the EVM sender. */
function findSigner(events: AbciEvent[], messages: DecodedMsg[], feePayer?: string): string | undefined {
  for (const e of events) {
    if (e.type !== "tx") continue;
    const payer = e.attributes.find((a) => a.key === "fee_payer")?.value;
    if (payer && isQorAddress(payer)) return payer;
    const seq = e.attributes.find((a) => a.key === "acc_seq")?.value;
    if (seq) {
      const addr = seq.split("/")[0]!;
      if (isQorAddress(addr)) return addr;
    }
  }
  for (const e of events) {
    if (e.type === "message" && e.attributes.some((a) => a.key === "module" && a.value === "evm")) {
      const s = e.attributes.find((a) => a.key === "sender")?.value;
      if (s && isEvmAddress(s)) return evmToQor(s);
    }
  }
  if (feePayer && isQorAddress(feePayer)) return feePayer;
  const m = messages[0]?.value;
  for (const k of ["sender", "fromAddress", "delegatorAddress", "granter", "owner", "voter", "proposer", "depositor"]) {
    const v = m?.[k];
    if (typeof v === "string" && isQorAddress(v)) return v;
  }
  return undefined;
}

/** Addresses named in message bodies (covers failed transactions with no events). */
function messageAddresses(messages: DecodedMsg[]): string[] {
  const out: string[] = [];
  const keys = ["sender", "fromAddress", "toAddress", "granter", "grantee", "delegatorAddress", "owner", "accountAddress", "voter", "depositor", "receiver"];
  for (const m of messages) {
    for (const k of keys) {
      const v = m.value[k];
      if (typeof v === "string" && isQorAddress(v)) out.push(v);
    }
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(d).toString("hex");
}
