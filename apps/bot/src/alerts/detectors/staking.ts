import type { Alert, TxDetector } from "../types.js";
import { detailsButton, keyOf, said } from "./util.js";

/** Staking moves of the watched account. Unbonding completion is scheduled by the watcher. */
export const stakingDetector: TxDetector = {
  id: "staking",
  async detect(tx, ctx) {
    if (tx.failed) return [];
    const a = ctx.watch.address;
    const out: Alert[] = [];
    const titles: Partial<Record<string, string>> = { delegate: "🥩 <b>Staked</b>", unbond: "⏳ <b>Unstaking started</b>", redelegate: "🔁 <b>Stake moved</b>", rewards: "🎁 <b>Rewards claimed</b>", tier_lock: "🔒 <b>Stake locked</b>" };
    let n = 0;
    for (const ev of tx.events) {
      const title = titles[ev.kind];
      if (!title) continue;
      const mine = (ev.kind === "delegate" || ev.kind === "unbond" || ev.kind === "rewards" || ev.kind === "tier_lock" ? ev.delegator : ev.kind === "redelegate" ? ev.delegator : undefined) === a;
      if (!mine) continue;
      if ((ev.kind === "rewards" || ev.kind === "delegate") && ev.amount.every((c) => c.amount === 0n)) continue;
      out.push({ key: keyOf(tx, "staking", a, `${ev.kind}${n++}`), category: "staking", level: "info", address: a, title, body: [await said(ev, ctx)], buttons: [[detailsButton(ctx, tx)]], txHash: tx.hash });
    }
    return out.slice(0, 4);
  },
};
