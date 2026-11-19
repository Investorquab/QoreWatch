import type { Pool, Tokens } from "@qorewatch/core";

export interface PoolPrice {
  id: string;
  name: string;
  /** Reserves too small for the price to mean anything (dust liquidity). */
  thin: boolean;
  /** Price of token A in token B (how many B for one A). */
  price: number;
  priceText: string;
}

/** Spot price of each active pool, using token decimals. */
export async function poolPrices(pools: Pool[], tokens: Tokens): Promise<PoolPrice[]> {
  const out: PoolPrice[] = [];
  for (const p of pools) {
    if (p.status !== "active" || p.reserveA === 0n || p.reserveB === 0n) continue;
    const [a, b] = await Promise.all([tokens.get(p.tokenA), tokens.get(p.tokenB)]);
    const ra = Number(p.reserveA) / 10 ** a.decimals;
    const rb = Number(p.reserveB) / 10 ** b.decimals;
    const price = rb / ra;
    if (!Number.isFinite(price) || price <= 0) continue;
    const thin = ra < 0.01 || rb < 0.01;
    out.push({ id: p.id, name: `${a.symbol} / ${b.symbol}`, price, thin, priceText: thin ? "too little liquidity for a price" : `1 ${a.symbol} = ${fmtPrice(price)} ${b.symbol}` });
  }
  return out.sort((x, y) => Number(x.id) - Number(y.id));
}

export function fmtPrice(n: number): string {
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return n.toPrecision(4);
}

/** Percentage change from a base price. */
export const change = (base: number, now: number) => ((now - base) / base) * 100;
