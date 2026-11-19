import type { Button } from "../alerts/types.js";

/** Sending messages to Telegram. An interface so the alert pipeline is testable without Telegram. */
export interface Messenger {
  send(chatId: number, html: string, buttons?: Button[][]): Promise<SendResult>;
  sendPhoto?(chatId: number, png: Uint8Array, captionHtml: string, buttons?: Button[][]): Promise<SendResult>;
}

/** blocked: the user blocked the bot or it was removed from the group; stop sending there. */
export type SendResult = { ok: true } | { ok: false; blocked: boolean; error: string };

/** Telegram inline keyboard markup from our buttons. */
export function keyboard(buttons?: Button[][]) {
  if (!buttons?.length) return undefined;
  return {
    inline_keyboard: buttons
      .map((row) => row.filter((b) => b.url || b.data).map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data! })))
      .filter((row) => row.length),
  };
}

/** Messages Telegram accepts: up to 4096 characters. Long alerts are cut at a line break. */
export function fitMessage(html: string, max = 4000): string {
  if (html.length <= max) return html;
  const cut = html.lastIndexOf("\n", max - 20);
  const body = html.slice(0, cut > 0 ? cut : max - 20);
  // Close any tag left open by the cut (we only use b, i, code, a).
  const open: string[] = [];
  for (const m of body.matchAll(/<(\/?)(b|i|code|a)\b[^>]*>/g)) {
    if (m[1]) open.pop();
    else open.push(m[2]!);
  }
  return body + open.reverse().map((t) => `</${t}>`).join("") + "\n…";
}

/** Paces sends: at most `perSecond` overall and one message per chat per `chatGapMs`. */
export class Pacer {
  private readonly lastByChat = new Map<number, number>();
  private chain: Promise<void> = Promise.resolve();
  private stamps: number[] = [];

  constructor(
    private readonly perSecond = 25,
    private readonly chatGapMs = 1100,
    private readonly groupGapMs = 3100,
    private readonly now = () => Date.now(),
    private readonly sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  ) {}

  /** Wait for a slot for this chat, then run fn. Calls are serialized. */
  run<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
    const go = async () => {
      const gap = chatId < 0 ? this.groupGapMs : this.chatGapMs;
      const last = this.lastByChat.get(chatId);
      const waitChat = last === undefined ? 0 : last + gap - this.now();
      if (waitChat > 0) await this.sleep(waitChat);
      this.stamps = this.stamps.filter((t) => this.now() - t < 1000);
      if (this.stamps.length >= this.perSecond) await this.sleep(1000 - (this.now() - this.stamps[0]!));
      this.stamps.push(this.now());
      this.lastByChat.set(chatId, this.now());
      return fn();
    };
    const p = this.chain.then(go, go);
    this.chain = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }
}
