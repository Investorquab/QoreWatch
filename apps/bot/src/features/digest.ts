import { esc, formatUnits, shortAddress, type Coin } from "@qorewatch/core";
import type { Chain } from "../chain.js";
import type { Store } from "../db/store.js";
import type { View } from "../telegram/views.js";
import { balancesText } from "../telegram/views.js";
import { duration, qor } from "@qorewatch/core";

/** Per chat and address, the balances at the previous digest, to say what changed. */
const snapKey = (chatId: number, address: string) => `snap:${chatId}:${address}`;

/**
 * The daily digest: for each watched address, balances and what changed since the last
 * digest, an open spending window, rewards waiting and unstaking in progress.
 */
export async function buildDigest(chatId: number, store: Store, chain: Chain, update = true): Promise<View> {
  const watches = store.watches(chatId);
  if (!watches.length) return { html: "📰 <b>Daily digest</b>\n\nYou are not watching any address yet. /link or /watch to start." };
  const lines = ["📰 <b>Your QoreWatch digest</b>", ""];
  for (const w of watches.slice(0, 10)) {
    const [bal, win, rewards, unb] = await Promise.all([
      chain.rest.balances(w.address).catch(() => [] as Coin[]),
      chain.rest.evmWindow(w.address).catch(() => undefined),
      chain.rest.rewards(w.address).catch(() => [] as Coin[]),
      chain.rest.unbondings(w.address).catch(() => []),
    ]);
    lines.push(`${w.owned ? "✅" : "👁"} ${w.label ? `<b>${esc(w.label)}</b> · ` : ""}<code>${esc(shortAddress(w.address, 10, 6))}</code>`);
    lines.push(`Balance: ${(await balancesText(bal, chain.tokens)) || "empty"}`);
    const prevRaw = store.get(snapKey(chatId, w.address));
    if (prevRaw) {
      const prev = new Map((JSON.parse(prevRaw) as { d: string; a: string }[]).map((c) => [c.d, BigInt(c.a)]));
      const now = new Map(bal.map((c) => [c.denom, c.amount]));
      const changes: string[] = [];
      for (const d of new Set([...prev.keys(), ...now.keys()])) {
        const diff = (now.get(d) ?? 0n) - (prev.get(d) ?? 0n);
        if (diff === 0n) continue;
        const t = await chain.tokens.get(d);
        changes.push(`${diff > 0n ? "+" : "−"}${formatUnits(diff > 0n ? diff : -diff, t.decimals)} ${esc(t.symbol)}`);
      }
      lines.push(changes.length ? `Since last digest: ${changes.join(", ")}` : "No change since the last digest.");
    }
    if (win?.live) lines.push(`🪟 A spending window is open: ${win.remainingTxs ?? "?"} transactions and ${win.remainingValueUqor !== undefined ? qor(win.remainingValueUqor) : "?"} left, about ${duration(win.remainingBlocks ?? 0, chain.cfg.blockSeconds)}.`);
    const r = rewards.find((c) => c.denom === "uqor");
    if (r && r.amount > 10_000n) lines.push(`🎁 Staking rewards waiting: ${qor(r.amount)}`);
    for (const u of unb.slice(0, 2)) lines.push(`⏳ Unstaking ${qor(u.balance)}, released ${u.completionTime.slice(0, 10)}`);
    lines.push("");
    if (update) store.set(snapKey(chatId, w.address), JSON.stringify(bal.map((c) => ({ d: c.denom, a: c.amount.toString() }))));
  }
  if (watches.length > 10) lines.push(`…and ${watches.length - 10} more addresses.`);
  return { html: lines.join("\n").trim() };
}
