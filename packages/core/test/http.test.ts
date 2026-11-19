import { describe, expect, it } from "vitest";
import { Http, HttpError, type FetchLike } from "../src/http.js";
import { Rest } from "../src/rest.js";
import { Rpc } from "../src/rpc.js";

const res = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

describe("Http", () => {
  it("retries 429 and 5xx, then succeeds", async () => {
    const answers = [res(503, {}), res(429, {}), res(200, { ok: 1 })];
    let n = 0;
    const http = new Http({ fetch: async () => answers[n++]!, attempts: 4 });
    expect(await http.json("https://x/y")).toEqual({ ok: 1 });
    expect(n).toBe(3);
  });

  it("never retries other 4xx", async () => {
    let n = 0;
    const http = new Http({ fetch: async () => (n++, res(404, {})), attempts: 4 });
    await expect(http.json("https://x/y?addr=secret")).rejects.toThrowError(HttpError);
    expect(n).toBe(1);
  });

  it("keeps addresses out of error messages", async () => {
    const http = new Http({ fetch: async () => res(404, {}), attempts: 1 });
    await expect(http.json("https://x/y?addr=qor1abc")).rejects.toThrowError(/^HTTP 404 from https:\/\/x\/y$/);
  });

  it("caps requests in flight", async () => {
    let active = 0;
    let peak = 0;
    const f: FetchLike = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return res(200, {});
    };
    const http = new Http({ fetch: f, concurrency: 2 });
    await Promise.all(Array.from({ length: 8 }, () => http.json("https://x")));
    expect(peak).toBe(2);
  });

  it("sends its own user agent", async () => {
    let ua = "";
    const http = new Http({ fetch: async (_u, init) => ((ua = init?.headers?.["user-agent"] ?? ""), res(200, {})) });
    await http.json("https://x");
    expect(ua).toMatch(/^QoreWatch\//);
  });
});

describe("Rest and Rpc parsing", () => {
  it("reads an EVM window", async () => {
    const body = { found: true, live: true, opened_height: "1", expiry_height: "101", max_txs: "5", used_txs: "1", max_value: "1000", used_value: "10", remaining_blocks: "50", remaining_txs: "4", remaining_value: "990", native_only: false, allowed_targets: ["0xABC"] };
    const rest = new Rest("https://rest", new Http({ fetch: async () => res(200, body) }));
    expect(await rest.evmWindow("qor1x")).toMatchObject({ live: true, remainingTxs: 4, remainingValueUqor: 990n, allowedTargets: ["0xabc"] });
  });

  it("maps a missing PQC account to found:false and a 404 auth account to exists:false", async () => {
    const rest = new Rest("https://rest", new Http({ fetch: async (u) => (u.includes("/pqc/") ? res(200, { found: false }) : res(404, {})), attempts: 1 }));
    expect(await rest.pqcAccount("qor1x")).toEqual({ found: false });
    expect(await rest.authAccount("qor1x")).toMatchObject({ exists: false, classicalKeyExposed: false });
  });

  it("treats an account that signed with secp256k1 as having its classical key exposed", async () => {
    const rest = new Rest("https://rest", new Http({ fetch: async () => res(200, { account: { "@type": "/cosmos.auth.v1beta1.BaseAccount", pub_key: { "@type": "/cosmos.evm.crypto.v1.ethsecp256k1.PubKey", key: "x" }, sequence: "3", account_number: "9" } }) }));
    expect(await rest.authAccount("qor1x")).toMatchObject({ exists: true, classicalKeyExposed: true, sequence: 3 });
  });

  it("surfaces RPC errors with their message", async () => {
    const rpc = new Rpc("https://rpc", new Http({ fetch: async () => res(200, { error: { code: -32603, message: "Internal error", data: "height 5 must be less than or equal to the current blockchain height 4" } }) }));
    await expect(rpc.blockTxs(5)).rejects.toThrowError(/must be less than or equal/);
  });

  it("pairs block transactions with their results", async () => {
    const rpc = new Rpc(
      "https://rpc",
      new Http({
        fetch: async (u) =>
          u.includes("/block_results")
            ? res(200, { result: { txs_results: [{ code: 0, events: [] }, { code: 5, log: "insufficient funds", events: [] }] } })
            : res(200, { result: { block: { header: { time: "2026-11-19T00:00:00Z", height: "7" }, data: { txs: ["AA==", "AQ=="] } } } }),
      }),
    );
    const b = await rpc.blockTxs(7);
    expect(b.txs.map((t) => t.result.code)).toEqual([0, 5]);
    expect(b.txs[1]!.index).toBe(1);
  });
});
