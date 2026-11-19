import type { Alert, TxDetector } from "../types.js";
import { detailsButton, keyOf, said } from "./util.js";

/** Votes and deposits by the watched account. New proposals reach every chat through the governance job. */
export const governanceDetector: TxDetector = {
  id: "governance",
  async detect(tx, ctx) {
    if (tx.failed) return [];
    const a = ctx.watch.address;
    const out: Alert[] = [];
    for (const ev of tx.events) {
      if (ev.kind === "vote" && ev.voter === a)
        out.push({ key: keyOf(tx, "gov", a, `vote${ev.proposalId}`), category: "governance", level: "info", address: a, title: "🗳 <b>Vote recorded</b>", body: [await said(ev, ctx)], buttons: [[detailsButton(ctx, tx)]], txHash: tx.hash });
      if (ev.kind === "deposit" && ev.depositor === a)
        out.push({ key: keyOf(tx, "gov", a, `dep${ev.proposalId}`), category: "governance", level: "info", address: a, title: "🗳 <b>Proposal deposit</b>", body: [await said(ev, ctx)], buttons: [[detailsButton(ctx, tx)]], txHash: tx.hash });
    }
    return out;
  },
};
