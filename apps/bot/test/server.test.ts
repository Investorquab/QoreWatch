import { describe, expect, it } from "vitest";
import { Store } from "../src/db/store.js";
import { createServer } from "../src/server/http.js";
import { attestHook, canonicalReport, codeBytes, codeFromBytes, reportHash } from "../src/attest.js";
import { silentLogger } from "../src/log.js";
import type { Config } from "../src/config.js";
import { FakeMessenger } from "./fakes.js";
import { CAROL, fakeChain, ME, txFixture } from "./fake-chain.js";

const config: Config = { telegramToken: "x", botUsername: "qorewatchbot", publicUrl: "https://qw.test", network: "testnet", dataDir: ":memory:", httpHost: "127.0.0.1", httpPort: 0, adminChatIds: [], maxCatchupBlocks: 10, pollMs: 10, logLevel: "error", attestContract: "0x00000000000000000000000000000000000a77e5" };

function setup(status = { height: 10_386_499, chainHeight: 10_386_500, lagBlocks: 1 }) {
  const store = new Store(":memory:");
  const fc = fakeChain();
  const app = createServer({ config, store, chain: fc.chain, log: silentLogger, status: () => status });
  return { store, fc, app };
}

describe("HTTP API", () => {
  it("reports health from the watcher's lag", async () => {
    expect((await setup().app.request("/healthz")).status).toBe(200);
    const behind = setup({ height: 1, chainHeight: 1000, lagBlocks: 999 });
    expect((await behind.app.request("/healthz")).status).toBe(503);
  });

  it("sets security headers", async () => {
    const r = await setup().app.request("/healthz");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("tracks a link code from pending to linked, and rejects bad codes", async () => {
    const { store, app } = setup();
    store.ensureChat(1, "private");
    const code = store.createCode(1, "link");
    expect(await (await app.request(`/api/link/${code}`)).json()).toMatchObject({ status: "pending", memo: `QoreWatch link ${code}` });
    store.claimCode(code, ME);
    store.consumeCode(code, "link", ME);
    expect(await (await app.request(`/api/link/${code}`)).json()).toEqual({ status: "linked", address: ME });
    expect((await app.request("/api/link/NOPE")).status).toBe(400);
    expect((await app.request("/api/link/ABCDEFGH")).status).toBe(404);
  });

  it("lets the link page claim a code for the connected address, once", async () => {
    const { store, app } = setup();
    store.ensureChat(1, "private");
    const code = store.createCode(1, "link");
    const post = (c: string, body: unknown) => app.request(`/api/link/${c}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post(code, { address: "not-an-address" })).status).toBe(400);
    expect((await post(code, {})).status).toBe(400);
    expect((await post("NOPE", { address: ME })).status).toBe(400);
    expect((await post("ABCDEFGH", { address: ME })).status).toBe(410);
    const ok = await post(code, { address: ME.toUpperCase() });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: "claimed", address: ME });
    expect((await post(code, { address: ME })).status).toBe(200);
    expect((await post(code, { address: "qor1sx6dpevcmw8464tr76dsehsdvj7euy4rknm23c" })).status).toBe(409);
    expect(store.codeInfo(code)?.claimedBy).toBe(ME);
  });

  it("serves the window, account, grants and check of an address, and refuses non-addresses", async () => {
    const { app, fc } = setup();
    fc.state.window[ME] = { found: true, live: true, remaining_txs: "2", remaining_value: "1000", allowed_targets: [] };
    expect(await (await app.request(`/api/window/${ME}`)).json()).toMatchObject({ live: true, remainingTxs: 2, remainingValueUqor: "1000", height: 10_386_500 });
    expect(await (await app.request(`/api/account/${CAROL}`)).json()).toMatchObject({ pqc: { found: false }, auth: { exists: true, classicalKeyExposed: true } });
    expect(await (await app.request(`/api/grants/${ME}`)).json()).toMatchObject({ grants: [], feeAllowances: [] });
    const check = (await (await app.request(`/api/check/${ME}`)).json()) as { status: string; score: number; findings: { title: string }[] };
    expect(check.status).toBe("attention");
    expect(check.findings[0]!.title).not.toMatch(/</);
    expect((await app.request("/api/window/notanaddress")).status).toBe(400);
  });

  it("explains a transaction as plain JSON", async () => {
    const { app } = setup();
    const [grant] = txFixture("authz_grant");
    const t = (await (await app.request(`/api/tx/${grant!.hash}`)).json()) as { title: string; flags: string[]; hybridSigned: boolean };
    expect(t.title).toBe("A permission grant (authz)");
    expect(t.hybridSigned).toBe(true);
    expect(t.flags[0]).toMatch(/permission to act/);
    expect((await app.request(`/api/tx/${"B".repeat(64)}`)).status).toBe(404);
  });

  it("rate-limits each client", async () => {
    const { app } = setup();
    let last = 0;
    for (let i = 0; i < 130; i++) last = (await app.request("/api/config", { headers: { "x-forwarded-for": "9.9.9.9" } })).status;
    expect(last).toBe(429);
    expect((await app.request("/api/config", { headers: { "x-forwarded-for": "8.8.8.8" } })).status).toBe(200);
  });

  it("issues an attest report only for an account the chat linked", async () => {
    const { store, app } = setup();
    store.ensureChat(1, "private");
    store.addWatch(1, ME, { owned: true });
    store.addWatch(1, CAROL);
    const code = store.createCode(1, "attest");
    expect((await app.request(`/api/attest/${code}/report?account=${CAROL}`)).status).toBe(400);
    const r = (await (await app.request(`/api/attest/${code}/report?account=${ME}`)).json()) as { score: number; reportHash: string; code: string; contract: string };
    expect(r.reportHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(codeFromBytes(r.code as `0x${string}`)).toBe(code);
    expect(r.contract).toBe(config.attestContract);
    expect(await (await app.request(`/api/attest/${code}`)).json()).toMatchObject({ status: "pending", accounts: [ME] });
  });
});

describe("attestations", () => {
  it("confirms an on-chain attestation that matches the issued report, once", async () => {
    const { store, app, fc } = setup();
    const m = new FakeMessenger();
    store.ensureChat(1, "private");
    store.addWatch(1, ME, { owned: true });
    const code = store.createCode(1, "attest");
    const r = (await (await app.request(`/api/attest/${code}/report?account=${ME}`)).json()) as { score: number; reportHash: `0x${string}` };
    const hook = attestHook({ store, chain: fc.chain, messenger: m, log: silentLogger, contract: config.attestContract!, publicUrl: "https://qw.test" });
    const ev = { account: "0x35750cc522969f297f421e411e0cb4493572b1a8", score: r.score, reportHash: r.reportHash, code, txHash: "0xabc", block: 10_400_000 };
    expect(await hook.handle(ev)).toBe(true);
    expect(m.sent[0]!.html).toMatch(/matches the report QoreWatch gave you/);
    expect(await hook.handle(ev)).toBe(false);
  });

  it("says so when the attested score differs from the issued report", async () => {
    const { store, fc } = setup();
    const m = new FakeMessenger();
    store.ensureChat(1, "private");
    store.addWatch(1, ME, { owned: true });
    const code = store.createCode(1, "attest");
    const hook = attestHook({ store, chain: fc.chain, messenger: m, log: silentLogger, contract: config.attestContract!, publicUrl: "https://qw.test" });
    await hook.handle({ account: "0x35750cc522969f297f421e411e0cb4493572b1a8", score: 100, reportHash: reportHash("made up"), code, txHash: "0xabc", block: 1 });
    expect(m.sent[0]!.html).toMatch(/does not match/);
  });

  it("hashes the canonical report deterministically and round-trips codes", () => {
    const base = { address: ME, status: "ready" as const, score: 100, findings: [{ id: "pq_key" }, { id: "classical_public" }] as never, checkedAt: "2026-11-19T10:00:00Z" };
    expect(reportHash(canonicalReport(base))).toBe(reportHash(canonicalReport({ ...base, checkedAt: "2026-11-19T23:59:00Z" })));
    expect(reportHash(canonicalReport(base))).not.toBe(reportHash(canonicalReport({ ...base, score: 99 })));
    expect(codeFromBytes(codeBytes("ABCD2345"))).toBe("ABCD2345");
  });
});
