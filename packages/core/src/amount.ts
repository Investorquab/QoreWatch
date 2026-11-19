/** Native QOR has 6 decimals on the native lane (uqor); the EVM lane uses 18 (wei). */
export const UQOR_DECIMALS = 6;
export const WEI_DECIMALS = 18;

/** Format a base-unit integer with `decimals`, trimming trailing zeros: 1500000, 6 → "1.5". */
export function formatUnits(value: bigint | string, decimals: number, maxFraction = 6): string {
  let v = typeof value === "bigint" ? value : BigInt(value);
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  if (!frac && v % base !== 0n && whole === 0n) frac = ""; // below display precision
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const s = frac ? `${w}.${frac}` : w;
  if (s === "0" && v !== 0n) return `${neg ? "-" : ""}<0.${"0".repeat(Math.max(0, maxFraction - 1))}1`;
  return (neg ? "-" : "") + s;
}

/** Parse a decimal string like "12.5" into base units. Throws on malformed input. */
export function parseUnits(text: string, decimals: number): bigint {
  const s = text.trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Not a number: ${text}`);
  const [w, f = ""] = s.split(".");
  if (f.length > decimals) throw new Error(`Too many decimals (max ${decimals})`);
  return BigInt(w!) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** One coin as it appears in events: "123uqor" or "11000000erc20:0x97…". */
export interface Coin {
  amount: bigint;
  denom: string;
}

/** Parse "12uqor,5erc20:0xabc" into coins. Unknown text is skipped, never thrown. */
export function parseCoins(s: string | undefined): Coin[] {
  if (!s) return [];
  const out: Coin[] = [];
  for (const part of s.split(",")) {
    const m = /^(\d+)(.+)$/.exec(part.trim());
    if (m) out.push({ amount: BigInt(m[1]!), denom: m[2]! });
  }
  return out;
}

/** The EVM token address inside an "erc20:0x…" bank denom, if it is one. */
export function erc20FromDenom(denom: string): string | undefined {
  const m = /^erc20:(0x[0-9a-fA-F]{40})$/.exec(denom);
  return m ? m[1]!.toLowerCase() : undefined;
}
