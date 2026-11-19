/**
 * QoreX from a web page. Verified against QoreX 0.4.3:
 * - `native.getKey()` reports algo "ethsecp256k1" for an Ethereum account (coin 60), "secp256k1" for a main account (coin 118).
 * - `native.signAndBroadcast({ chainId, messages: [{ typeUrl, value: bytes }], memo, gasLimit })` signs with the
 *   hybrid secp256k1 + ML-DSA-87 key. It refuses message types it "manages itself" (key rotation, EVM windows,
 *   session keys, EVM delegation) and anything it cannot display.
 * - `evm.request({ method: "eth_sendTransaction" })` works for Ethereum accounts: QoreX opens an ML-DSA-87 window first.
 * - It injects into the top page only and emits no account-change events.
 */
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx.js";
import { MsgRevoke } from "cosmjs-types/cosmos/authz/v1beta1/tx.js";
import { MsgRevokeAllowance } from "cosmjs-types/cosmos/feegrant/v1beta1/tx.js";
import { encodeFunctionData, parseAbi, type Hex } from "viem";

export const CHAIN_ID = "qorechain-diana";
export const EVM_CHAIN_HEX = "0x2648";
export const QOREX_INSTALL_URL = "https://chromewebstore.google.com/detail/qorex/cflpnggbnnifibblifgbeobogdpfjpcg";
export const FAUCET_URL = "https://dashboard.qorechain.io/faucet";

interface QorexKey {
  algo: string;
  bech32Address: string;
}
interface Qorex {
  native: {
    capabilities: readonly string[];
    enable(chainId: string): Promise<unknown>;
    getKey(chainId: string): Promise<QorexKey>;
    signAndBroadcast(req: { chainId: string; messages: { typeUrl: string; value: Uint8Array }[]; memo?: string; gasLimit?: string }): Promise<unknown>;
  };
  evm: { request(args: { method: string; params?: readonly unknown[] }): Promise<unknown> };
}
declare global {
  interface Window {
    qorex?: Qorex;
  }
}

export class WalletError extends Error {
  constructor(
    readonly code: "NOT_INSTALLED" | "REJECTED" | "WRONG_NETWORK" | "UNSUPPORTED" | "MAIN_ACCOUNT" | "FAILED",
    message: string,
  ) {
    super(message);
  }
}

export interface Account {
  qor: string;
  evm: string;
  kind: "ethereum" | "main";
}

const asError = (e: unknown): WalletError => {
  if (e instanceof WalletError) return e;
  const m = String((e as { message?: unknown })?.message ?? e).replace(/^QoreX:\s*/, "");
  if (/reject|denied|cancel/i.test(m)) return new WalletError("REJECTED", "You cancelled the request in QoreX.");
  if (/does not match the active network|unsupported chain/i.test(m)) return new WalletError("WRONG_NETWORK", "QoreX is on mainnet. Switch it to testnet (diana) and try again.");
  return new WalletError("FAILED", m);
};

export async function wallet(timeoutMs = 2000): Promise<Qorex> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (window.qorex?.native && window.qorex.evm) return window.qorex;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new WalletError("NOT_INSTALLED", "QoreX is not installed in this browser.");
}

/** Ask QoreX to connect this site and return the active account. */
export async function connect(): Promise<Account> {
  const q = await wallet();
  try {
    const chain = (await q.evm.request({ method: "eth_chainId" })) as string;
    if (chain !== EVM_CHAIN_HEX) throw new WalletError("WRONG_NETWORK", "QoreX is on mainnet. QoreWatch runs on QoreChain testnet: switch QoreX to testnet (diana).");
    await q.native.enable(CHAIN_ID);
    const accounts = (await q.evm.request({ method: "eth_requestAccounts" })) as string[];
    const key = await q.native.getKey(CHAIN_ID);
    return { qor: key.bech32Address, evm: (accounts[0] ?? "").toLowerCase(), kind: key.algo === "ethsecp256k1" ? "ethereum" : "main" };
  } catch (e) {
    throw asError(e);
  }
}

/** The transaction hash from whatever shape QoreX returns. */
export function txHashOf(r: unknown): string {
  if (typeof r === "string") return r;
  const o = (r ?? {}) as Record<string, unknown>;
  const code = Number(o.code ?? 0);
  if (code !== 0) throw new WalletError("FAILED", String(o.rawLog ?? o.log ?? `The chain refused the transaction (code ${code}).`));
  return String(o.transactionHash ?? o.txhash ?? o.hash ?? "");
}

async function broadcast(messages: { typeUrl: string; value: Uint8Array }[], memo: string, gasLimit: number): Promise<string> {
  const q = await wallet();
  try {
    return txHashOf(await q.native.signAndBroadcast({ chainId: CHAIN_ID, messages, memo, gasLimit: String(gasLimit) }));
  } catch (e) {
    throw asError(e);
  }
}

/** 1 uqor to yourself with a memo: the cheapest hybrid-signed transaction (linking, key registration). */
export function selfSend(account: Account, memo: string): Promise<string> {
  const value = MsgSend.encode(MsgSend.fromPartial({ fromAddress: account.qor, toAddress: account.qor, amount: [{ denom: "uqor", amount: "1" }] })).finish();
  return broadcast([{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value }], memo, 400_000);
}

export function revokeAuthz(account: Account, grantee: string, msgTypeUrl: string): Promise<string> {
  const value = MsgRevoke.encode(MsgRevoke.fromPartial({ granter: account.qor, grantee, msgTypeUrl })).finish();
  return broadcast([{ typeUrl: "/cosmos.authz.v1beta1.MsgRevoke", value }], "QoreWatch: revoke a permission", 400_000);
}

export function revokeFeegrant(account: Account, grantee: string): Promise<string> {
  const value = MsgRevokeAllowance.encode(MsgRevokeAllowance.fromPartial({ granter: account.qor, grantee })).finish();
  return broadcast([{ typeUrl: "/cosmos.feegrant.v1beta1.MsgRevokeAllowance", value }], "QoreWatch: stop paying fees", 400_000);
}

/** An EVM call from the active Ethereum account. QoreX opens its ML-DSA-87 window first. */
export async function evmCall(account: Account, to: string, data: Hex): Promise<string> {
  if (account.kind !== "ethereum") throw new WalletError("MAIN_ACCOUNT", "This needs an Ethereum account (coin 60) in QoreX. Main accounts cannot use QoreChain's EVM lane.");
  const q = await wallet();
  try {
    return (await q.evm.request({ method: "eth_sendTransaction", params: [{ from: account.evm, to, data, value: "0x0" }] })) as string;
  } catch (e) {
    throw asError(e);
  }
}

export const ERC20 = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
export const ATTEST = parseAbi(["function attest(uint16 score, bytes32 reportHash, bytes8 code)"]);

export const approveZero = (spender: string): Hex => encodeFunctionData({ abi: ERC20, functionName: "approve", args: [spender as Hex, 0n] });
export const attestData = (score: number, reportHash: Hex, code: Hex): Hex => encodeFunctionData({ abi: ATTEST, functionName: "attest", args: [score, reportHash, code] });

/** Human help for each wallet error. */
export function walletHelp(e: unknown): string {
  const w = e instanceof WalletError ? e : asError(e);
  switch (w.code) {
    case "NOT_INSTALLED":
      return `QoreX is not installed in this browser. <a href="${QOREX_INSTALL_URL}" rel="noopener">Install QoreX</a>, set it to testnet, then reload this page.`;
    case "REJECTED":
      return "You cancelled in QoreX. Nothing was sent.";
    case "WRONG_NETWORK":
      return "QoreX is on mainnet. In QoreX, tap the version number seven times for developer mode, choose <b>Switch to testnet (diana)</b>, then try again.";
    case "MAIN_ACCOUNT":
      return "This step needs an <b>Ethereum account (coin 60)</b> in QoreX. In QoreX, open Your accounts, add or pick an Ethereum account, then try again.";
    default:
      return /insufficient|balance/i.test(w.message) ? `Not enough test QOR for the fee. <a href="${FAUCET_URL}" rel="noopener">Get test QOR from the faucet</a>, then try again.` : `QoreX said: ${w.message.replace(/[<>&]/g, "")}`;
  }
}
