import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * QoreWatch's whole state in one SQLite file (Node's built-in node:sqlite, no native
 * build step). Every change to the schema is a new entry in MIGRATIONS, applied in
 * order and recorded in schema_version, so a running deployment upgrades in place.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE chats (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT,
    tz TEXT NOT NULL DEFAULT 'UTC',
    quiet_start INTEGER,
    quiet_end INTEGER,
    digest_minute INTEGER,
    last_digest TEXT,
    paused INTEGER NOT NULL DEFAULT 0,
    muted TEXT NOT NULL DEFAULT '[]',
    network_alerts INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE watches (
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    address TEXT NOT NULL,
    label TEXT,
    owned INTEGER NOT NULL DEFAULT 0,
    linked_tx TEXT,
    min_uqor TEXT NOT NULL DEFAULT '0',
    muted TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    PRIMARY KEY (chat_id, address)
  );
  CREATE INDEX watches_address ON watches(address);
  CREATE TABLE codes (
    code TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    purpose TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    address TEXT
  );
  CREATE TABLE cursors (name TEXT PRIMARY KEY, height INTEGER NOT NULL);
  CREATE TABLE sent (chat_id INTEGER NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (chat_id, key));
  CREATE TABLE held (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, html TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    key TEXT NOT NULL UNIQUE,
    address TEXT NOT NULL,
    due_height INTEGER,
    due_at INTEGER,
    data TEXT NOT NULL DEFAULT '{}',
    done INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX schedules_due ON schedules(done, due_height, due_at);
  CREATE TABLE approvals (
    owner TEXT NOT NULL, token TEXT NOT NULL, spender TEXT NOT NULL,
    value TEXT NOT NULL, block INTEGER NOT NULL, tx TEXT NOT NULL,
    PRIMARY KEY (owner, token, spender)
  );
  CREATE TABLE pool_watches (
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    pool_id TEXT NOT NULL, pct REAL NOT NULL, base_price REAL, base_at INTEGER,
    PRIMARY KEY (chat_id, pool_id)
  );
  CREATE TABLE proposals (id TEXT PRIMARY KEY, status TEXT NOT NULL, voting_end TEXT, notified INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `,
];

export type ChatType = "private" | "group" | "supergroup" | "channel";

export interface Chat {
  id: number;
  type: ChatType;
  title: string | null;
  tz: string;
  /** Minutes after local midnight, or null when quiet hours are off. */
  quietStart: number | null;
  quietEnd: number | null;
  /** Local minute of the day for the daily digest, or null when off. */
  digestMinute: number | null;
  lastDigest: string | null;
  paused: boolean;
  muted: string[];
  networkAlerts: boolean;
  createdAt: string;
}

export interface Watch {
  chatId: number;
  address: string;
  label: string | null;
  /** Proved with a QoreX link transaction. */
  owned: boolean;
  linkedTx: string | null;
  /** Money alerts below this (in uqor) are skipped. */
  minUqor: bigint;
  muted: string[];
  createdAt: string;
}

export interface Schedule {
  id: number;
  kind: string;
  key: string;
  address: string;
  dueHeight: number | null;
  dueAt: number | null;
  data: Record<string, unknown>;
}

export const LIMITS = { watchesPerChat: 25, codeTtlMs: 15 * 60_000, sentRetentionMs: 14 * 24 * 3600_000, heldPerChat: 200 };

type Row = Record<string, unknown>;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)");
    const row = this.db.prepare("SELECT v FROM schema_version").get() as { v: number } | undefined;
    let v = row?.v ?? 0;
    if (!row) this.db.prepare("INSERT INTO schema_version (v) VALUES (0)").run();
    while (v < MIGRATIONS.length) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.prepare("UPDATE schema_version SET v = ?").run(v + 1);
      });
      v++;
    }
  }

  get schemaVersion(): number {
    return (this.db.prepare("SELECT v FROM schema_version").get() as { v: number }).v;
  }

  /** Run fn in a transaction. */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- chats ------------------------------------------------------------------------------------------------

  ensureChat(id: number, type: ChatType, title?: string | null): Chat {
    this.db
      .prepare("INSERT INTO chats (id, type, title, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET type = excluded.type, title = COALESCE(excluded.title, chats.title)")
      .run(id, type, title ?? null, new Date().toISOString());
    return this.chat(id)!;
  }

  chat(id: number): Chat | undefined {
    const r = this.db.prepare("SELECT * FROM chats WHERE id = ?").get(id) as Row | undefined;
    return r ? toChat(r) : undefined;
  }

  chats(): Chat[] {
    return (this.db.prepare("SELECT * FROM chats ORDER BY id").all() as Row[]).map(toChat);
  }

  updateChat(id: number, patch: Partial<Pick<Chat, "tz" | "quietStart" | "quietEnd" | "digestMinute" | "lastDigest" | "paused" | "muted" | "networkAlerts" | "title">>): void {
    const map: Record<string, [string, (v: unknown) => unknown]> = {
      tz: ["tz", (v) => v],
      quietStart: ["quiet_start", (v) => v],
      quietEnd: ["quiet_end", (v) => v],
      digestMinute: ["digest_minute", (v) => v],
      lastDigest: ["last_digest", (v) => v],
      paused: ["paused", (v) => (v ? 1 : 0)],
      muted: ["muted", (v) => JSON.stringify(v)],
      networkAlerts: ["network_alerts", (v) => (v ? 1 : 0)],
      title: ["title", (v) => v],
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const m = map[k];
      if (!m) continue;
      sets.push(`${m[0]} = ?`);
      vals.push(m[1](v));
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE chats SET ${sets.join(", ")} WHERE id = ?`).run(...(vals as never[]), id);
  }

  /** Remove everything stored for a chat (the /forget command, or the bot was removed from a group). */
  forgetChat(id: number): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM watches WHERE chat_id = ?").run(id);
      this.db.prepare("DELETE FROM pool_watches WHERE chat_id = ?").run(id);
      this.db.prepare("DELETE FROM codes WHERE chat_id = ?").run(id);
      this.db.prepare("DELETE FROM sent WHERE chat_id = ?").run(id);
      this.db.prepare("DELETE FROM held WHERE chat_id = ?").run(id);
      this.db.prepare("DELETE FROM chats WHERE id = ?").run(id);
    });
  }

  // ---- watches ----------------------------------------------------------------------------------------------

  /** Add or update a watch. Returns false when the chat is at its watch limit. */
  addWatch(chatId: number, address: string, opts: { label?: string | null; owned?: boolean; linkedTx?: string } = {}): boolean {
    const exists = this.watch(chatId, address);
    if (!exists && this.watches(chatId).length >= LIMITS.watchesPerChat) return false;
    this.db
      .prepare(
        `INSERT INTO watches (chat_id, address, label, owned, linked_tx, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, address) DO UPDATE SET
           label = COALESCE(excluded.label, watches.label),
           owned = MAX(watches.owned, excluded.owned),
           linked_tx = COALESCE(excluded.linked_tx, watches.linked_tx)`,
      )
      .run(chatId, address, opts.label ?? null, opts.owned ? 1 : 0, opts.linkedTx ?? null, new Date().toISOString());
    return true;
  }

  watch(chatId: number, address: string): Watch | undefined {
    const r = this.db.prepare("SELECT * FROM watches WHERE chat_id = ? AND address = ?").get(chatId, address) as Row | undefined;
    return r ? toWatch(r) : undefined;
  }

  watches(chatId: number): Watch[] {
    return (this.db.prepare("SELECT * FROM watches WHERE chat_id = ? ORDER BY owned DESC, created_at, rowid").all(chatId) as Row[]).map(toWatch);
  }

  /** Everyone watching an address. */
  watchersOf(address: string): Watch[] {
    return (this.db.prepare("SELECT * FROM watches WHERE address = ?").all(address) as Row[]).map(toWatch);
  }

  /** Every distinct watched address. */
  watchedAddresses(): Set<string> {
    return new Set((this.db.prepare("SELECT DISTINCT address FROM watches").all() as { address: string }[]).map((r) => r.address));
  }

  updateWatch(chatId: number, address: string, patch: Partial<Pick<Watch, "label" | "minUqor" | "muted">>): void {
    if (patch.label !== undefined) this.db.prepare("UPDATE watches SET label = ? WHERE chat_id = ? AND address = ?").run(patch.label, chatId, address);
    if (patch.minUqor !== undefined) this.db.prepare("UPDATE watches SET min_uqor = ? WHERE chat_id = ? AND address = ?").run(patch.minUqor.toString(), chatId, address);
    if (patch.muted !== undefined) this.db.prepare("UPDATE watches SET muted = ? WHERE chat_id = ? AND address = ?").run(JSON.stringify(patch.muted), chatId, address);
  }

  removeWatch(chatId: number, address: string): boolean {
    return Number(this.db.prepare("DELETE FROM watches WHERE chat_id = ? AND address = ?").run(chatId, address).changes) > 0;
  }

  // ---- one-time codes (link, attest) ------------------------------------------------------------------------

  /** A fresh 8-character code (no look-alike characters), valid for 15 minutes. */
  createCode(chatId: number, purpose: "link" | "attest", now = Date.now()): string {
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    for (;;) {
      const bytes = randomBytes(8);
      const code = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
      try {
        this.db.prepare("INSERT INTO codes (code, chat_id, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(code, chatId, purpose, now, now + LIMITS.codeTtlMs);
        return code;
      } catch {
        /* collision: try again */
      }
    }
  }

  /** Use a code once. Returns its chat when the code is live, unused and of the right purpose. */
  consumeCode(code: string, purpose: "link" | "attest", address: string, now = Date.now()): { chatId: number } | undefined {
    return this.tx(() => {
      const r = this.db.prepare("SELECT * FROM codes WHERE code = ?").get(code) as Row | undefined;
      if (!r || r.purpose !== purpose || r.used_at !== null || Number(r.expires_at) < now) return undefined;
      this.db.prepare("UPDATE codes SET used_at = ?, address = ? WHERE code = ?").run(now, address, code);
      return { chatId: Number(r.chat_id) };
    });
  }

  codeInfo(code: string): { chatId: number; purpose: string; expiresAt: number; usedAt: number | null; address: string | null } | undefined {
    const r = this.db.prepare("SELECT * FROM codes WHERE code = ?").get(code) as Row | undefined;
    if (!r) return undefined;
    return { chatId: Number(r.chat_id), purpose: String(r.purpose), expiresAt: Number(r.expires_at), usedAt: r.used_at === null ? null : Number(r.used_at), address: (r.address as string | null) ?? null };
  }

  // ---- cursors and key-value --------------------------------------------------------------------------------

  cursor(name: string): number | undefined {
    const r = this.db.prepare("SELECT height FROM cursors WHERE name = ?").get(name) as { height: number } | undefined;
    return r?.height;
  }

  setCursor(name: string, height: number): void {
    this.db.prepare("INSERT INTO cursors (name, height) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET height = excluded.height").run(name, height);
  }

  get(k: string): string | undefined {
    return (this.db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined)?.v;
  }

  set(k: string, v: string): void {
    this.db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }

  // ---- alert de-duplication and quiet-hours queue -------------------------------------------------------------

  /** Record an alert as sent. Returns false if the same alert already went to this chat. */
  markSent(chatId: number, key: string, now = Date.now()): boolean {
    try {
      this.db.prepare("INSERT INTO sent (chat_id, key, at) VALUES (?, ?, ?)").run(chatId, key, now);
      return true;
    } catch {
      return false;
    }
  }

  pruneSent(now = Date.now()): void {
    this.db.prepare("DELETE FROM sent WHERE at < ?").run(now - LIMITS.sentRetentionMs);
    this.db.prepare("DELETE FROM codes WHERE expires_at < ?").run(now - 24 * 3600_000);
  }

  hold(chatId: number, html: string, now = Date.now()): void {
    const n = (this.db.prepare("SELECT COUNT(*) AS n FROM held WHERE chat_id = ?").get(chatId) as { n: number }).n;
    if (n >= LIMITS.heldPerChat) this.db.prepare("DELETE FROM held WHERE id = (SELECT MIN(id) FROM held WHERE chat_id = ?)").run(chatId);
    this.db.prepare("INSERT INTO held (chat_id, html, created_at) VALUES (?, ?, ?)").run(chatId, html, now);
  }

  /** Take every held alert for a chat (oldest first) and clear them. */
  takeHeld(chatId: number): string[] {
    return this.tx(() => {
      const rows = this.db.prepare("SELECT html FROM held WHERE chat_id = ? ORDER BY id").all(chatId) as { html: string }[];
      this.db.prepare("DELETE FROM held WHERE chat_id = ?").run(chatId);
      return rows.map((r) => r.html);
    });
  }

  chatsWithHeld(): number[] {
    return (this.db.prepare("SELECT DISTINCT chat_id FROM held").all() as { chat_id: number }[]).map((r) => r.chat_id);
  }

  // ---- schedules (window expiry warnings, unbonding completion, …) --------------------------------------------

  /** Add a schedule unless one with the same key exists. */
  schedule(s: { kind: string; key: string; address: string; dueHeight?: number; dueAt?: number; data?: Record<string, unknown> }): void {
    this.db
      .prepare("INSERT INTO schedules (kind, key, address, due_height, due_at, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING")
      .run(s.kind, s.key, s.address, s.dueHeight ?? null, s.dueAt ?? null, JSON.stringify(s.data ?? {}));
  }

  /** Schedules due at this height or time. */
  dueSchedules(height: number, now = Date.now()): Schedule[] {
    return (
      this.db.prepare("SELECT * FROM schedules WHERE done = 0 AND ((due_height IS NOT NULL AND due_height <= ?) OR (due_at IS NOT NULL AND due_at <= ?)) ORDER BY id").all(height, now) as Row[]
    ).map(toSchedule);
  }

  completeSchedule(id: number): void {
    this.db.prepare("UPDATE schedules SET done = 1 WHERE id = ?").run(id);
  }

  cancelSchedules(kind: string, address: string): void {
    this.db.prepare("UPDATE schedules SET done = 1 WHERE kind = ? AND address = ? AND done = 0").run(kind, address);
  }

  // ---- token approvals seen for watched owners ---------------------------------------------------------------

  setApproval(owner: string, token: string, spender: string, value: bigint, block: number, tx: string): void {
    if (value === 0n) {
      this.db.prepare("DELETE FROM approvals WHERE owner = ? AND token = ? AND spender = ?").run(owner, token, spender);
      return;
    }
    this.db
      .prepare("INSERT INTO approvals (owner, token, spender, value, block, tx) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner, token, spender) DO UPDATE SET value = excluded.value, block = excluded.block, tx = excluded.tx")
      .run(owner, token, spender, value.toString(), block, tx);
  }

  approvals(owner: string): { token: string; spender: string; value: bigint; block: number; tx: string }[] {
    return (this.db.prepare("SELECT * FROM approvals WHERE owner = ? ORDER BY block DESC").all(owner) as Row[]).map((r) => ({
      token: String(r.token),
      spender: String(r.spender),
      value: BigInt(String(r.value)),
      block: Number(r.block),
      tx: String(r.tx),
    }));
  }

  // ---- pool price alerts --------------------------------------------------------------------------------------

  setPoolWatch(chatId: number, poolId: string, pct: number, basePrice: number, now = Date.now()): void {
    this.db
      .prepare("INSERT INTO pool_watches (chat_id, pool_id, pct, base_price, base_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(chat_id, pool_id) DO UPDATE SET pct = excluded.pct, base_price = excluded.base_price, base_at = excluded.base_at")
      .run(chatId, poolId, pct, basePrice, now);
  }

  removePoolWatch(chatId: number, poolId: string): boolean {
    return Number(this.db.prepare("DELETE FROM pool_watches WHERE chat_id = ? AND pool_id = ?").run(chatId, poolId).changes) > 0;
  }

  poolWatches(chatId?: number): { chatId: number; poolId: string; pct: number; basePrice: number; baseAt: number }[] {
    const rows = (chatId === undefined ? this.db.prepare("SELECT * FROM pool_watches").all() : this.db.prepare("SELECT * FROM pool_watches WHERE chat_id = ?").all(chatId)) as Row[];
    return rows.map((r) => ({ chatId: Number(r.chat_id), poolId: String(r.pool_id), pct: Number(r.pct), basePrice: Number(r.base_price), baseAt: Number(r.base_at) }));
  }

  // ---- governance --------------------------------------------------------------------------------------------

  proposal(id: string): { status: string; votingEnd: string | null; notified: number } | undefined {
    const r = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as Row | undefined;
    return r ? { status: String(r.status), votingEnd: (r.voting_end as string | null) ?? null, notified: Number(r.notified) } : undefined;
  }

  upsertProposal(id: string, status: string, votingEnd: string | null, notified?: number): void {
    this.db
      .prepare("INSERT INTO proposals (id, status, voting_end, notified) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, voting_end = excluded.voting_end, notified = MAX(proposals.notified, excluded.notified)")
      .run(id, status, votingEnd, notified ?? 0);
  }

  stats(): { chats: number; watches: number; addresses: number; owned: number } {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      chats: n("SELECT COUNT(*) AS n FROM chats"),
      watches: n("SELECT COUNT(*) AS n FROM watches"),
      addresses: n("SELECT COUNT(DISTINCT address) AS n FROM watches"),
      owned: n("SELECT COUNT(*) AS n FROM watches WHERE owned = 1"),
    };
  }
}

function toChat(r: Row): Chat {
  return {
    id: Number(r.id),
    type: r.type as ChatType,
    title: (r.title as string | null) ?? null,
    tz: String(r.tz),
    quietStart: r.quiet_start === null ? null : Number(r.quiet_start),
    quietEnd: r.quiet_end === null ? null : Number(r.quiet_end),
    digestMinute: r.digest_minute === null ? null : Number(r.digest_minute),
    lastDigest: (r.last_digest as string | null) ?? null,
    paused: Number(r.paused) === 1,
    muted: JSON.parse(String(r.muted)) as string[],
    networkAlerts: Number(r.network_alerts) === 1,
    createdAt: String(r.created_at),
  };
}

function toWatch(r: Row): Watch {
  return {
    chatId: Number(r.chat_id),
    address: String(r.address),
    label: (r.label as string | null) ?? null,
    owned: Number(r.owned) === 1,
    linkedTx: (r.linked_tx as string | null) ?? null,
    minUqor: BigInt(String(r.min_uqor)),
    muted: JSON.parse(String(r.muted)) as string[],
    createdAt: String(r.created_at),
  };
}

function toSchedule(r: Row): Schedule {
  return {
    id: Number(r.id),
    kind: String(r.kind),
    key: String(r.key),
    address: String(r.address),
    dueHeight: r.due_height === null ? null : Number(r.due_height),
    dueAt: r.due_at === null ? null : Number(r.due_at),
    data: JSON.parse(String(r.data)) as Record<string, unknown>,
  };
}
