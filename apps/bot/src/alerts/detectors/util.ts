import { esc, explainEvent, FEE_COLLECTOR, moduleAccount, shortAddress, type ChainEvent, type TxRecord } from "@qorewatch/core";
import type { Alert, Button, DetectContext } from "../types.js";
import { pages } from "../../links.js";

/** The "Details" button every transaction alert carries. */
export const detailsButton = (ctx: DetectContext, tx: TxRecord): Button => ({ text: "🔎 Details", url: pages(ctx.publicUrl).tx(tx.hash) });

/** A stable de-duplication key: one alert per transaction, detector and address (and an optional part). */
export const keyOf = (tx: TxRecord, detector: string, address: string, part = "") => `tx:${tx.hash}:${detector}:${address}${part ? `:${part}` : ""}`;

export const said = (ev: ChainEvent, ctx: DetectContext) => explainEvent(ev, ctx.explain);

/** How the watched address is called in titles: "your account" when linked, otherwise its label or short address. */
export const subject = (ctx: DetectContext) => (ctx.watch.owned ? "your account" : ctx.watch.label ? esc(ctx.watch.label) : `<code>${esc(shortAddress(ctx.watch.address, 8, 4))}</code>`);

/** Net flow of each denom for an address in a transaction, ignoring fees, refunds and module plumbing. */
export function netFlows(tx: TxRecord, address: string): Map<string, bigint> {
  const net = new Map<string, bigint>();
  for (const e of tx.events) {
    if (e.kind !== "transfer") continue;
    if (e.to === FEE_COLLECTOR || e.from === FEE_COLLECTOR) continue;
    for (const c of e.coins) {
      if (e.to === address) net.set(c.denom, (net.get(c.denom) ?? 0n) + c.amount);
      if (e.from === address) net.set(c.denom, (net.get(c.denom) ?? 0n) - c.amount);
    }
  }
  for (const [k, v] of net) if (v === 0n) net.delete(k);
  return net;
}

/** The other side of a transfer: the EVM counterparty when there is one, else the non-module peer. */
export function counterparty(tx: TxRecord, address: string, incoming: boolean): string | undefined {
  const evm = tx.events.find((e) => e.kind === "evm_tx");
  if (evm && evm.kind === "evm_tx") {
    const other = incoming ? evm.from : evm.to;
    if (other) return other;
  }
  for (const e of tx.events) {
    if (e.kind !== "transfer") continue;
    if (incoming && e.to === address && !moduleAccount(e.from)) return e.from;
    if (!incoming && e.from === address && !moduleAccount(e.to)) return e.to;
  }
  for (const e of tx.events) {
    if (e.kind !== "transfer") continue;
    if (incoming && e.to === address) return e.from;
    if (!incoming && e.from === address) return e.to;
  }
  return undefined;
}

export type { Alert };
