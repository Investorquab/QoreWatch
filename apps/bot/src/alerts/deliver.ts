import type { Chat, Store, Watch } from "../db/store.js";
import type { Messenger } from "../telegram/messenger.js";
import { fitMessage } from "../telegram/messenger.js";
import type { Logger } from "../log.js";
import { inWindow, localMinute } from "./time.js";
import { renderAlert } from "./render.js";
import type { Alert } from "./types.js";

export type Outcome = "sent" | "held" | "duplicate" | "muted" | "below_threshold" | "paused" | "failed" | "blocked";

/**
 * Decide whether and how one alert reaches one chat, then send it.
 * Order: duplicate → paused → muted → threshold → quiet hours → send.
 * Critical alerts ignore pause, mutes, thresholds and quiet hours.
 * Warnings ignore quiet hours. Info alerts in quiet hours are held and sent afterwards.
 */
export class Deliverer {
  constructor(
    private readonly store: Store,
    private readonly messenger: Messenger,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async deliver(chat: Chat, alert: Alert, watch?: Watch): Promise<Outcome> {
    const critical = alert.level === "critical";
    if (!critical) {
      if (chat.paused) return "paused";
      if (chat.muted.includes(alert.category) || watch?.muted.includes(alert.category)) return "muted";
      if (alert.category === "money" && watch && alert.amountUqor !== undefined && alert.amountUqor < watch.minUqor) return "below_threshold";
    }
    if (!this.store.markSent(chat.id, alert.key, this.now().getTime())) return "duplicate";
    const html = fitMessage(renderAlert(alert, watch));
    if (alert.level === "info" && chat.quietStart !== null && chat.quietEnd !== null && inWindow(localMinute(chat.tz, this.now()), chat.quietStart, chat.quietEnd)) {
      this.store.hold(chat.id, html, this.now().getTime());
      return "held";
    }
    const r = await this.messenger.send(chat.id, html, alert.buttons);
    if (r.ok) return "sent";
    if (r.blocked) {
      this.log.info("chat unreachable, pausing it", { chat: chat.id });
      this.store.updateChat(chat.id, { paused: true });
      return "blocked";
    }
    this.log.warn("alert send failed", { chat: chat.id, error: r.error });
    return "failed";
  }

  /** After quiet hours: send what was held, as one summary message per chat. */
  async flushHeld(): Promise<number> {
    let n = 0;
    for (const chatId of this.store.chatsWithHeld()) {
      const chat = this.store.chat(chatId);
      if (!chat) continue;
      if (chat.quietStart !== null && chat.quietEnd !== null && inWindow(localMinute(chat.tz, this.now()), chat.quietStart, chat.quietEnd)) continue;
      const held = this.store.takeHeld(chatId);
      if (!held.length) continue;
      const head = `🌅 <b>While you were in quiet hours</b> (${held.length} alert${held.length === 1 ? "" : "s"})`;
      // Batch into messages under Telegram's size limit.
      let buf = head;
      for (const h of held) {
        const piece = `\n\n━━━━━━━━\n${h}`;
        if (buf.length + piece.length > 3900) {
          await this.messenger.send(chatId, buf);
          buf = "🌅 <b>Continued</b>";
        }
        buf += piece;
      }
      await this.messenger.send(chatId, fitMessage(buf));
      n += held.length;
    }
    return n;
  }
}
