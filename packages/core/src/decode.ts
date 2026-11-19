import { qorechainRegistry } from "@qorechain/sdk";
import { TxRaw, TxBody, AuthInfo } from "cosmjs-types/cosmos/tx/v1beta1/tx.js";
import { MsgExecuteContract, MsgInstantiateContract, MsgMigrateContract } from "cosmjs-types/cosmwasm/wasm/v1/tx.js";
import { GenericAuthorization } from "cosmjs-types/cosmos/authz/v1beta1/authz.js";
import { SendAuthorization } from "cosmjs-types/cosmos/bank/v1beta1/authz.js";
import { StakeAuthorization } from "cosmjs-types/cosmos/staking/v1beta1/authz.js";
import { BasicAllowance, PeriodicAllowance, AllowedMsgAllowance } from "cosmjs-types/cosmos/feegrant/v1beta1/feegrant.js";

/** One message from a transaction body. `value` is plain JSON-safe data. */
export interface DecodedMsg {
  typeUrl: string;
  /** Plain data (bigints as strings, bytes as hex). Empty object when not decodable. */
  value: Record<string, unknown>;
  decoded: boolean;
}

export interface DecodedBody {
  messages: DecodedMsg[];
  memo: string;
  /** True when the transaction carries QoreChain's hybrid post-quantum signature extension. */
  hybridSignature: boolean;
  /** True for a transaction wrapping an EVM transaction. */
  ethereum: boolean;
  feeAmount: { denom: string; amount: string }[];
  feeGranter?: string;
  feePayer?: string;
}

type AnyMsg = { typeUrl: string; value: Uint8Array };
type Codec = { decode(b: Uint8Array): unknown };

const EXTRA: Record<string, Codec> = {
  "/cosmwasm.wasm.v1.MsgExecuteContract": MsgExecuteContract,
  "/cosmwasm.wasm.v1.MsgInstantiateContract": MsgInstantiateContract,
  "/cosmwasm.wasm.v1.MsgMigrateContract": MsgMigrateContract,
};

/** Nested Any types we unpack for display (authz authorizations, fee allowances). */
const NESTED: Record<string, Codec> = {
  "/cosmos.authz.v1beta1.GenericAuthorization": GenericAuthorization,
  "/cosmos.bank.v1beta1.SendAuthorization": SendAuthorization,
  "/cosmos.staking.v1beta1.StakeAuthorization": StakeAuthorization,
  "/cosmos.feegrant.v1beta1.BasicAllowance": BasicAllowance,
  "/cosmos.feegrant.v1beta1.PeriodicAllowance": PeriodicAllowance,
  "/cosmos.feegrant.v1beta1.AllowedMsgAllowance": AllowedMsgAllowance,
};

let registry: ReturnType<typeof qorechainRegistry> | undefined;
const reg = () => (registry ??= qorechainRegistry());

/** Decode one Any message. Never throws: unknown types come back with decoded=false. */
export function decodeAny(m: AnyMsg): DecodedMsg {
  try {
    const extra = EXTRA[m.typeUrl];
    const v = extra ? extra.decode(m.value) : reg().decode(m);
    return { typeUrl: m.typeUrl, value: toPlain(v) as Record<string, unknown>, decoded: true };
  } catch {
    return { typeUrl: m.typeUrl, value: {}, decoded: false };
  }
}

/** Decode a base64 transaction (as served by CometBFT /block and /tx_search). */
export function decodeTx(base64: string): DecodedBody {
  const raw = TxRaw.decode(Buffer.from(base64, "base64"));
  const body = TxBody.decode(raw.bodyBytes);
  let auth: AuthInfo | undefined;
  try {
    auth = AuthInfo.decode(raw.authInfoBytes);
  } catch {
    auth = undefined;
  }
  const exts = [...body.extensionOptions, ...body.nonCriticalExtensionOptions].map((e) => e.typeUrl);
  return {
    messages: body.messages.map((m) => decodeAny({ typeUrl: m.typeUrl, value: m.value })),
    memo: body.memo,
    hybridSignature: exts.includes("/qorechain.pqc.v1.PQCHybridSignature"),
    ethereum: exts.includes("/cosmos.evm.vm.v1.ExtensionOptionsEthereumTx"),
    feeAmount: (auth?.fee?.amount ?? []).map((c) => ({ denom: c.denom, amount: c.amount })),
    ...(auth?.fee?.granter ? { feeGranter: auth.fee.granter } : {}),
    ...(auth?.fee?.payer ? { feePayer: auth.fee.payer } : {}),
  };
}

/** Convert protobuf-decoded objects to plain JSON-safe data, unpacking known nested Anys. */
export function toPlain(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(toPlain);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.typeUrl === "string" && o.value instanceof Uint8Array) {
      const codec = NESTED[o.typeUrl];
      if (codec) {
        try {
          return { "@type": o.typeUrl, ...(toPlain(codec.decode(o.value)) as object) };
        } catch {
          /* fall through */
        }
      }
      return { "@type": o.typeUrl };
    }
    // protobuf Timestamp { seconds, nanos }
    if ("seconds" in o && "nanos" in o && Object.keys(o).length === 2) {
      const s = Number(o.seconds as bigint | number);
      return new Date(s * 1000).toISOString();
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) out[k] = toPlain(val);
    return out;
  }
  return v;
}
