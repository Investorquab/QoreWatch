import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32 } from "@scure/base";
import { Http, HttpError } from "./http.js";

/** A handle that failed verification or a malformed answer. */
export class HandleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandleError";
  }
}

/**
 * QoreX @handles. Records come from QoreX's handle registry and carry two signatures:
 * the owner's secp256k1 signature over (handle, address), and the registry's Ed25519 signature over the
 * whole record. QoreWatch verifies both before it trusts an answer, so a compromised network cannot swap
 * the address behind a handle. Mirrors the verification in QoreX 0.4.3.
 */

/** QoreX handle registry (server-side reads; browsers are limited by its CORS policy). */
export const QOREX_HANDLE_REGISTRY = "https://cadkdpvbuztgqexpwoxkikmxya0vtcvd.lambda-url.us-east-1.on.aws";
/** The registry's Ed25519 public key, as pinned in QoreX 0.4.3. */
export const QOREX_HANDLE_REGISTRY_KEY = "91098dc532956f330a92be5b2d8e6e82db7af896fa9f453c3387f8e28ca28bc3";

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const RESERVED = ["qorechain", "qorex", "qcai", "qor", "admin", "support", "official", "wallet", "staking", "faucet", "bridge", "registry"];

export interface HandleRecord {
  handle: string;
  qorAddress: string;
  evmAddress?: string;
  svmAddress?: string;
  externalAddresses?: Record<string, string>;
  pqcRegistered?: boolean;
  createdAt: number;
  ownerPubkeyHex: string;
  sigOwnerHex: string;
  sigRegistryHex: string;
}

/** `@Maria ` → `maria`. */
export function normalizeHandle(input: string): string {
  return input.trim().toLowerCase().replace(/^@/, "");
}

/** True for something that looks like a handle (3–20 of a–z, 0–9, _), with or without @. */
export function isHandle(input: string): boolean {
  const h = normalizeHandle(input);
  return HANDLE_RE.test(h) && !RESERVED.includes(h) && !h.startsWith("qorechain");
}

const enc = new TextEncoder();
const fromHex = (hex: string): Uint8Array => {
  const s = hex.replace(/^0x/, "");
  if (s.length % 2 !== 0 || /[^0-9a-f]/i.test(s)) throw new Error("bad hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

function lengthPrefixed(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + 8 + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    let len = BigInt(p.length);
    for (let i = 7; i >= 0; i--) {
      out[o + i] = Number(len & 0xffn);
      len >>= 8n;
    }
    o += 8;
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function registryDigest(r: HandleRecord): Uint8Array {
  const external = Object.entries(r.externalAddresses ?? {})
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return sha256(
    lengthPrefixed([
      enc.encode("qorex-handle-registry-v1"),
      enc.encode(normalizeHandle(r.handle)),
      enc.encode(r.qorAddress),
      enc.encode(r.evmAddress ?? ""),
      enc.encode(r.svmAddress ?? ""),
      enc.encode(external),
      enc.encode(r.pqcRegistered ? "1" : "0"),
      enc.encode(String(r.createdAt)),
      enc.encode(r.ownerPubkeyHex),
      enc.encode(r.sigOwnerHex),
    ]),
  );
}

/** Throws INVALID_SIGNATURE unless both the owner's and the registry's signatures verify. */
export function verifyHandleRecord(record: HandleRecord, registryKeyHex = QOREX_HANDLE_REGISTRY_KEY): void {
  const fail = (why: string): never => {
    throw new HandleError(`@${record?.handle ?? "?"} failed verification: ${why}`);
  };
  try {
    if (!isHandle(record.handle)) fail("not a valid handle");
    const ownerKey = fromHex(record.ownerPubkeyHex);
    const derived = bech32.encode("qor", bech32.toWords(ripemd160(sha256(ownerKey))));
    if (derived !== record.qorAddress) fail("owner key does not match the address");
    const ownerMsg = sha256(enc.encode(`qorex:handle:v1:${normalizeHandle(record.handle)}:${record.qorAddress}`));
    if (!secp256k1.verify(fromHex(record.sigOwnerHex), ownerMsg, ownerKey, { prehash: false })) fail("owner signature invalid");
    if (!ed25519.verify(fromHex(record.sigRegistryHex), registryDigest(record), fromHex(registryKeyHex))) fail("registry signature invalid");
  } catch (error) {
    if (error instanceof HandleError) throw error;
    fail("malformed record");
  }
}

/** Resolve and verify @handles against the QoreX handle registry. */
export class Handles {
  private readonly cache = new Map<string, { at: number; record?: HandleRecord }>();

  constructor(
    private readonly http = new Http(),
    private readonly baseUrl = QOREX_HANDLE_REGISTRY,
    private readonly registryKeyHex = QOREX_HANDLE_REGISTRY_KEY,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  /** The verified record behind a handle, or undefined when it is unclaimed. */
  async resolve(handle: string): Promise<HandleRecord | undefined> {
    const h = normalizeHandle(handle);
    if (!isHandle(h)) throw new HandleError("Handles are 3 to 20 characters: a to z, 0 to 9 and underscore.");
    const hit = this.cache.get(`h:${h}`);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.record;
    let body: { record?: HandleRecord };
    try {
      body = await this.http.json<{ record?: HandleRecord }>(`${this.baseUrl}/resolve/${encodeURIComponent(h)}`);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) {
        this.cache.set(`h:${h}`, { at: Date.now() });
        return undefined;
      }
      throw e;
    }
    if (!body.record) return undefined;
    if (normalizeHandle(body.record.handle) !== h) throw new HandleError(`The registry answered for @${body.record.handle} when asked for @${h}`);
    verifyHandleRecord(body.record, this.registryKeyHex);
    this.cache.set(`h:${h}`, { at: Date.now(), record: body.record });
    return body.record;
  }

  /** The verified @handle of an address, or undefined (never throws). */
  async reverse(qorAddress: string): Promise<string | undefined> {
    const hit = this.cache.get(`a:${qorAddress}`);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.record?.handle;
    try {
      const body = await this.http.json<{ record?: HandleRecord }>(`${this.baseUrl}/reverse/${encodeURIComponent(qorAddress)}`);
      if (!body.record || body.record.qorAddress !== qorAddress) {
        this.cache.set(`a:${qorAddress}`, { at: Date.now() });
        return undefined;
      }
      verifyHandleRecord(body.record, this.registryKeyHex);
      this.cache.set(`a:${qorAddress}`, { at: Date.now(), record: body.record });
      return normalizeHandle(body.record.handle);
    } catch {
      return undefined;
    }
  }
}
