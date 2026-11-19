import { esc, shortAddress } from "@qorewatch/core";
import type { Alert } from "./types.js";
import type { Watch } from "../db/store.js";

/** The full Telegram HTML of an alert for one chat. */
export function renderAlert(alert: Alert, watch?: Watch): string {
  const who = watch ? `${watch.label ? `<b>${esc(watch.label)}</b> · ` : ""}<code>${esc(shortAddress(watch.address, 10, 6))}</code>${watch.owned ? " ✓" : ""}` : "";
  const lines = [alert.title, ...(who ? [who] : []), "", ...alert.body];
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
