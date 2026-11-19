import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Handles, isHandle, normalizeHandle, verifyHandleRecord, type HandleRecord } from "../src/handles.js";
import { Http, type FetchLike } from "../src/http.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/handle-test.json", import.meta.url), "utf8")) as { record: HandleRecord };
const answer = (status: number, body: unknown): FetchLike => async () => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

describe("QoreX @handles", () => {
  it("verifies a real record from the QoreX handle registry", () => {
    expect(() => verifyHandleRecord(fixture.record)).not.toThrow();
  });

  it("rejects swapped addresses, other registry keys and tampered fields", () => {
    expect(() => verifyHandleRecord({ ...fixture.record, qorAddress: "qor18z3hpmxe5tjrdpk096jgj5ppd6mwry5atay6g4" })).toThrowError(/owner key does not match/);
    expect(() => verifyHandleRecord(fixture.record, "00".repeat(32))).toThrowError(/registry signature invalid|malformed/);
    expect(() => verifyHandleRecord({ ...fixture.record, createdAt: fixture.record.createdAt + 1 })).toThrowError(/registry signature invalid/);
  });

  it("normalises and validates handle syntax like QoreX", () => {
    expect(normalizeHandle("  @Maria ")).toBe("maria");
    expect(isHandle("@maria_01")).toBe(true);
    expect(isHandle("ab")).toBe(false);
    expect(isHandle("qorex")).toBe(false);
  });

  it("resolves verified records, reports unclaimed handles and refuses lies", async () => {
    const ok = new Handles(new Http({ fetch: answer(200, fixture) }), "https://registry.example");
    expect((await ok.resolve("@Test"))?.qorAddress).toBe(fixture.record.qorAddress);
    const none = new Handles(new Http({ fetch: answer(404, {}) }), "https://registry.example");
    expect(await none.resolve("nobody_here")).toBeUndefined();
    const lying = new Handles(new Http({ fetch: answer(200, { record: { ...fixture.record, qorAddress: "qor18z3hpmxe5tjrdpk096jgj5ppd6mwry5atay6g4" } }) }), "https://registry.example");
    await expect(lying.resolve("test")).rejects.toThrowError(/failed verification/);
    const other = new Handles(new Http({ fetch: answer(200, fixture) }), "https://registry.example");
    await expect(other.resolve("other_name")).rejects.toThrowError(/answered for @test/);
  });

  it("reverse lookups never throw", async () => {
    const h = new Handles(new Http({ fetch: answer(500, {}), attempts: 1 }), "https://registry.example");
    expect(await h.reverse(fixture.record.qorAddress)).toBeUndefined();
    const ok = new Handles(new Http({ fetch: answer(200, fixture) }), "https://registry.example");
    expect(await ok.reverse(fixture.record.qorAddress)).toBe("test");
  });
});
