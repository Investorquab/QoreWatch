import { describe, expect, it } from "vitest";
import { plain } from "@qorewatch/core";
import { Store } from "../src/db/store.js";
import { Deliverer } from "../src/alerts/deliver.js";
import { Watcher } from "../src/watcher/watcher.js";
import { Jobs } from "../src/watcher/jobs.js";
import { silentLogger } from "../src/log.js";
import { LINK_MEMO } from "../src/linking.js";
import { FakeMessenger } from "./fakes.js";
import { fakeChain, ME, txFixture } from "./fake-chain.js";

function setup() {
  const store = new Store(":memory:");
  const m = new FakeMessenger();
  const fc = fakeChain();
  let now = new Date("2026-11-19T12:00:00Z");
  const deliverer = new Deliverer(store, m, silentLogger, () => now);
  const watcher = new Watcher({ chain: fc.chain, store, deliverer, messenger: m, log: silentLogger, publicUrl: "https://qw.test", maxCatchupBlocks: 50, batch: 3 });
  const jobs = new Jobs({ store, chain: fc.chain, deliverer, messenger: m, log: silentLogger, publicUrl: "https://qw.test", height: () => watcher.status.height, now: () => now });
  return { store, m, fc, watcher, jobs, setNow: (s: string) => (now = new Date(s)) };
}
const put = (state: ReturnType<typeof fakeChain>["state"], height: number, name: string, i = 0) => {
  const t = txFixture(name)[i]!;
  (state.blocks[height] ??= []).push({ tx: t.tx, tx_result: t.tx_result });
  return t;
};

describe("Watcher", () => {
  it("starts at the chain head on a first run and processes new blocks in order", async () => {
    const { store, fc, watcher } = setup();
    fc.state.height = 1000;
    await watcher.init();
    expect(store.cursor("native")).toBe(999);
    fc.state.height = 1005;
    expect(await watcher.tick()).toBe(6);
    expect(store.cursor("native")).toBe(1005);
    expect(watcher.status.lagBlocks).toBe(0);
  });

  it("skips ahead after a long outage instead of replaying days of blocks", async () => {
    const { store, fc, watcher } = setup();
    store.setCursor("native", 100);
    fc.state.height = 1000;
    await watcher.init();
    expect(store.cursor("native")).toBe(950);
  });

  it("alerts every chat watching an address, once, and survives a restart without repeating", async () => {
    const { store, m, fc, watcher } = setup();
    store.ensureChat(1, "private");
    store.ensureChat(-2, "supergroup");
    store.addWatch(1, ME, { owned: true });
    store.addWatch(-2, ME, { label: "Treasury" });
    fc.state.height = 2000;
    await watcher.init();
    fc.state.height = 2002;
    // own_demo_inbox: [0] EVM tx from ME (window used + 0.011 QOR), [1] window opened by ME.
    put(fc.state, 2001, "own_demo_inbox", 1);
    put(fc.state, 2002, "own_demo_inbox", 0);
    await watcher.tick();
    const to1 = m.sent.filter((s) => s.chatId === 1).map((s) => plain(s.html.split("\n")[0]!));
    const toGroup = m.sent.filter((s) => s.chatId === -2).map((s) => plain(s.html.split("\n")[0]!));
    expect(to1).toEqual(expect.arrayContaining(["🪟 A spending window opened on your account", "📤 Sent 0.011 QOR", "🪟 Spent from the open window"]));
    expect(toGroup).toEqual(expect.arrayContaining(["🪟 A spending window opened on Treasury", "📤 Sent 0.011 QOR"]));
    const n = m.sent.length;
    // Simulate a crash before the cursor moved: the same blocks are processed again.
    store.setCursor("native", 2000);
    await watcher.tick();
    expect(m.sent.length).toBe(n);
  });

  it("completes a link from a memo in a block", async () => {
    const { store, m, fc, watcher } = setup();
    store.ensureChat(7, "private");
    const code = store.createCode(7, "link");
    fc.state.height = 3000;
    await watcher.init();
    const t = txFixture("bank_send")[0]!;
    // Rewrite the memo of a real hybrid-signed send by re-encoding its body.
    const { TxRaw, TxBody } = await import("cosmjs-types/cosmos/tx/v1beta1/tx.js");
    const raw = TxRaw.decode(Buffer.from(t.tx, "base64"));
    const body = TxBody.decode(raw.bodyBytes);
    body.memo = LINK_MEMO(code);
    raw.bodyBytes = TxBody.encode(body).finish();
    fc.state.blocks[3001] = [{ tx: Buffer.from(TxRaw.encode(raw).finish()).toString("base64"), tx_result: t.tx_result }];
    fc.state.height = 3001;
    await watcher.tick();
    const w = store.watches(7);
    expect(w).toHaveLength(1);
    expect(w[0]!.owned).toBe(true);
    expect(m.sent.some((s) => s.chatId === 7 && /Wallet linked/.test(s.html))).toBe(true);
  });

  it("schedules a window expiry warning and an unstaking completion", async () => {
    const { store, fc, watcher } = setup();
    const ub = txFixture("staking_undelegate")[0]!;
    const delegator = (ub.tx_result as { events: { type: string; attributes: { key: string; value: string }[] }[] }).events.find((e) => e.type === "unbond")!.attributes.find((a) => a.key === "delegator")!.value;
    store.ensureChat(1, "private");
    store.addWatch(1, delegator);
    fc.state.height = 4000;
    await watcher.init();
    put(fc.state, 4001, "staking_undelegate");
    fc.state.height = 4001;
    await watcher.tick();
    expect(store.dueSchedules(10 ** 9, 10 ** 15).map((s) => s.kind)).toContain("unbond_done");
  });

  it("scans EVM token logs for watched owners and records approvals", async () => {
    const { store, m, fc, watcher } = setup();
    store.ensureChat(1, "private");
    store.addWatch(1, ME, { owned: true });
    fc.state.height = 5000;
    await watcher.init();
    fc.state.logs.push({ kind: "token_approval", token: "0x97143b771d34ddb9130b807b135ae675a5a963ca", owner: "0x35750cc522969f297f421e411e0cb4493572b1a8", spender: "0x65353cd68f5f0e3e6fd3c578f1215e36da25ed8f", value: 2n ** 256n - 1n, unlimited: true, txHash: "0xfeed", block: 5001, logIndex: 0 });
    fc.state.height = 5001;
    await watcher.tick();
    expect(m.sent.some((s) => /Unlimited token approval/.test(s.html))).toBe(true);
    expect(store.approvals("0x35750cc522969f297f421e411e0cb4493572b1a8")).toHaveLength(1);
    expect(store.cursor("evm")).toBe(5001);
  });
});

describe("Jobs", () => {
  it("warns 30 minutes before a window expires, only if it is still open", async () => {
    const { store, m, fc, watcher, jobs } = setup();
    store.ensureChat(1, "private");
    store.addWatch(1, ME, { owned: true });
    store.schedule({ kind: "window_expiry", key: "winexp:x:6000", address: ME, dueHeight: 5000, data: { expiryHeight: 6000 } });
    fc.state.height = 5000;
    await watcher.init();
    watcher.status.height = 5000;
    fc.state.window[ME] = { found: true, live: true, expiry_height: "6000", remaining_txs: "3", remaining_value: "5000000", remaining_blocks: "1000", allowed_targets: [] };
    await jobs.schedules();
    expect(m.sent.some((s) => /closes in about 30 minutes/.test(s.html) && /3 transactions and 5 QOR/.test(s.html))).toBe(true);
    // A closed window gets no warning.
    store.schedule({ kind: "window_expiry", key: "winexp:x:7000", address: ME, dueHeight: 5000, data: { expiryHeight: 7000 } });
    const n = m.sent.length;
    await jobs.schedules();
    expect(m.sent.length).toBe(n);
  });

  it("sends the daily digest once a day at the chat's local time", async () => {
    const { store, m, jobs, setNow } = setup();
    store.ensureChat(1, "private");
    store.addWatch(1, ME, { owned: true, label: "Main" });
    store.updateChat(1, { tz: "Africa/Lagos", digestMinute: 8 * 60 });
    setNow("2026-11-20T06:30:00Z"); // 07:30 Lagos
    await jobs.digests();
    expect(m.sent).toHaveLength(0);
    setNow("2026-11-20T07:05:00Z"); // 08:05 Lagos
    await jobs.digests();
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]!.html).toMatch(/Your QoreWatch digest[\s\S]*Main[\s\S]*Balance: 4\.625779 QOR, 12 fUSD/);
    await jobs.digests();
    expect(m.sent).toHaveLength(1);
  });

  it("alerts on pool price moves past the chat's threshold and re-bases", async () => {
    const { store, m, fc, jobs } = setup();
    store.ensureChat(1, "private");
    store.setPoolWatch(1, "2", 5, 22.7);
    await jobs.pools();
    expect(m.sent).toHaveLength(0);
    (fc.state.pools[0] as { reserve_b: string }).reserve_b = "11500000000"; // ~25.1, +10.6%
    await jobs.pools();
    expect(m.sent[0]!.html).toMatch(/Pool #2 fUSD \/ QOR moved \+10\.\d%/);
    expect(store.poolWatches(1)[0]!.basePrice).toBeGreaterThan(25);
  });

  it("announces new proposals once, but not history on the first run", async () => {
    const { store, m, fc, jobs } = setup();
    store.ensureChat(1, "private");
    fc.state.proposals = [{ id: "39", status: "PROPOSAL_STATUS_PASSED", title: "Upgrade", messages: [] }];
    await jobs.governance();
    expect(m.sent).toHaveLength(0);
    fc.state.proposals = [{ id: "40", status: "PROPOSAL_STATUS_VOTING_PERIOD", title: "Lower fees", summary: "Cut the base fee.", messages: [], voting_end_time: "2026-11-19T20:00:00Z" }, ...fc.state.proposals];
    await jobs.governance();
    expect(m.sent.map((s) => plain(s.html.split("\n")[0]!))).toEqual(["🗳 New governance proposal #40"]);
    await jobs.governance();
    expect(m.sent).toHaveLength(1);
    fc.state.proposals[0] = { ...(fc.state.proposals[0] as object), status: "PROPOSAL_STATUS_PASSED" };
    await jobs.governance();
    expect(plain(m.sent.at(-1)!.html.split("\n")[0]!)).toBe("🗳 Proposal #40 passed ✅");
  });

  it("announces a network upgrade once, respecting the chat's network setting", async () => {
    const { store, m, fc, watcher, jobs } = setup();
    store.ensureChat(1, "private");
    store.ensureChat(2, "private");
    store.updateChat(2, { networkAlerts: false });
    fc.state.upgrade = { name: "v3.2.9", height: "10424000", info: "" };
    watcher.status.height = 10_386_500;
    await jobs.upgrade();
    await jobs.upgrade();
    expect(m.sent.map((s) => s.chatId)).toEqual([1]);
    expect(m.sent[0]!.html).toMatch(/upgrades to v3\.2\.9[\s\S]*block 10,424,000/);
  });
});
