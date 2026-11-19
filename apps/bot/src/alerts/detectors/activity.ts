import { esc, explainTx, type TxRecord } from "@qorewatch/core";
import type { Alert, TxDetector } from "../types.js";
import { detailsButton, keyOf, said, subject } from "./util.js";

/**
 * What the watched account itself did beyond plain transfers: failed transactions,
 * swaps, pool liquidity and contract calls.
 */
export const activityDetector: TxDetector = {
  id: "activity",
  async detect(tx: TxRecord, ctx) {
    const a = ctx.watch.address;
    const out: Alert[] = [];
    if (tx.failed && tx.signer === a) {
      const e = await explainTx(tx, ctx.explain);
      out.push({
        key: keyOf(tx, "activity", a, "failed"),
        category: "activity",
        level: "warning",
        address: a,
        title: `❌ <b>A transaction from ${subject(ctx)} failed</b>`,
        body: [esc(tx.failReason ?? "The chain refused it."), ...e.lines.slice(0, 2), "If you didn't send it, an app or someone with access is trying things with this account."],
        buttons: [[detailsButton(ctx, tx)]],
        txHash: tx.hash,
      });
      return out;
    }
    if (tx.failed) return out;
    for (const ev of tx.events) {
      if ((ev.kind === "swap" || ev.kind === "liquidity") && ev.sender === a)
        out.push({ key: keyOf(tx, "activity", a, `${ev.kind}${ev.poolId}`), category: "activity", level: "info", address: a, title: ev.kind === "swap" ? "🔄 <b>Swap</b>" : "💧 <b>Pool liquidity</b>", body: [await said(ev, ctx)], buttons: [[detailsButton(ctx, tx)]], txHash: tx.hash });
      if (ev.kind === "wasm" && ev.sender === a)
        out.push({ key: keyOf(tx, "activity", a, `wasm${ev.contract}`), category: "activity", level: "info", address: a, title: "📜 <b>Contract call</b>", body: [await said(ev, ctx)], buttons: [[detailsButton(ctx, tx)]], txHash: tx.hash });
      if (ev.kind === "crossvm" && ev.sender === a)
        out.push({ key: keyOf(tx, "activity", a, "crossvm"), category: "activity", level: "info", address: a, title: "🔀 <b>Cross-VM call</b>", body: [await said(ev, ctx)], buttons: [[detailsButton(ctx, tx)]], txHash: tx.hash });
    }
    return out;
  },
};
