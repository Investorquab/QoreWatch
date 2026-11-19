import { addressesOf, esc, who } from "@qorewatch/core";
import type { TxDetector } from "../types.js";
import { counterparty, detailsButton, keyOf, netFlows, subject } from "./util.js";

/** Kinds that already explain money moving (they have their own alerts). */
const EXPLAINED = new Set(["swap", "liquidity", "delegate", "unbond", "redelegate", "rewards", "tier_lock", "deposit"]);

/**
 * Money in and out of a watched address, on both lanes: native transfers and EVM value
 * transfers (which pass through the EVM module). Fees and gas refunds are left out.
 */
export const moneyDetector: TxDetector = {
  id: "money",
  async detect(tx, ctx) {
    if (tx.failed) return [];
    const a = ctx.watch.address;
    if (tx.events.some((e) => EXPLAINED.has(e.kind) && addressesOf(e).includes(a))) return [];
    const flows = netFlows(tx, a);
    const out = [];
    for (const [denom, amount] of flows) {
      const incoming = amount > 0n;
      const abs = incoming ? amount : -amount;
      const peer = counterparty(tx, a, incoming);
      const value = await ctx.explain.tokens.format(abs, denom);
      const peerText = peer ? who(peer, ctx.explain) : "someone";
      out.push({
        key: keyOf(tx, "money", a, denom),
        category: "money" as const,
        level: "info" as const,
        address: a,
        ...(denom === "uqor" ? { amountUqor: abs } : {}),
        title: incoming ? `💸 <b>Received ${esc(value)}</b>` : `📤 <b>Sent ${esc(value)}</b>`,
        body: [
          incoming ? `${subject(ctx) === "your account" ? "You" : subject(ctx)} received <b>${esc(value)}</b> from ${peerText}.` : `<b>${esc(value)}</b> left ${subject(ctx)}, to ${peerText}.`,
          ...(tx.memo ? [`Note: “${esc(tx.memo.slice(0, 160))}”`] : []),
        ],
        buttons: [[detailsButton(ctx, tx)]],
        txHash: tx.hash,
      });
    }
    return out;
  },
};
