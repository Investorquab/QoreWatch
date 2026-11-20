import { Bot, GrammyError, HttpError as TgHttpError, InputFile, type Context } from "grammy";
import { classify, esc, findLookups, formatUnits, parseUnits, shortAddress } from "@qorewatch/core";
import type { Config } from "../config.js";
import type { Store, Chat, ChatType } from "../db/store.js";
import { LIMITS } from "../db/store.js";
import type { Chain } from "../chain.js";
import type { Logger } from "../log.js";
import { CATEGORIES } from "../alerts/types.js";
import type { Button } from "../alerts/types.js";
import { clock, parseClock, resolveTimeZone } from "../alerts/time.js";
import { pages } from "../links.js";
import { LINK_MEMO } from "../linking.js";
import { checkView, historyView, resolveAddress, runCheck, safetyView, txView, type LookupDeps } from "../lookups.js";
import { help, MAIN_MENU, muteMenu, settings, watchDetail, watchList, welcome, type View } from "./views.js";
import { keyboard, type Messenger, type SendResult } from "./messenger.js";
import type { Pacer } from "./messenger.js";

/** Extra features plugged in by the rest of the app (kept as functions so the bot stays testable). */
export interface BotHooks {
  /** Watcher status for /status. */
  status?: () => { height?: number; chainHeight?: number; lagBlocks?: number; startedAt: string; lastError?: string };
  /** Build a share-card PNG for a check report. */
  card?: (address: string) => Promise<Uint8Array>;
  /** Pools and prices, for /pools and /pricealert. */
  pools?: () => Promise<{ id: string; name: string; price: number; priceText: string; thin?: boolean }[]>;
  /** Proposals, for /proposals. */
  proposals?: () => Promise<View>;
  /** Digest for a chat, now. */
  digest?: (chatId: number) => Promise<View>;
}

export interface BotDeps {
  config: Config;
  store: Store;
  chain: Chain;
  log: Logger;
  pacer: Pacer;
  hooks?: BotHooks;
}

type Pending = { kind: "watch" | "check" | "tx" | "label" | "threshold" | "quiet" | "tz" | "digest"; address?: string; at: number };

export const COMMANDS: { command: string; description: string }[] = [
  { command: "start", description: "Main menu" },
  { command: "link", description: "Link your wallet with QoreX" },
  { command: "watch", description: "Watch any address (read-only)" },
  { command: "list", description: "Your watched addresses" },
  { command: "check", description: "Post-quantum health check of an address" },
  { command: "tx", description: "Explain a transaction" },
  { command: "history", description: "Recent transactions of an address" },
  { command: "settings", description: "Alert categories, quiet hours, time zone" },
  { command: "quiet", description: "Quiet hours, e.g. 23:00-07:00 or off" },
  { command: "timezone", description: "Your time zone, e.g. Africa/Lagos" },
  { command: "threshold", description: "Minimum amount for money alerts" },
  { command: "digest", description: "Daily digest: a time, off, or now" },
  { command: "pools", description: "Swap pools and prices" },
  { command: "pricealert", description: "Alert when a pool price moves" },
  { command: "proposals", description: "Governance proposals" },
  { command: "attest", description: "Record on chain that you checked your account" },
  { command: "pause", description: "Pause alerts" },
  { command: "resume", description: "Resume alerts" },
  { command: "status", description: "Is QoreWatch in sync?" },
  { command: "privacy", description: "What QoreWatch stores" },
  { command: "forget", description: "Delete everything about this chat" },
  { command: "help", description: "All commands" },
];

/** Build the grammY bot with every command and button. Does not start polling. */
export function createBot(deps: BotDeps): { bot: Bot; messenger: Messenger } {
  const { config, store, chain, log, pacer } = deps;
  const hooks = deps.hooks ?? {};
  const bot = new Bot(config.telegramToken, config.telegramApiRoot ? { client: { apiRoot: config.telegramApiRoot } } : undefined);
  const lk: LookupDeps = { chain, store, publicUrl: config.publicUrl };
  const pending = new Map<number, Pending>();
  const PENDING_TTL = 10 * 60_000;

  // ---- sending with pacing and error mapping ----------------------------------------------------------------
  const map = async (fn: () => Promise<unknown>): Promise<SendResult> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await fn();
        return { ok: true };
      } catch (e) {
        if (e instanceof GrammyError) {
          if (e.error_code === 429) {
            const wait = Number((e.parameters as { retry_after?: number } | undefined)?.retry_after ?? 3);
            await new Promise((r) => setTimeout(r, Math.min(60, wait) * 1000));
            continue;
          }
          const blocked = e.error_code === 403 || /chat not found|bot was kicked|user is deactivated|have no rights/i.test(e.description);
          return { ok: false, blocked, error: e.description };
        }
        if (e instanceof TgHttpError && attempt < 2) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        return { ok: false, blocked: false, error: (e as Error).message };
      }
    }
    return { ok: false, blocked: false, error: "rate limited" };
  };
  const messenger: Messenger = {
    send: (chatId, html, buttons) =>
      pacer.run(chatId, () => map(() => bot.api.sendMessage(chatId, html, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...(keyboard(buttons) ? { reply_markup: keyboard(buttons)! } : {}) }))),
    sendPhoto: (chatId, png, caption, buttons) =>
      pacer.run(chatId, () => map(() => bot.api.sendPhoto(chatId, new InputFile(png, "qorewatch-check.png"), { caption, parse_mode: "HTML", ...(keyboard(buttons) ? { reply_markup: keyboard(buttons)! } : {}) }))),
  };

  const reply = (ctx: Context, v: View) =>
    ctx.reply(v.html, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...(keyboard(v.buttons) ? { reply_markup: keyboard(v.buttons)! } : {}) });
  const edit = async (ctx: Context, v: View) => {
    try {
      await ctx.editMessageText(v.html, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...(keyboard(v.buttons) ? { reply_markup: keyboard(v.buttons)! } : {}) });
    } catch (e) {
      if (e instanceof GrammyError && /message is not modified/.test(e.description)) return;
      await reply(ctx, v);
    }
  };

  const chatOf = (ctx: Context): Chat => store.ensureChat(ctx.chat!.id, ctx.chat!.type as ChatType, "title" in ctx.chat! ? (ctx.chat.title ?? null) : null);
  const isGroup = (ctx: Context) => ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
  /** In groups, only admins change what the group watches and its settings. */
  const canEdit = async (ctx: Context): Promise<boolean> => {
    if (!isGroup(ctx)) return true;
    if (!ctx.from) return false;
    try {
      const m = await ctx.getChatMember(ctx.from.id);
      if (m.status === "creator" || m.status === "administrator") return true;
    } catch {
      /* fall through */
    }
    await ctx.reply("Only group admins can change what this group watches or its settings.");
    return false;
  };
  const args = (ctx: Context) => (typeof ctx.match === "string" ? ctx.match.trim() : "");
  const busy = async <T>(ctx: Context, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      await ctx.replyWithChatAction("typing").catch(() => undefined);
      return await fn();
    } catch (e) {
      log.warn("command failed", { chat: ctx.chat?.id, error: (e as Error).message });
      await ctx.reply("⚠️ QoreChain's public node did not answer in time. Please try again in a moment.");
      return undefined;
    }
  };

  // ---- errors never crash the bot ----------------------------------------------------------------------------
  bot.catch((err) => log.error("update failed", { error: (err.error as Error)?.message ?? String(err.error), update: err.ctx.update.update_id }));

  // Register the chat on any interaction; drop stale pending prompts.
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== "channel") chatOf(ctx);
    const p = ctx.chat ? pending.get(ctx.chat.id) : undefined;
    if (p && Date.now() - p.at > PENDING_TTL) pending.delete(ctx.chat!.id);
    await next();
  });

  // ---- group membership ---------------------------------------------------------------------------------------
  bot.on("my_chat_member", async (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    const id = ctx.chat.id;
    if (status === "kicked" || status === "left") {
      store.forgetChat(id);
      log.info("removed from chat, data deleted", { chat: id });
      return;
    }
    if ((status === "member" || status === "administrator") && isGroup(ctx) && ctx.myChatMember.old_chat_member.status !== "member" && ctx.myChatMember.old_chat_member.status !== "administrator") {
      await reply(ctx, {
        html: "👋 <b>QoreWatch joined the group.</b>\n\nAdmins can add addresses with /watch <code>address label</code>, and everyone here will see the alerts: money moves, key changes, spending windows and new permissions.\n\nTry /check on any address.",
      });
    }
  });

  // ---- start / help / menu ------------------------------------------------------------------------------------
  bot.command("start", async (ctx) => {
    const payload = args(ctx);
    if (payload.startsWith("check_")) {
      const v = await busy(ctx, () => checkView(lk, ctx.chat.id, payload.slice(6)));
      if (v) await reply(ctx, v);
      return;
    }
    if (payload === "link") return startLink(ctx);
    await reply(ctx, welcome(ctx.from?.first_name));
  });
  bot.command("help", (ctx) => reply(ctx, help()));
  bot.command("menu", (ctx) => reply(ctx, { html: "What would you like to do?", buttons: MAIN_MENU }));

  // ---- link ---------------------------------------------------------------------------------------------------
  async function startLink(ctx: Context) {
    if (!(await canEdit(ctx))) return;
    const code = store.createCode(ctx.chat!.id, "link");
    await reply(ctx, {
      html: [
        "🔗 <b>Link your wallet</b>",
        "",
        "1. Open the link page on the computer where QoreX is installed, and connect QoreX there.",
        "2. Approve one tiny transaction to yourself (1 uqor, plus the network fee). Its note carries your code:",
        `<code>${LINK_MEMO(code)}</code>`,
        "3. I see it on chain within seconds and confirm here.",
        "",
        "QoreX signs it with your post-quantum key, which proves the address is yours. I never see or need a key. The code works once, for 15 minutes, and only for the address you connect on the page.",
      ].join("\n"),
      buttons: [[{ text: "Open the link page", url: pages(config.publicUrl).link(code) }]],
    });
  }
  bot.command("link", startLink);

  // ---- watch / list / unwatch ---------------------------------------------------------------------------------
  async function addWatch(ctx: Context, input: string) {
    if (!(await canEdit(ctx))) return;
    const [target, ...rest] = input.split(/\s+/);
    const label = rest.join(" ").slice(0, 40) || null;
    const r = await busy(ctx, () => resolveAddress(lk, target ?? ""));
    if (!r) return;
    if ("error" in r) return void (await ctx.reply(r.error, { parse_mode: "HTML" }));
    if (!store.addWatch(ctx.chat!.id, r.address, { label: label ?? (r.handle ? `@${r.handle}` : null) }))
      return void (await ctx.reply(`This chat already watches ${LIMITS.watchesPerChat} addresses, the maximum. Remove one with /list first.`));
    const w = store.watch(ctx.chat!.id, r.address)!;
    await reply(ctx, {
      html: `👁 <b>Watching</b> ${w.label ? `<b>${esc(w.label)}</b> · ` : ""}<code>${esc(r.address)}</code>\n\nI'll alert this chat about money moves, key changes, spending windows and permissions on this address. It is read-only: nothing here proves you own it.`,
      buttons: [[{ text: "🩺 Check it now", data: `c:${r.address}` }, { text: "⚙️ Its settings", data: `w:o:${r.address}` }]],
    });
  }
  bot.command("watch", async (ctx) => {
    const a = args(ctx);
    if (!a) {
      pending.set(ctx.chat.id, { kind: "watch", at: Date.now() });
      return void (await ctx.reply("Send me the address to watch (<code>qor1…</code>, <code>0x…</code> or <code>@handle</code>), optionally followed by a label.", { parse_mode: "HTML" }));
    }
    await addWatch(ctx, a);
  });
  bot.command(["list", "watches"], (ctx) => reply(ctx, watchList(store.watches(ctx.chat.id), chatOf(ctx))));
  bot.command("unwatch", async (ctx) => {
    const a = args(ctx);
    if (!a) return reply(ctx, watchList(store.watches(ctx.chat.id), chatOf(ctx)));
    if (!(await canEdit(ctx))) return;
    const r = await resolveAddress(lk, a);
    if ("error" in r) return void (await ctx.reply(r.error, { parse_mode: "HTML" }));
    await ctx.reply(store.removeWatch(ctx.chat.id, r.address) ? "Stopped watching it." : "This chat was not watching that address.");
  });
  bot.command("label", async (ctx) => {
    if (!(await canEdit(ctx))) return;
    const [target, ...rest] = args(ctx).split(/\s+/);
    const r = await resolveAddress(lk, target ?? "");
    if ("error" in r) return void (await ctx.reply(`${r.error}\n\nUse: /label <code>address name</code>`, { parse_mode: "HTML" }));
    if (!store.watch(ctx.chat.id, r.address)) return void (await ctx.reply("Watch it first with /watch."));
    store.updateWatch(ctx.chat.id, r.address, { label: rest.join(" ").slice(0, 40) || null });
    await ctx.reply("Label saved.");
  });

  // ---- lookups ------------------------------------------------------------------------------------------------
  bot.command("check", async (ctx) => {
    const a = args(ctx);
    if (!a) {
      const own = store.watches(ctx.chat.id).find((w) => w.owned);
      if (own) {
        const v = await busy(ctx, () => checkView(lk, ctx.chat.id, own.address));
        if (v) await reply(ctx, v);
        return;
      }
      pending.set(ctx.chat.id, { kind: "check", at: Date.now() });
      return void (await ctx.reply("Send me the address or <code>@handle</code> to check.", { parse_mode: "HTML" }));
    }
    const v = await busy(ctx, () => checkView(lk, ctx.chat.id, a));
    if (v) await reply(ctx, v);
  });
  bot.command("tx", async (ctx) => {
    const a = args(ctx);
    if (!a) {
      pending.set(ctx.chat.id, { kind: "tx", at: Date.now() });
      return void (await ctx.reply("Send me the transaction hash (Cosmos hash or EVM <code>0x…</code> hash).", { parse_mode: "HTML" }));
    }
    const l = classify(a);
    if (l.kind !== "tx") return void (await ctx.reply("That is not a transaction hash."));
    const v = await busy(ctx, () => txView(lk, ctx.chat.id, l.hash));
    if (v) await reply(ctx, v);
  });
  bot.command("history", async (ctx) => {
    let a = args(ctx);
    if (!a) a = store.watches(ctx.chat.id).find((w) => w.owned)?.address ?? "";
    if (!a) return void (await ctx.reply("Use: /history <code>address</code>", { parse_mode: "HTML" }));
    const v = await busy(ctx, () => historyView(lk, ctx.chat.id, a));
    if (v) await reply(ctx, v);
  });

  // ---- settings -----------------------------------------------------------------------------------------------
  bot.command("settings", (ctx) => reply(ctx, settings(chatOf(ctx))));
  async function setQuiet(ctx: Context, input: string) {
    if (!(await canEdit(ctx))) return;
    const s = input.trim().toLowerCase();
    if (s === "off" || s === "none") {
      store.updateChat(ctx.chat!.id, { quietStart: null, quietEnd: null });
      return void (await ctx.reply("Quiet hours are off."));
    }
    const m = /^(\S+)\s*(?:-|to|–)\s*(\S+)$/.exec(s);
    const a = m ? parseClock(m[1]!) : undefined;
    const b = m ? parseClock(m[2]!) : undefined;
    if (a === undefined || b === undefined || a === b) return void (await ctx.reply("Use: /quiet <code>23:00-07:00</code> or /quiet <code>off</code>", { parse_mode: "HTML" }));
    store.updateChat(ctx.chat!.id, { quietStart: a, quietEnd: b });
    const c = store.chat(ctx.chat!.id)!;
    await ctx.reply(`🌙 Quiet hours: <b>${clock(a)} to ${clock(b)}</b> (${esc(c.tz)}). Money and activity alerts wait until the morning; security warnings still come through.`, { parse_mode: "HTML" });
  }
  bot.command("quiet", async (ctx) => {
    const a = args(ctx);
    if (!a) {
      pending.set(ctx.chat.id, { kind: "quiet", at: Date.now() });
      return void (await ctx.reply("Send quiet hours like <code>23:00-07:00</code>, or <code>off</code>.", { parse_mode: "HTML" }));
    }
    await setQuiet(ctx, a);
  });
  async function setTz(ctx: Context, input: string) {
    if (!(await canEdit(ctx))) return;
    const tz = resolveTimeZone(input);
    if (!tz) return void (await ctx.reply("I don't know that time zone. Try a city like <code>Africa/Lagos</code>, <code>Europe/London</code>, or <code>UTC+1</code>.", { parse_mode: "HTML" }));
    store.updateChat(ctx.chat!.id, { tz });
    const now = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
    await ctx.reply(`🕰 Time zone set to <b>${esc(tz)}</b>. It is ${now} there now.`, { parse_mode: "HTML" });
  }
  bot.command(["timezone", "tz"], async (ctx) => {
    const a = args(ctx);
    if (!a) {
      pending.set(ctx.chat.id, { kind: "tz", at: Date.now() });
      return void (await ctx.reply("Send your time zone, like <code>Africa/Lagos</code> or <code>UTC+1</code>.", { parse_mode: "HTML" }));
    }
    await setTz(ctx, a);
  });
  async function setThreshold(ctx: Context, address: string, amount: string) {
    if (!(await canEdit(ctx))) return;
    if (!store.watch(ctx.chat!.id, address)) return void (await ctx.reply("Watch that address first with /watch."));
    let v: bigint;
    try {
      v = parseUnits(amount.replace(/qor$/i, "").trim() || "0", 6);
    } catch {
      return void (await ctx.reply("Send an amount in QOR, like <code>100</code> or <code>0.5</code> (0 for every amount).", { parse_mode: "HTML" }));
    }
    store.updateWatch(ctx.chat!.id, address, { minUqor: v });
    await ctx.reply(v === 0n ? "Money alerts: every amount." : `💰 Money alerts only from <b>${formatUnits(v, 6)} QOR</b> (security alerts are never filtered).`, { parse_mode: "HTML" });
  }
  bot.command("threshold", async (ctx) => {
    const parts = args(ctx).split(/\s+/).filter(Boolean);
    const watches = store.watches(ctx.chat.id);
    if (parts.length === 1 && watches.length === 1) return setThreshold(ctx, watches[0]!.address, parts[0]!);
    if (parts.length < 2) return void (await ctx.reply("Use: /threshold <code>address amount</code>, e.g. /threshold qor1… 100", { parse_mode: "HTML" }));
    const r = await resolveAddress(lk, parts[0]!);
    if ("error" in r) return void (await ctx.reply(r.error, { parse_mode: "HTML" }));
    await setThreshold(ctx, r.address, parts.slice(1).join(" "));
  });
  for (const [cmd, cat] of [
    ["mute", true],
    ["unmute", false],
  ] as const) {
    bot.command(cmd, async (ctx) => {
      const a = args(ctx).toLowerCase();
      if (!a || !(CATEGORIES as readonly string[]).includes(a)) return reply(ctx, muteMenu("chat", chatOf(ctx).muted));
      if (!(await canEdit(ctx))) return;
      const muted = new Set(chatOf(ctx).muted);
      if (cat) muted.add(a);
      else muted.delete(a);
      store.updateChat(ctx.chat.id, { muted: [...muted] });
      await ctx.reply(`${cat ? "🔕 Muted" : "🔔 Unmuted"} ${a}.`);
    });
  }
  async function setDigest(ctx: Context, input: string) {
    const s = input.trim().toLowerCase();
    if (s === "now") {
      if (!hooks.digest) return void (await ctx.reply("The digest is not available right now."));
      const v = await busy(ctx, () => hooks.digest!(ctx.chat!.id));
      if (v) await reply(ctx, v);
      return;
    }
    if (!(await canEdit(ctx))) return;
    if (s === "off") {
      store.updateChat(ctx.chat!.id, { digestMinute: null });
      return void (await ctx.reply("Daily digest is off."));
    }
    const m = parseClock(s);
    if (m === undefined) return void (await ctx.reply("Use: /digest <code>08:00</code>, /digest <code>off</code> or /digest <code>now</code>", { parse_mode: "HTML" }));
    store.updateChat(ctx.chat!.id, { digestMinute: m });
    await ctx.reply(`📰 Daily digest at <b>${clock(m)}</b> (${esc(chatOf(ctx).tz)}): balances, what changed, open windows and rewards waiting.`, { parse_mode: "HTML" });
  }
  bot.command("digest", async (ctx) => {
    const a = args(ctx);
    if (!a) {
      pending.set(ctx.chat.id, { kind: "digest", at: Date.now() });
      return void (await ctx.reply("Send a time like <code>08:00</code>, <code>off</code>, or <code>now</code> for a digest right away.", { parse_mode: "HTML" }));
    }
    await setDigest(ctx, a);
  });
  bot.command("pause", async (ctx) => {
    if (!(await canEdit(ctx))) return;
    store.updateChat(ctx.chat.id, { paused: true });
    await ctx.reply("⏸ Alerts paused. Critical security alerts still come through. /resume to turn them back on.");
  });
  bot.command("resume", async (ctx) => {
    if (!(await canEdit(ctx))) return;
    store.updateChat(ctx.chat.id, { paused: false });
    await ctx.reply("▶️ Alerts are on.");
  });

  // ---- market and network -------------------------------------------------------------------------------------
  bot.command("pools", async (ctx) => {
    if (!hooks.pools) return void (await ctx.reply("Pools are not available right now."));
    const list = await busy(ctx, () => hooks.pools!());
    if (!list) return;
    const mine = new Map(store.poolWatches(ctx.chat.id).map((p) => [p.poolId, p.pct]));
    await reply(ctx, {
      html: ["💱 <b>QoreChain swap pools</b>", "", ...list.map((p) => `<b>#${esc(p.id)}</b> ${esc(p.name)}: ${esc(p.priceText)}${mine.has(p.id) ? ` · 🔔 ±${mine.get(p.id)}%` : ""}`), "", "Get an alert when a price moves: /pricealert <code>pool percent</code>, e.g. /pricealert 2 5"].join("\n"),
    });
  });
  bot.command("pricealert", async (ctx) => {
    const [id, pctText] = args(ctx).split(/\s+/);
    if (!id) return void (await ctx.reply("Use: /pricealert <code>pool percent</code> (e.g. /pricealert 2 5), or /pricealert <code>pool off</code>.", { parse_mode: "HTML" }));
    if (!(await canEdit(ctx))) return;
    const poolId = id.replace(/^#/, "");
    if (pctText?.toLowerCase() === "off") return void (await ctx.reply(store.removePoolWatch(ctx.chat.id, poolId) ? "Price alert removed." : "No price alert on that pool."));
    const pct = Number(pctText);
    if (!Number.isFinite(pct) || pct < 0.5 || pct > 90) return void (await ctx.reply("Pick a move between 0.5 and 90 percent."));
    const list = hooks.pools ? await busy(ctx, () => hooks.pools!()) : undefined;
    const p = list?.find((x) => x.id === poolId);
    if (!p) return void (await ctx.reply("I don't know that pool. See /pools."));
    if (p.thin) return void (await ctx.reply("That pool has too little liquidity for a meaningful price, so I can't alert on it."));
    store.setPoolWatch(ctx.chat.id, poolId, pct, p.price);
    await ctx.reply(`🔔 I'll alert you when pool #${esc(poolId)} (${esc(p.name)}) moves ${pct}% from ${esc(p.priceText)}.`, { parse_mode: "HTML" });
  });
  bot.command("proposals", async (ctx) => {
    if (!hooks.proposals) return void (await ctx.reply("Governance is not available right now."));
    const v = await busy(ctx, () => hooks.proposals!());
    if (v) await reply(ctx, v);
  });
  bot.command("attest", async (ctx) => {
    if (!config.attestContract) return void (await ctx.reply("On-chain attestations are not set up on this deployment yet."));
    const own = store.watches(ctx.chat.id).find((w) => w.owned);
    if (!own) return void (await ctx.reply("Link your wallet first with /link, then attest that you checked it."));
    const report = await busy(ctx, () => runCheck(lk, own.address));
    if (!report) return;
    const code = store.createCode(ctx.chat.id, "attest");
    await reply(ctx, {
      html: [
        "📜 <b>Attest your account check</b>",
        "",
        `Your account scores <b>${report.score}</b>/100 right now. Attesting records on QoreChain, signed by you through QoreX, that you checked it today and what it scored.`,
        "Anyone can verify it later, which is useful for teams and treasuries.",
      ].join("\n"),
      buttons: [[{ text: "Open the attest page", url: pages(config.publicUrl).attest(code) }]],
    });
  });
  bot.command("status", async (ctx) => {
    const s = hooks.status?.();
    const stats = store.stats();
    await ctx.reply(
      [
        "📡 <b>QoreWatch status</b>",
        `Network: QoreChain ${config.network} (${esc(chain.cfg.chainId)})`,
        s?.height ? `Last block checked: ${s.height.toLocaleString("en-US")}` : "Block watcher: starting",
        s?.chainHeight ? `Chain height: ${s.chainHeight.toLocaleString("en-US")}${s.lagBlocks !== undefined ? ` (${s.lagBlocks <= 3 ? "in sync" : `${s.lagBlocks} blocks behind`})` : ""}` : "",
        `Watching ${stats.addresses} address${stats.addresses === 1 ? "" : "es"} for ${stats.chats} chat${stats.chats === 1 ? "" : "s"}`,
        s?.lastError ? `Last node error: ${esc(s.lastError.slice(0, 120))}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      { parse_mode: "HTML" },
    );
  });
  bot.command("privacy", (ctx) =>
    reply(ctx, {
      html: [
        "🔒 <b>What QoreWatch stores</b>",
        "",
        "• This chat's id, type and title (for groups).",
        "• The addresses you watch, their labels and alert settings.",
        "• Which alerts were already sent (for 14 days), so you never get one twice.",
        "• Alerts held during quiet hours, until they are delivered.",
        "",
        "It never stores your name, phone number, messages or any key. Linking proves ownership with an on-chain signature; the bot holds no wallet.",
        "",
        "/forget deletes everything about this chat.",
      ].join("\n"),
    }),
  );
  bot.command("forget", async (ctx) => {
    if (!(await canEdit(ctx))) return;
    await reply(ctx, { html: "Delete every address, setting and pending alert for this chat?", buttons: [[{ text: "Yes, delete everything", data: "fg:yes" }, { text: "Cancel", data: "fg:no" }]] });
  });

  // ---- buttons -----------------------------------------------------------------------------------------------
  bot.on("callback_query:data", async (ctx) => {
    const d = ctx.callbackQuery.data;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return void (await ctx.answerCallbackQuery());
    const chat = chatOf(ctx);
    const answer = (text?: string) => ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => undefined);
    const [k, sub, ...rest] = d.split(":");
    const arg = [sub, ...rest].join(":");
    try {
      switch (k) {
        case "menu":
          await answer();
          if (sub === "home") return edit(ctx, { html: "What would you like to do?", buttons: MAIN_MENU });
          if (sub === "help") return edit(ctx, help());
          if (sub === "list") return edit(ctx, watchList(store.watches(chatId), chat));
          if (sub === "settings") return edit(ctx, settings(chat));
          if (sub === "link") return startLink(ctx);
          if (sub === "watch") {
            pending.set(chatId, { kind: "watch", at: Date.now() });
            return void (await ctx.reply("Send me the address to watch (<code>qor1…</code>, <code>0x…</code> or <code>@handle</code>), optionally followed by a label.", { parse_mode: "HTML" }));
          }
          if (sub === "check") {
            pending.set(chatId, { kind: "check", at: Date.now() });
            return void (await ctx.reply("Send me the address or <code>@handle</code> to check.", { parse_mode: "HTML" }));
          }
          return;
        case "c": {
          await answer("Checking…");
          const v = await busy(ctx, () => checkView(lk, chatId, arg));
          if (v) await reply(ctx, v);
          return;
        }
        case "h": {
          await answer("Loading…");
          const v = await busy(ctx, () => historyView(lk, chatId, arg));
          if (v) await reply(ctx, v);
          return;
        }
        case "watch":
          await answer();
          return addWatch(ctx, arg);
        case "card": {
          await answer("Drawing your card…");
          if (!hooks.card || !messenger.sendPhoto) return;
          const png = await busy(ctx, () => hooks.card!(arg));
          if (png) await messenger.sendPhoto(chatId, png, `🛡 Post-quantum check of <code>${esc(shortAddress(arg, 10, 6))}</code> by @${esc(config.botUsername)}`);
          return;
        }
        case "w": {
          const action = sub;
          // w:mt:<address>:<category index>; every other action is w:<action>:<address>.
          const address = action === "mt" ? rest.slice(0, -1).join(":") : rest.join(":");
          const w = store.watch(chatId, address);
          if (!w) return void (await answer("No longer watched."));
          if (action === "o") {
            await answer();
            return edit(ctx, watchDetail(w));
          }
          if (!(await canEdit(ctx))) return void (await answer());
          if (action === "rm") {
            await answer();
            return edit(ctx, { html: `Stop watching ${w.label ? `<b>${esc(w.label)}</b>` : `<code>${esc(shortAddress(address, 10, 6))}</code>`}?`, buttons: [[{ text: "Yes, stop", data: `w:rmy:${address}` }, { text: "Cancel", data: `w:o:${address}` }]] });
          }
          if (action === "rmy") {
            store.removeWatch(chatId, address);
            await answer("Removed");
            return edit(ctx, watchList(store.watches(chatId), chat));
          }
          if (action === "lb" || action === "th") {
            await answer();
            pending.set(chatId, { kind: action === "lb" ? "label" : "threshold", address, at: Date.now() });
            return void (await ctx.reply(action === "lb" ? "Send the new label (up to 40 characters), or <code>-</code> to remove it." : "Send the minimum amount in QOR for money alerts (0 for every amount).", { parse_mode: "HTML" }));
          }
          if (action === "mm") {
            await answer();
            return edit(ctx, muteMenu(address, w.muted));
          }
          if (action === "mt") {
            const cat = CATEGORIES[Number(rest.at(-1))];
            if (!cat) return void (await answer());
            const muted = new Set(w.muted);
            if (muted.has(cat)) muted.delete(cat);
            else muted.add(cat);
            store.updateWatch(chatId, address, { muted: [...muted] });
            await answer(muted.has(cat) ? "Muted" : "Unmuted");
            return edit(ctx, muteMenu(address, [...muted]));
          }
          return void (await answer());
        }
        case "s": {
          if (sub !== "cats" && !(await canEdit(ctx))) return void (await answer());
          await answer();
          if (sub === "cats") return edit(ctx, muteMenu("chat", chat.muted));
          if (sub === "mute") {
            const cat = CATEGORIES[Number(rest[0])];
            if (!cat) return;
            const muted = new Set(chat.muted);
            if (muted.has(cat)) muted.delete(cat);
            else muted.add(cat);
            store.updateChat(chatId, { muted: [...muted] });
            return edit(ctx, muteMenu("chat", [...muted]));
          }
          if (sub === "pause") {
            store.updateChat(chatId, { paused: !chat.paused });
            return edit(ctx, settings(store.chat(chatId)!));
          }
          if (sub === "net") {
            store.updateChat(chatId, { networkAlerts: !chat.networkAlerts });
            return edit(ctx, settings(store.chat(chatId)!));
          }
          const prompts: Record<string, [Pending["kind"], string]> = {
            quiet: ["quiet", "Send quiet hours like <code>23:00-07:00</code>, or <code>off</code>."],
            tz: ["tz", "Send your time zone, like <code>Africa/Lagos</code> or <code>UTC+1</code>."],
            digest: ["digest", "Send a time for the daily digest like <code>08:00</code>, or <code>off</code>."],
          };
          const p = prompts[sub ?? ""];
          if (p) {
            pending.set(chatId, { kind: p[0], at: Date.now() });
            return void (await ctx.reply(p[1], { parse_mode: "HTML" }));
          }
          return;
        }
        case "fg":
          await answer();
          if (sub === "yes") {
            if (!(await canEdit(ctx))) return;
            store.forgetChat(chatId);
            return edit(ctx, { html: "🗑 Done. Everything about this chat is deleted. /start to begin again." });
          }
          return edit(ctx, { html: "Nothing was deleted." });
        default:
          return void (await answer());
      }
    } catch (e) {
      log.warn("button failed", { chat: chatId, error: (e as Error).message });
      await answer("Something went wrong, try again.");
    }
  });

  // ---- free text: answers to prompts, or "is this safe?" ----------------------------------------------------------
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return void (await ctx.reply("I don't know that command. /help lists them all."));
    const p = pending.get(ctx.chat.id);
    if (p) {
      pending.delete(ctx.chat.id);
      switch (p.kind) {
        case "watch":
          return addWatch(ctx, text);
        case "check": {
          const v = await busy(ctx, () => checkView(lk, ctx.chat.id, text));
          if (v) await reply(ctx, v);
          return;
        }
        case "tx": {
          const l = classify(text);
          if (l.kind !== "tx") return void (await ctx.reply("That is not a transaction hash."));
          const v = await busy(ctx, () => txView(lk, ctx.chat.id, l.hash));
          if (v) await reply(ctx, v);
          return;
        }
        case "label":
          if (!(await canEdit(ctx))) return;
          store.updateWatch(ctx.chat.id, p.address!, { label: text.trim() === "-" ? null : text.trim().slice(0, 40) });
          return reply(ctx, watchDetail(store.watch(ctx.chat.id, p.address!)!));
        case "threshold":
          return setThreshold(ctx, p.address!, text);
        case "quiet":
          return setQuiet(ctx, text);
        case "tz":
          return setTz(ctx, text);
        case "digest":
          return setDigest(ctx, text);
      }
    }
    // In groups only react to things addressed to the bot.
    if (isGroup(ctx)) return;
    const found = findLookups(text);
    if (!found.length) return reply(ctx, { html: "Send me an address, a <code>@handle</code> or a transaction hash and I'll tell you what it is, or use the menu.", buttons: MAIN_MENU });
    for (const l of found.slice(0, 3)) {
      const v = await busy(ctx, () => safetyView(lk, ctx.chat.id, l));
      if (v) await reply(ctx, v);
    }
  });

  return { bot, messenger };
}

export type { Button };
