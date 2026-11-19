import { createPublicClient, http, parseAbi, type PublicClient } from "viem";
import { erc20FromDenom, formatUnits, UQOR_DECIMALS } from "./amount.js";

export interface TokenInfo {
  /** Bank denom (uqor or erc20:0x…) or 0x token address. */
  id: string;
  symbol: string;
  decimals: number;
  /** EVM contract for ERC-20 tokens. */
  address?: string;
}

const ERC20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function name() view returns (string)"]);

/**
 * Token names and decimals. QOR is built in; ERC-20 tokens (fUSD, fBTC, …) are read
 * once from the EVM and cached. Never throws: unknown tokens fall back to a short id.
 */
export class Tokens {
  private readonly cache = new Map<string, TokenInfo>();
  private readonly pending = new Map<string, Promise<TokenInfo>>();

  constructor(private readonly client?: PublicClient) {
    this.cache.set("uqor", { id: "uqor", symbol: "QOR", decimals: UQOR_DECIMALS });
  }

  static fromRpc(evmRpc: string): Tokens {
    return new Tokens(createPublicClient({ transport: http(evmRpc, { timeout: 15_000, retryCount: 2 }) }) as PublicClient);
  }

  /** Seed known tokens (tests, or a static list). */
  set(info: TokenInfo): void {
    this.cache.set(info.id.toLowerCase(), info);
    if (info.address) this.cache.set(info.address.toLowerCase(), info);
  }

  /** Look up by bank denom ("uqor", "erc20:0x…") or by 0x address. */
  async get(denomOrAddress: string): Promise<TokenInfo> {
    const key = denomOrAddress.toLowerCase();
    const hit = this.cache.get(key);
    if (hit) return hit;
    const addr = erc20FromDenom(denomOrAddress) ?? (/^0x[0-9a-f]{40}$/.test(key) ? key : undefined);
    if (!addr) return { id: denomOrAddress, symbol: denomOrAddress.length > 16 ? `${denomOrAddress.slice(0, 12)}…` : denomOrAddress, decimals: 0 };
    let p = this.pending.get(addr);
    if (!p) {
      p = this.read(addr, denomOrAddress);
      this.pending.set(addr, p);
    }
    const info = await p;
    this.pending.delete(addr);
    return info;
  }

  private async read(addr: string, id: string): Promise<TokenInfo> {
    const fallback: TokenInfo = { id, symbol: `${addr.slice(0, 6)}…${addr.slice(-4)}`, decimals: 18, address: addr };
    if (!this.client) return fallback;
    try {
      const [symbol, decimals] = await Promise.all([
        this.client.readContract({ address: addr as `0x${string}`, abi: ERC20, functionName: "symbol" }),
        this.client.readContract({ address: addr as `0x${string}`, abi: ERC20, functionName: "decimals" }),
      ]);
      const info: TokenInfo = { id, symbol: String(symbol).slice(0, 16) || fallback.symbol, decimals: Number(decimals), address: addr };
      this.cache.set(addr, info);
      this.cache.set(`erc20:${addr}`, info);
      return info;
    } catch {
      return fallback;
    }
  }

  /** "12.5 fUSD" */
  async format(amount: bigint, denomOrAddress: string): Promise<string> {
    const t = await this.get(denomOrAddress);
    return `${formatUnits(amount, t.decimals)} ${t.symbol}`;
  }
}
