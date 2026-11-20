import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTx } from "@qorewatch/core";
import { createBot } from "../src/telegram/bot.js";
import { Pacer } from "../src/telegram/messenger.js";
import { Store } from "../src/db/store.js";
import { silentLogger } from "../src/log.js";
import { handleLinkTx, LINK_MEMO } from "../src/linking.js";
import type { Config } from "../src/config.js";
import { FakeTelegram } from "./fake-telegram.js";
import { CAROL, fakeChain, ME, txFixture, type FakeState } from "./fake-chain.js";

const USER = 1001;
const GROUP = -100777;

let tg: FakeTelegram;
let store: Store;
let state: FakeState;
let bot: ReturnType<typeof createBot>["bot"];
let messenger: ReturnType<typeof createBot>["messenger"];

const config = (apiRoot: string): Config => ({
  telegramToken: tg.token,
  telegramApiRoot: apiRoot,
  botUsername: "qorewatchbot",
  publicUrl: "https://qorewatch.test",
  network: "testnet",
  dataDir: ":memory:",
  httpHost: "127.0.0.1",
  httpPort: 0,
  adminChatIds: [],
  maxCatchupBlocks: 100,
  pollMs: 10,
  logLevel: "error",
});

beforeEach(async () => {
  tg = new FakeTelegram();
  const root = await tg.start();
  store = new Store(":memory:");
  const fc = fakeChain();
  state = fc.state;
  const made = createBot({
    config: config(root),
    store,
    chain: fc.chain,
    log: silentLogger,
    pacer: new Pacer(1000, 0, 0),
    hooks: {
      status: () => ({ height: 10_386_499, chainHeight: 10_386_500, lagBlocks: 1, startedAt: "2026-11-19T00:00:00Z" }),
      card: async () => new Uint8Array([137, 80, 78, 71]),
      pools: async () => [{ id: "2", name: "fUSD / QOR", price: 22.7, priceText: "1 fUSD = 22.7 QOR" }],
      proposals: async () => ({ html: "🗳 <b>No proposals are open for voting.</b>" }),
      digest: async () => ({ html: "📰 <b>Your daily digest</b>" }),
    },
  });
  bot = made.bot;
  messenger = made.messenger;
  await bot.init();
});

afterEach(async () => {
  await tg.stop();
  store.close();
});

const send = (u: Record<string, unknown>) => bot.handleUpdate(u as never);
const say = (text: string, chat = USER, opts: Parameters<FakeTelegram["text"]>[2] = {}) => send(tg.text(chat, text, opts));
const press = (data: string, chat = USER, userId?: number) => send(tg.press(chat, data, userId ? { userId } : {}));
const lastText = (chat = USER) => String(tg.last(chat)?.body.text ?? tg.last(chat)?.body.caption ?? "");

describe("QoreWatch bot over the Telegram Bot API", () => {
  it("greets on /start with the main menu", async () => {
    await say("/start");
    expect(lastText()).toMatch(/I'm QoreWatch/);
    const buttons = FakeTelegram.buttons(tg.last(USER)).map((b) => b.text);
    expect(buttons).toEqual(["🔗 Link my wallet", "👁 Watch an address", "🩺 Check an address", "📋 My watches", "⚙️ Settings", "❓ Help"]);
    expect(store.chat(USER)?.type).toBe("private");
  });

  it("starts a link with a one-time code carried in the memo and the page URL fragment", async () => {
    await say("/link");
    const text = lastText();
    const code = /QoreWatch link ([A-Z0-9]{8})/.exec(text)?.[1];
    expect(code).toBeDefined();
    const url = FakeTelegram.buttons(tg.last(USER))[0]!.url!;
    expect(url).toBe(`https://qorewatch.test/link#${code}`);
    expect(store.codeInfo(code!)).toMatchObject({ chatId: USER, purpose: "link", usedAt: null });
  });

  it("links the signer of a hybrid-signed transaction that carries the code", async () => {
    await say("/link");
    const code = /QoreWatch link ([A-Z0-9]{8})/.exec(lastText())![1]!;
    const [raw] = txFixture("bank_send");
    const tx = await buildTx({ tx: raw!.tx, result: raw!.tx_result as never, height: raw!.height, time: raw!.time, hash: raw!.hash });
    store.claimCode(code, tx.signer!);
    const outcome = await handleLinkTx({ ...tx, memo: LINK_MEMO(code) }, store, messenger, "https://qorewatch.test");
    expect(outcome).toMatchObject({ linked: true, chatId: USER, address: tx.signer });
    expect(store.watch(USER, tx.signer!)).toMatchObject({ owned: true, label: "My wallet", linkedTx: tx.hash });
    expect(lastText()).toMatch(/Wallet linked/);
    // The code works once.
    expect(await handleLinkTx({ ...tx, memo: LINK_MEMO(code) }, store, messenger, "https://qorewatch.test")).toMatchObject({ linked: false, reason: "bad_code" });
    // A failed or classical-only transaction never links.
    const code2 = store.createCode(USER, "link");
    store.claimCode(code2, tx.signer!);
    expect(await handleLinkTx({ ...tx, memo: LINK_MEMO(code2), failed: true }, store, messenger, "x")).toMatchObject({ reason: "failed_tx" });
    expect(await handleLinkTx({ ...tx, memo: LINK_MEMO(code2), hybridSigned: false }, store, messenger, "x")).toMatchObject({ reason: "not_hybrid" });
  });

  it("watches an address with a label, a 0x address and a verified @handle", async () => {
    await say(`/watch ${ME} Treasury`);
    expect(store.watch(USER, ME)).toMatchObject({ label: "Treasury", owned: false });
    expect(lastText()).toMatch(/Watching/);
    await say("/watch 0xeB279977041A05a7F909Bd0942411F682bB581d8");
    expect(store.watch(USER, CAROL)).toBeDefined();
    await say("/watch @test");
    expect(store.watches(USER).some((w) => w.label === "@test")).toBe(true);
    await say("/watch nonsense");
    expect(lastText()).toMatch(/not a QoreChain address/);
    await say("/watch @nobody_here");
    expect(lastText()).toMatch(/Nobody has claimed/);
  });

  it("asks for the address when /watch has none, then takes the next message", async () => {
    await press("menu:watch");
    expect(lastText()).toMatch(/Send me the address to watch/);
    await say(`${CAROL} Carol`);
    expect(store.watch(USER, CAROL)?.label).toBe("Carol");
  });

  it("lists watches, opens one, renames, sets a threshold, mutes a category and removes it", async () => {
    await say(`/watch ${ME} Main`);
    await say("/list");
    expect(lastText()).toMatch(/Watching 1 address/);
    await press(`w:o:${ME}`);
    expect(lastText()).toMatch(/Money alerts from: <b>any amount<\/b>/);
    await press(`w:lb:${ME}`);
    await say("Cold wallet");
    expect(store.watch(USER, ME)?.label).toBe("Cold wallet");
    await press(`w:th:${ME}`);
    await say("100");
    expect(store.watch(USER, ME)?.minUqor).toBe(100_000_000n);
    await press(`w:mt:${ME}:0`);
    expect(store.watch(USER, ME)?.muted).toEqual(["money"]);
    await press(`w:rm:${ME}`);
    expect(lastText()).toMatch(/Stop watching/);
    await press(`w:rmy:${ME}`);
    expect(store.watch(USER, ME)).toBeUndefined();
  });

  it("checks an account and reports a fix for an open window to any recipient", async () => {
    await say(`/check ${ME}`);
    expect(lastText()).toMatch(/Quantum-ready<\/b> · <b>100<\/b>\/100/);
    expect(lastText()).toMatch(/Balance: 4\.625779 QOR, 12 fUSD/);
    state.window[ME] = { found: true, live: true, max_txs: "5", used_txs: "1", remaining_txs: "4", remaining_value: "20000000", remaining_blocks: "600", allowed_targets: [] };
    await say(`/check ${ME}`);
    expect(lastText()).toMatch(/Needs attention/);
    const fix = FakeTelegram.buttons(tg.last(USER)).find((b) => b.text.includes("Close the window"));
    expect(fix?.url).toBe(`https://qorewatch.test/fix/window#${ME}`);
  });

  it("checks an account with no post-quantum key as at risk", async () => {
    await say(`/check ${CAROL}`);
    expect(lastText()).toMatch(/At risk/);
    expect(lastText()).toMatch(/No post-quantum key, and the classical key is public/);
    expect(FakeTelegram.buttons(tg.last(USER)).some((b) => b.url === `https://qorewatch.test/fix/key#${CAROL}`)).toBe(true);
  });

  it("explains a transaction by Cosmos hash and by EVM hash", async () => {
    const [grant] = txFixture("authz_grant");
    await say(`/tx ${grant!.hash}`);
    expect(lastText()).toMatch(/A permission grant/);
    expect(lastText()).toMatch(/It gives another account permission to act for the signer/);
    const buttons = FakeTelegram.buttons(tg.last(USER));
    expect(buttons.map((b) => b.url)).toEqual([`https://qorewatch.test/tx/${grant!.hash}`, `https://explore.qore.network/tx/${grant!.hash}`]);
    await say("/tx 0xb18cdc18fe8e8500a43dbdccb43d0a24e451193a01296a389de1cea548a1c90c");
    expect(lastText()).toMatch(/An EVM transaction/);
    await say(`/tx ${"A".repeat(64)}`);
    expect(lastText()).toMatch(/could not find that transaction/);
  });

  it("answers 'is this safe?' for pasted addresses, contracts and hashes", async () => {
    await say(`can I send to ${CAROL}?`);
    expect(lastText()).toMatch(/Is this safe\?/);
    expect(lastText()).toMatch(/no post-quantum key/);
    await say("qor1qqqqqqqqqqqqqqqqqqqqqqqqqqqqutspnqme4f");
    expect(lastText()).toMatch(/never been used/);
    await say("0xd837298637f4459a3981b540d5543a4423add801");
    expect(lastText()).toMatch(/EVM contract/);
    await say("qor17xpfvakm2amg962yls6f84z3kell8c5lyj5r7l");
    expect(lastText()).toMatch(/network fee collector/);
    await say("hello there");
    expect(lastText()).toMatch(/Send me an address/);
  });

  it("sets quiet hours, time zone, digest, pause and categories", async () => {
    await say("/timezone lagos");
    expect(store.chat(USER)?.tz).toBe("Africa/Lagos");
    await say("/quiet 23:00-07:00");
    expect(store.chat(USER)).toMatchObject({ quietStart: 1380, quietEnd: 420 });
    await say("/quiet off");
    expect(store.chat(USER)?.quietStart).toBeNull();
    await say("/quiet whenever");
    expect(lastText()).toMatch(/Use: \/quiet/);
    await say("/digest 08:30");
    expect(store.chat(USER)?.digestMinute).toBe(510);
    await say("/digest now");
    expect(lastText()).toMatch(/Your daily digest/);
    await say("/pause");
    expect(store.chat(USER)?.paused).toBe(true);
    await say("/resume");
    expect(store.chat(USER)?.paused).toBe(false);
    await say("/settings");
    await press("s:mute:3");
    expect(store.chat(USER)?.muted).toEqual(["staking"]);
    await press("s:net");
    expect(store.chat(USER)?.networkAlerts).toBe(false);
    await say("/mute governance");
    expect(store.chat(USER)?.muted).toContain("governance");
    await say("/unmute governance");
    expect(store.chat(USER)?.muted).not.toContain("governance");
  });

  it("sets thresholds by command", async () => {
    await say(`/watch ${ME}`);
    await say("/threshold 250");
    expect(store.watch(USER, ME)?.minUqor).toBe(250_000_000n);
    await say(`/threshold ${ME} 0.5`);
    expect(store.watch(USER, ME)?.minUqor).toBe(500_000n);
    await say(`/threshold ${ME} lots`);
    expect(lastText()).toMatch(/Send an amount in QOR/);
  });

  it("lists pools and sets price alerts", async () => {
    await say("/pools");
    expect(lastText()).toMatch(/#2<\/b> fUSD \/ QOR: 1 fUSD = 22\.7 QOR/);
    await say("/pricealert 2 5");
    expect(store.poolWatches(USER)).toEqual([expect.objectContaining({ poolId: "2", pct: 5, basePrice: 22.7 })]);
    await say("/pricealert 9 5");
    expect(lastText()).toMatch(/don't know that pool/);
    await say("/pricealert 2 off");
    expect(store.poolWatches(USER)).toEqual([]);
  });

  it("lets only admins change a group's watches", async () => {
    tg.memberStatus = "member";
    await say(`/watch ${ME}`, GROUP, { userId: 55, title: "Treasury team" });
    expect(lastText(GROUP)).toMatch(/Only group admins/);
    expect(store.watch(GROUP, ME)).toBeUndefined();
    tg.memberStatus = "administrator";
    await say(`/watch ${ME} Treasury`, GROUP, { userId: 55, title: "Treasury team" });
    expect(store.watch(GROUP, ME)?.label).toBe("Treasury");
    expect(store.chat(GROUP)).toMatchObject({ type: "supergroup", title: "Treasury team" });
    // Anyone may run read-only lookups.
    tg.memberStatus = "member";
    await say(`/check ${ME}`, GROUP, { userId: 56 });
    expect(lastText(GROUP)).toMatch(/Account check/);
    // Plain chatter in a group is ignored.
    const n = tg.calls.length;
    await say(`look at ${CAROL}`, GROUP, { userId: 56 });
    expect(tg.calls.length).toBe(n);
  });

  it("forgets a group when the bot is removed", async () => {
    tg.memberStatus = "administrator";
    await say(`/watch ${ME}`, GROUP, { userId: 55 });
    await send({
      update_id: 9999,
      my_chat_member: { chat: { id: GROUP, type: "supergroup", title: "T" }, from: { id: 55, is_bot: false, first_name: "A" }, date: 1, old_chat_member: { status: "member", user: { id: 123456789, is_bot: true, first_name: "QoreWatch" } }, new_chat_member: { status: "kicked", until_date: 0, user: { id: 123456789, is_bot: true, first_name: "QoreWatch" } } },
    });
    expect(store.chat(GROUP)).toBeUndefined();
    expect(store.watches(GROUP)).toEqual([]);
  });

  it("deletes everything on /forget after confirmation", async () => {
    await say(`/watch ${ME}`);
    await say("/forget");
    await press("fg:no");
    expect(store.watches(USER)).toHaveLength(1);
    await press("fg:yes");
    expect(store.chat(USER)).toBeUndefined();
  });

  it("shows status, privacy, help, proposals and history", async () => {
    await say("/status");
    expect(lastText()).toMatch(/in sync/);
    await say("/privacy");
    expect(lastText()).toMatch(/never stores your name/);
    await say("/help");
    expect(lastText()).toMatch(/\/pricealert/);
    await say("/proposals");
    expect(lastText()).toMatch(/No proposals/);
    await say(`/history ${ME}`);
    expect(lastText()).toMatch(/Last \d transaction/);
  });

  it("sends a share card as a photo", async () => {
    await press(`card:${ME}`);
    expect(tg.calls.some((c) => c.method === "sendPhoto")).toBe(true);
  });

  it("retries after Telegram's rate limit and pauses chats that blocked the bot", async () => {
    tg.failures.push({ method: "sendMessage", code: 429, description: "Too Many Requests: retry after 1", retryAfter: 1 });
    expect(await messenger.send(USER, "hello")).toEqual({ ok: true });
    tg.failures.push({ method: "sendMessage", code: 403, description: "Forbidden: bot was blocked by the user" });
    expect(await messenger.send(USER, "hello")).toEqual({ ok: false, blocked: true, error: "Forbidden: bot was blocked by the user" });
  });

  it("refuses unknown commands politely", async () => {
    await say("/frobnicate");
    expect(lastText()).toMatch(/don't know that command/);
  });
});
