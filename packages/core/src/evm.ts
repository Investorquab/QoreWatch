import { createPublicClient, decodeFunctionData, http, parseAbi, parseAbiItem, type PublicClient } from "viem";
import { precompiles } from "@qorechain/evm";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const APPROVAL = parseAbiItem("event Approval(address indexed owner, address indexed spender, uint256 value)");
const APPROVAL_FOR_ALL = parseAbiItem("event ApprovalForAll(address indexed owner, address indexed operator, bool approved)");
const ERC20_CALLS = parseAbi([
  "function transfer(address to, uint256 amount)",
  "function approve(address spender, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function increaseAllowance(address spender, uint256 addedValue)",
  "function setApprovalForAll(address operator, bool approved)",
]);
const BALANCE = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address owner, address spender) view returns (uint256)"]);

/** 2^256 - 1 and anything at or above 2^255 is treated as "unlimited". */
export const UNLIMITED = 2n ** 255n;

/** A token movement or permission seen in EVM logs. */
export type TokenLog =
  | { kind: "token_transfer"; token: string; from: string; to: string; value: bigint; txHash: string; block: number; logIndex: number }
  | { kind: "token_approval"; token: string; owner: string; spender: string; value: bigint; unlimited: boolean; txHash: string; block: number; logIndex: number }
  | { kind: "nft_approval_all"; token: string; owner: string; operator: string; approved: boolean; txHash: string; block: number; logIndex: number };

/** What an EVM call does, when it is one of the common token calls. */
export type DecodedCall =
  | { fn: "transfer"; to: string; amount: bigint }
  | { fn: "approve"; spender: string; amount: bigint; unlimited: boolean }
  | { fn: "transferFrom"; from: string; to: string; amount: bigint }
  | { fn: "increaseAllowance"; spender: string; amount: bigint }
  | { fn: "setApprovalForAll"; operator: string; approved: boolean };

export interface EvmTxInfo {
  hash: string;
  from: string;
  to?: string;
  valueWei: bigint;
  input: string;
  call?: DecodedCall;
  block?: number;
  status?: "success" | "reverted";
}

/** EVM-lane reads: token logs, transactions, contract checks, QoreChain's AI precompiles. */
export class Evm {
  readonly client: PublicClient;

  constructor(urlOrClient: string | PublicClient) {
    this.client = typeof urlOrClient === "string" ? (createPublicClient({ transport: http(urlOrClient, { timeout: 20_000, retryCount: 3 }) }) as PublicClient) : urlOrClient;
  }

  async blockNumber(): Promise<number> {
    return Number(await this.client.getBlockNumber());
  }

  /** ERC-20 Transfer/Approval and ERC-721/1155 ApprovalForAll logs in [from, to] (inclusive). */
  async tokenLogs(from: number, to: number): Promise<TokenLog[]> {
    const [transfers, approvals, all] = await Promise.all([
      this.client.getLogs({ event: TRANSFER, fromBlock: BigInt(from), toBlock: BigInt(to) }),
      this.client.getLogs({ event: APPROVAL, fromBlock: BigInt(from), toBlock: BigInt(to) }),
      this.client.getLogs({ event: APPROVAL_FOR_ALL, fromBlock: BigInt(from), toBlock: BigInt(to) }),
    ]);
    const out: TokenLog[] = [];
    for (const l of transfers) {
      // ERC-721 Transfer has the token id indexed (4 topics); keep ERC-20 only.
      if (l.topics.length !== 3 || l.args.value === undefined) continue;
      out.push({ kind: "token_transfer", token: l.address.toLowerCase(), from: l.args.from!.toLowerCase(), to: l.args.to!.toLowerCase(), value: l.args.value, txHash: l.transactionHash!, block: Number(l.blockNumber), logIndex: l.logIndex! });
    }
    for (const l of approvals) {
      if (l.topics.length !== 3 || l.args.value === undefined) continue;
      out.push({ kind: "token_approval", token: l.address.toLowerCase(), owner: l.args.owner!.toLowerCase(), spender: l.args.spender!.toLowerCase(), value: l.args.value, unlimited: l.args.value >= UNLIMITED, txHash: l.transactionHash!, block: Number(l.blockNumber), logIndex: l.logIndex! });
    }
    for (const l of all) {
      out.push({ kind: "nft_approval_all", token: l.address.toLowerCase(), owner: l.args.owner!.toLowerCase(), operator: l.args.operator!.toLowerCase(), approved: !!l.args.approved, txHash: l.transactionHash!, block: Number(l.blockNumber), logIndex: l.logIndex! });
    }
    return out.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  }

  async transaction(hash: string): Promise<EvmTxInfo | undefined> {
    try {
      const t = await this.client.getTransaction({ hash: hash as `0x${string}` });
      const r = await this.client.getTransactionReceipt({ hash: hash as `0x${string}` }).catch(() => undefined);
      const call = decodeCall(t.input);
      return {
        hash: t.hash,
        from: t.from.toLowerCase(),
        ...(t.to ? { to: t.to.toLowerCase() } : {}),
        valueWei: t.value,
        input: t.input,
        ...(call ? { call } : {}),
        ...(t.blockNumber !== null ? { block: Number(t.blockNumber) } : {}),
        ...(r ? { status: r.status } : {}),
      };
    } catch {
      return undefined;
    }
  }

  async isContract(address: string): Promise<boolean> {
    const code = await this.client.getCode({ address: address as `0x${string}` });
    return !!code && code !== "0x";
  }

  async tokenBalance(token: string, owner: string): Promise<bigint> {
    return this.client.readContract({ address: token as `0x${string}`, abi: BALANCE, functionName: "balanceOf", args: [owner as `0x${string}`] });
  }

  async allowance(token: string, owner: string, spender: string): Promise<bigint> {
    return this.client.readContract({ address: token as `0x${string}`, abi: BALANCE, functionName: "allowance", args: [owner as `0x${string}`, spender as `0x${string}`] });
  }

  /** QoreChain's on-chain AI risk score for calldata (precompile 0x…0B01). Undefined if the node does not serve it. */
  async riskScore(input: string): Promise<{ score: number; level: number } | undefined> {
    try {
      const r = await precompiles.aiRiskScore(this.client, input as `0x${string}`);
      return { score: Number(r.score), level: Number(r.level) };
    } catch {
      return undefined;
    }
  }

  /** QoreChain's on-chain anomaly check for a sender and amount (precompile 0x…0B02). */
  async anomaly(sender: string, amountWei: bigint): Promise<{ score: number; flagged: boolean } | undefined> {
    try {
      const r = await precompiles.aiAnomalyCheck(this.client, { sender: sender as `0x${string}`, amount: amountWei });
      return { score: Number(r.anomalyScore), flagged: r.flagged };
    } catch {
      return undefined;
    }
  }
}

/** Decode the common token calls from calldata. */
export function decodeCall(input: string): DecodedCall | undefined {
  if (!input || input.length < 10) return undefined;
  try {
    const d = decodeFunctionData({ abi: ERC20_CALLS, data: input as `0x${string}` });
    const a = d.args as readonly unknown[];
    switch (d.functionName) {
      case "transfer":
        return { fn: "transfer", to: String(a[0]).toLowerCase(), amount: a[1] as bigint };
      case "approve":
        return { fn: "approve", spender: String(a[0]).toLowerCase(), amount: a[1] as bigint, unlimited: (a[1] as bigint) >= UNLIMITED };
      case "transferFrom":
        return { fn: "transferFrom", from: String(a[0]).toLowerCase(), to: String(a[1]).toLowerCase(), amount: a[2] as bigint };
      case "increaseAllowance":
        return { fn: "increaseAllowance", spender: String(a[0]).toLowerCase(), amount: a[1] as bigint };
      case "setApprovalForAll":
        return { fn: "setApprovalForAll", operator: String(a[0]).toLowerCase(), approved: !!a[1] };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
