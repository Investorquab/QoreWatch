import { bech32 } from "@scure/base";

const HRP = "qor";

/** True for a well-formed qor1 account address (20-byte) or contract address (32-byte). */
export function isQorAddress(s: string): boolean {
  try {
    const d = bech32.decode(s as `${string}1${string}`, 90);
    if (d.prefix !== HRP) return false;
    const len = bech32.fromWords(d.words).length;
    return len === 20 || len === 32;
  } catch {
    return false;
  }
}

/** True for a 0x EVM address (any case). */
export function isEvmAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

/** 0x… → qor1… (same 20 bytes). */
export function evmToQor(evm: string): string {
  if (!isEvmAddress(evm)) throw new Error(`Not an EVM address: ${evm}`);
  return bech32.encode(HRP, bech32.toWords(Buffer.from(evm.slice(2), "hex")));
}

/** qor1… → 0x… (lower case). Only for 20-byte account addresses. */
export function qorToEvm(qor: string): string {
  const d = bech32.decode(qor as `${string}1${string}`, 90);
  const bytes = bech32.fromWords(d.words);
  if (d.prefix !== HRP || bytes.length !== 20) throw new Error(`Not a qor1 account address: ${qor}`);
  return "0x" + Buffer.from(bytes).toString("hex");
}

/** A validator operator address (qorvaloper1…). */
export function isValoper(s: string): boolean {
  try {
    return bech32.decode(s as `${string}1${string}`, 90).prefix === "qorvaloper";
  } catch {
    return false;
  }
}

/**
 * Normalise any address form to the canonical qor1 address. Returns undefined when
 * the input is not an address. Accepts 0x addresses, qor1 addresses, surrounding spaces.
 */
export function toQor(input: string): string | undefined {
  const s = input.trim();
  if (isEvmAddress(s)) return evmToQor(s);
  const lower = s.toLowerCase();
  if (isQorAddress(lower)) return lower;
  return undefined;
}

/** "qor1x46s…5yq7" */
export function shortAddress(addr: string, head = 8, tail = 4): string {
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/** What a piece of user text is: an address, a transaction hash, a handle, or nothing. */
export type Lookup =
  | { kind: "address"; qor: string; evm?: string; input: string }
  | { kind: "tx"; hash: string; evm: boolean; input: string }
  | { kind: "handle"; handle: string; input: string }
  | { kind: "unknown"; input: string };

/** Classify a user's input for /check, /tx and "is this safe?". */
export function classify(input: string): Lookup {
  const s = input.trim();
  if (isEvmAddress(s)) return { kind: "address", qor: evmToQor(s), evm: s.toLowerCase(), input: s };
  const q = toQor(s);
  if (q) return { kind: "address", qor: q, ...(isAccount(q) ? { evm: qorToEvm(q) } : {}), input: s };
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return { kind: "tx", hash: s.toLowerCase(), evm: true, input: s };
  if (/^[0-9a-fA-F]{64}$/.test(s)) return { kind: "tx", hash: s.toUpperCase(), evm: false, input: s };
  const h = s.replace(/^@/, "").toLowerCase();
  if (/^[a-z0-9][a-z0-9_-]{1,31}$/.test(h) && s.startsWith("@")) return { kind: "handle", handle: h, input: s };
  return { kind: "unknown", input: s };
}

/** True for a 20-byte account address (as opposed to a 32-byte contract address). */
export function isAccount(qor: string): boolean {
  try {
    return bech32.fromWords(bech32.decode(qor as `${string}1${string}`, 90).words).length === 20;
  } catch {
    return false;
  }
}

/** Find every qor1/0x address and tx hash in free text (for forwarded messages). */
export function findLookups(text: string): Lookup[] {
  const out: Lookup[] = [];
  const seen = new Set<string>();
  const re = /(qor1[02-9ac-hj-np-z]{38,58}|0x[0-9a-fA-F]{64}|0x[0-9a-fA-F]{40}|\b[0-9A-Fa-f]{64}\b|@[a-z0-9][a-z0-9_-]{1,31})/g;
  for (const m of text.matchAll(re)) {
    const l = classify(m[0]);
    if (l.kind === "unknown") continue;
    const key = l.kind === "address" ? l.qor : l.kind === "tx" ? l.hash : l.handle;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}
