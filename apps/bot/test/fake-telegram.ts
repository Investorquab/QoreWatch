import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** One Bot API call the bot made. */
export interface Call {
  method: string;
  body: Record<string, unknown>;
}

/**
 * A local stand-in for api.telegram.org. It answers the Bot API methods QoreWatch uses,
 * records every call, serves queued updates to getUpdates (long polling), and lets a
 * test decide answers (for example getChatMember for group admin checks, or errors).
 */
export class FakeTelegram {
  readonly calls: Call[] = [];
  private server?: Server;
  private updates: Record<string, unknown>[] = [];
  private nextUpdateId = 1;
  private nextMessageId = 100;
  private waiters: (() => void)[] = [];
  /** Status returned by getChatMember: "member" by default. */
  memberStatus = "member";
  /** Queue of forced error answers: { method, code, description, retry_after? }. */
  failures: { method: string; code: number; description: string; retryAfter?: number }[] = [];
  readonly token = "123456789:TEST-token-for-the-fake-bot-api-0000";

  async start(): Promise<string> {
    this.server = createServer(async (req, res) => {
      const m = /^\/bot([^/]+)\/(\w+)/.exec(req.url ?? "");
      if (!m || m[1] !== this.token) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }));
        return;
      }
      const method = m[2]!;
      const body = await readBody(req);
      this.calls.push({ method, body });
      const fail = this.failures.findIndex((f) => f.method === method);
      if (fail >= 0) {
        const f = this.failures.splice(fail, 1)[0]!;
        res.writeHead(f.code, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error_code: f.code, description: f.description, ...(f.retryAfter ? { parameters: { retry_after: f.retryAfter } } : {}) }));
        return;
      }
      const result = await this.answer(method, body);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result }));
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const w of this.waiters.splice(0)) w();
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  private async answer(method: string, body: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "getMe":
        return { id: 123456789, is_bot: true, first_name: "QoreWatch", username: "qorewatchbot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
      case "deleteWebhook":
      case "setMyCommands":
      case "setMyDescription":
      case "setMyShortDescription":
      case "answerCallbackQuery":
      case "sendChatAction":
        return true;
      case "getUpdates": {
        if (!this.updates.length) {
          const timeout = Math.min(Number(body.timeout ?? 0), 2) * 1000;
          if (timeout) await new Promise<void>((r) => {
            const t = setTimeout(r, timeout);
            this.waiters.push(() => {
              clearTimeout(t);
              r();
            });
          });
        }
        const offset = Number(body.offset ?? 0);
        this.updates = this.updates.filter((u) => Number(u.update_id) >= offset);
        return this.updates.splice(0);
      }
      case "getChatMember":
        return { status: this.memberStatus, user: { id: Number(body.user_id), is_bot: false, first_name: "U" } };
      case "sendMessage":
      case "sendPhoto":
        return { message_id: this.nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: Number(body.chat_id), type: Number(body.chat_id) < 0 ? "supergroup" : "private" }, text: body.text ?? "" };
      case "editMessageText":
        return { message_id: Number(body.message_id), date: Math.floor(Date.now() / 1000), chat: { id: Number(body.chat_id), type: "private" }, text: body.text };
      default:
        return true;
    }
  }

  /** Queue an update for getUpdates (long polling). */
  push(update: Record<string, unknown>): void {
    this.updates.push({ update_id: this.nextUpdateId++, ...update });
    for (const w of this.waiters.splice(0)) w();
  }

  /** Build a text message update. */
  text(chatId: number, text: string, opts: { userId?: number; chatType?: string; title?: string; firstName?: string } = {}): Record<string, unknown> {
    const isCommand = text.startsWith("/");
    const cmdLen = isCommand ? text.split(/\s/)[0]!.length : 0;
    return {
      update_id: this.nextUpdateId++,
      message: {
        message_id: this.nextMessageId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: opts.chatType ?? (chatId < 0 ? "supergroup" : "private"), ...(opts.title ? { title: opts.title } : {}), ...(chatId > 0 ? { first_name: opts.firstName ?? "Ada" } : {}) },
        from: { id: opts.userId ?? Math.abs(chatId), is_bot: false, first_name: opts.firstName ?? "Ada" },
        text,
        ...(isCommand ? { entities: [{ type: "bot_command", offset: 0, length: cmdLen }] } : {}),
      },
    };
  }

  /** Build a button-press update. */
  press(chatId: number, data: string, opts: { userId?: number } = {}): Record<string, unknown> {
    return {
      update_id: this.nextUpdateId++,
      callback_query: {
        id: String(this.nextUpdateId),
        from: { id: opts.userId ?? Math.abs(chatId), is_bot: false, first_name: "Ada" },
        chat_instance: "x",
        data,
        message: { message_id: 50, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: chatId < 0 ? "supergroup" : "private" }, text: "menu" },
      },
    };
  }

  /** Every message text the bot sent or edited for a chat, in order. */
  messages(chatId: number): string[] {
    return this.calls.filter((c) => (c.method === "sendMessage" || c.method === "editMessageText") && Number(c.body.chat_id) === chatId).map((c) => String(c.body.text));
  }

  last(chatId: number): Call | undefined {
    return this.calls.filter((c) => (c.method === "sendMessage" || c.method === "editMessageText" || c.method === "sendPhoto") && Number(c.body.chat_id) === chatId).at(-1);
  }

  /** Buttons (text → url or callback data) of a call. */
  static buttons(call?: Call): { text: string; url?: string; data?: string }[] {
    const kb = (call?.body.reply_markup as { inline_keyboard?: { text: string; url?: string; callback_data?: string }[][] } | string | undefined) ?? undefined;
    const parsed = typeof kb === "string" ? (JSON.parse(kb) as { inline_keyboard?: { text: string; url?: string; callback_data?: string }[][] }) : kb;
    return (parsed?.inline_keyboard ?? []).flat().map((b) => ({ text: b.text, ...(b.url ? { url: b.url } : {}), ...(b.callback_data ? { data: b.callback_data } : {}) }));
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);
  const type = req.headers["content-type"] ?? "";
  if (type.includes("application/json")) return raw.length ? (JSON.parse(raw.toString("utf8")) as Record<string, unknown>) : {};
  if (type.includes("multipart/form-data")) {
    // Pull simple text fields out of multipart bodies (sendPhoto); keep the file size.
    const out: Record<string, unknown> = { _bytes: raw.length };
    const text = raw.toString("latin1");
    for (const m of text.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g)) out[m[1]!] = m[2];
    return out;
  }
  return {};
}
