import { describe, expect, it } from "vitest";
import { Store } from "../../src/db/store.js";
import { createServer } from "../../src/server/http.js";
import { attestHook, reportHash } from "../../src/attest.js";
import { silentLogger } from "../../src/log.js";
import type { Config } from "../../src/config.js";
import { FakeMessenger } from "../fakes.js";
import { fakeChain, ME } from "../fake-chain.js";

const config: Config = { telegramToken: "x", botUsername: "qorewatchbot", publicUrl: "https://qw.test", network: "testnet", dataDir: ":memory:", httpHost: "127.0.0.1", httpPort: 0, adminChatIds: [], maxCatchupBlocks: 10, pollMs: 10, logLevel: "error", attestContract: "0x00000000000000000000000000000000000a77e5" };
const ME_EVM = "0x35750cc522969f297f421e411e0cb4493572b1a8";
const ATTACKER_EVM = "0x1111111111111111111111111111111111111111";

/**
 * Audit A3 / F-10: the attest code travels in public calldata (bytes8) and in the chat. Anyone who
 * sees it (mempool watcher, group member) can call attest() first from their own account with it.
 * The bot consumed the code for ANY account: the chat got "<attacker> attested a score of 100" and
 * the owner's real attestation was then ignored (code already used). Same class as F-1 (link codes).
 */
describe("security: an attest code only counts for an account the chat linked", () => {
  it("ignores a front-run attestation from another account and still confirms the owner's", async () => {
    const store = new Store(":memory:");
    const fc = fakeChain();
    const app = createServer({ config, store, chain: fc.chain, log: silentLogger, status: () => ({ height: 1, chainHeight: 1, lagBlocks: 0 }) });
    const m = new FakeMessenger();
    store.ensureChat(1, "private");
    store.addWatch(1, ME, { owned: true });
    const code = store.createCode(1, "attest");
    const r = (await (await app.request(`/api/attest/${code}/report?account=${ME}`)).json()) as { score: number; reportHash: `0x${string}` };
    const hook = attestHook({ store, chain: fc.chain, messenger: m, log: silentLogger, contract: config.attestContract!, publicUrl: "https://qw.test" });
    // The attacker copies the code from the pending transaction and lands first.
    const front = await hook.handle({ account: ATTACKER_EVM, score: 100, reportHash: reportHash("made up"), code, txHash: "0xbad", block: 10 });
    expect(front).toBe(false);
    expect(m.sent).toHaveLength(0);
    // The owner's own attestation, one block later, is still confirmed.
    expect(await hook.handle({ account: ME_EVM, score: r.score, reportHash: r.reportHash, code, txHash: "0xabc", block: 11 })).toBe(true);
    expect(m.sent[0]!.html).toMatch(/matches the report QoreWatch gave you/);
    store.close();
  });
});
