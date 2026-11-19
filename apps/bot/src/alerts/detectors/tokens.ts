import { esc, explainTokenLog, qorToEvm, who } from "@qorewatch/core";
import type { Alert, LogDetector } from "../types.js";
import { pages } from "../../links.js";
import { subject } from "./util.js";

/**
 * EVM token events for a watched account: ERC-20 tokens in and out (fUSD, fBTC, …),
 * new allowances (unlimited ones are warnings, with a one-tap revoke), and
 * collection-wide NFT approvals.
 */
export const tokenDetector: LogDetector = {
  id: "tokens",
  async detect(log, ctx) {
    const a = ctx.watch.address;
    let evm: string;
    try {
      evm = qorToEvm(a);
    } catch {
      return [];
    }
    const key = `log:${log.txHash}:${log.logIndex}:${a}`;
    const details = [{ text: "🔎 Transaction", url: `${ctx.explorer}/tx/${log.txHash}` }];
    if (log.kind === "token_transfer" && (log.to === evm || log.from === evm) && log.to !== log.from) {
      const incoming = log.to === evm;
      const value = await ctx.explain.tokens.format(log.value, log.token);
      const peer = incoming ? log.from : log.to;
      const minted = /^0x0{40}$/.test(peer);
      return [
        {
          key,
          category: "money",
          level: "info",
          address: a,
          title: incoming ? `💸 <b>Received ${esc(value)}</b>` : `📤 <b>Sent ${esc(value)}</b>`,
          body: [incoming ? (minted ? `<b>${esc(value)}</b> was minted to ${subject(ctx)}.` : `${who(peer, ctx.explain)} sent <b>${esc(value)}</b> to ${subject(ctx)}.`) : `<b>${esc(value)}</b> left ${subject(ctx)}, to ${who(peer, ctx.explain)}.`],
          buttons: [details],
        } satisfies Alert,
      ];
    }
    if (log.kind === "token_approval" && log.owner === evm) {
      const revoked = log.value === 0n;
      return [
        {
          key,
          category: "security",
          level: revoked ? "info" : log.unlimited ? "warning" : "info",
          address: a,
          title: revoked ? "✅ <b>Token permission removed</b>" : log.unlimited ? `🗝 <b>Unlimited token approval on ${subject(ctx)}</b>` : "🗝 <b>Token approval</b>",
          body: [await explainTokenLog(log, ctx.explain), ...(revoked ? [] : ["The spender can move these tokens without asking again. Revoke it if you don't recognise it."])],
          buttons: revoked ? [details] : [[{ text: "🛠 Revoke this approval", url: pages(ctx.publicUrl).fixApproval(evm, log.token, log.spender) }], details],
        } satisfies Alert,
      ];
    }
    if (log.kind === "nft_approval_all" && log.owner === evm) {
      return [
        {
          key,
          category: "security",
          level: log.approved ? "warning" : "info",
          address: a,
          title: log.approved ? "🗝 <b>Collection-wide approval</b>" : "✅ <b>Collection approval removed</b>",
          body: [await explainTokenLog(log, ctx.explain)],
          buttons: [details],
        } satisfies Alert,
      ];
    }
    return [];
  },
};
