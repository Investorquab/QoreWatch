import type { Button } from "../src/alerts/types.js";
import type { Messenger, SendResult } from "../src/telegram/messenger.js";

/** A Messenger that records what it would send. */
export class FakeMessenger implements Messenger {
  sent: { chatId: number; html: string; buttons?: Button[][] }[] = [];
  photos: { chatId: number; caption: string; bytes: number }[] = [];
  next: SendResult[] = [];
  async send(chatId: number, html: string, buttons?: Button[][]): Promise<SendResult> {
    this.sent.push({ chatId, html, ...(buttons ? { buttons } : {}) });
    return this.next.shift() ?? { ok: true };
  }
  async sendPhoto(chatId: number, png: Uint8Array, caption: string): Promise<SendResult> {
    this.photos.push({ chatId, caption, bytes: png.length });
    return { ok: true };
  }
}
