import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTx } from "@qorewatch/core";
import { createBot } from "../../src/telegram/bot.js";
import { Pacer } from "../../src/telegram/messenger.js";
import { Store } from "../../src/db/store.js";
import { silentLogger } from "../../src/log.js";
import { handleLinkTx, LINK_MEMO } from "../../src/linking.js";
import { createServer } from "../../src/server/http.js";
import type { Config } from "../../src/config.js";
import { FakeTelegram } from "../fake-telegram.js";
import { fakeChain, txFixture } from "../fake-chain.js";

const GROUP = -100777;
const ADMIN = 55;
const MEMBER = 56;
let tg: FakeTelegram;
let store: Store;
let made: ReturnType<typeof createBot>;
let config: Config;

beforeEach(async () => {
  tg = new FakeTelegram();
  const root = await tg.start();
  store = new Store(":memory:");
  config = { telegramToken: tg.token, telegramApiRoot: root, botUsername: "qorewatchbot", publicUrl: "https://qorewatch.test", network: "testnet", dataDir: ":memory:", httpHost: "127.0.0.1", httpPort: 0, adminChatIds: [], maxCatchupBlocks: 100, pollMs: 10, logLevel: "error" };
  made = createBot({ config, store, chain: fakeChain().chain, log: silentLogger, pacer: new Pacer(1000, 0, 0) });
  await made.bot.init();
});
afterEach(async () => {
  await tg.stop();
  store.close();
});

/** Everything a chat can read: message texts and button URLs. */
const seen = (chat: number) => tg.calls.filter((c) => Number(c.body.chat_id) === chat).map((c) => `${String(c.body.text ?? "")} ${JSON.stringify(c.body.reply_markup ?? "")}`);
const codesIn = (texts: string[]) => texts.flatMap((t) => [...t.matchAll(/(?:QoreWatch link |link#)([A-HJ-NP-Z2-9]{8})/g)].map((m) => m[1]!));

/**
 * Audit A2 / F-9: an admin's /link in a group posted the live code to the whole group. Any member
 * could claim it on the link page with their own address first and link their own wallet as the
 * group's "My wallet", bypassing "only admins change what the group watches".
 */
describe("security: a group member cannot hijack an admin's link code", () => {
  it("never shows a live link code to the group, and a member's claim+link fails", async () => {
    tg.memberStatus = "administrator";
    await made.bot.handleUpdate(tg.text(GROUP, "/link", { userId: ADMIN, title: "Treasury team" }) as never);
    // What every member of the group can read:
    const leaked = [...new Set(codesIn(seen(GROUP)))];
    // The member's attack: claim the code with their own address, then send their own hybrid-signed tx.
    const [raw] = txFixture("bank_send");
    const memberTx = await buildTx({ tx: raw!.tx, result: raw!.tx_result as never, height: raw!.height, time: raw!.time, hash: raw!.hash });
    const app = createServer({ config, store, chain: fakeChain().chain, log: silentLogger, status: () => ({}) });
    for (const code of leaked) {
      const r = await app.request(`/api/link/${code}/claim`, { method: "POST", body: JSON.stringify({ address: memberTx.signer }), headers: { "content-type": "application/json" } });
      if (r.status === 200) await handleLinkTx({ ...memberTx, memo: LINK_MEMO(code) }, store, made.messenger, config.publicUrl);
    }
    expect(store.watch(GROUP, memberTx.signer!)?.owned ?? false).toBe(false);
    expect(leaked).toEqual([]);
    // The admin gets the code privately, still for the group.
    const dm = [...new Set(codesIn(seen(ADMIN)))];
    expect(dm).toHaveLength(1);
    expect(store.codeInfo(dm[0]!)).toMatchObject({ chatId: GROUP, purpose: "link" });
    void MEMBER;
  });
});
