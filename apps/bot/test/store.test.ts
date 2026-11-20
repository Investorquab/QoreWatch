import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LIMITS, Store } from "../src/db/store.js";

const A = "qor1x46se3fzj60jjl6zreq3ur95fy6h9vdgrw5yq7";
const B = "qor1avnejacyrgz607gfh5y5ysgldq4mtqwcy67tzp";
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const fileStore = () => {
  const d = mkdtempSync(join(tmpdir(), "qw-"));
  dirs.push(d);
  return join(d, "data", "qorewatch.sqlite");
};

describe("Store", () => {
  it("migrates a new database and reopens it without re-running migrations", () => {
    const path = fileStore();
    const s1 = new Store(path);
    expect(s1.schemaVersion).toBe(2);
    s1.ensureChat(1, "private");
    s1.close();
    const s2 = new Store(path);
    expect(s2.schemaVersion).toBe(2);
    expect(s2.chat(1)?.type).toBe("private");
    s2.close();
  });

  it("upgrades a version 1 database in place, keeping its data", () => {
    const path = fileStore();
    const s1 = new Store(path);
    s1.ensureChat(1, "private");
    const code = s1.createCode(1, "link");
    // Turn it back into a version 1 database, as a deployment made before link claims has.
    s1.db.exec("ALTER TABLE codes DROP COLUMN claimed_by; UPDATE schema_version SET v = 1;");
    s1.close();
    const s2 = new Store(path);
    expect(s2.schemaVersion).toBe(2);
    expect(s2.chat(1)?.type).toBe("private");
    expect(s2.codeInfo(code)).toMatchObject({ chatId: 1, claimedBy: null });
    expect(s2.claimCode(code, "qor1ukeppmkglj3d36ucej3rsntt0yx9lvhu83egha")).toBe("claimed");
    s2.close();
  });

  it("stores chats with defaults and updates settings", () => {
    const s = new Store(":memory:");
    const c = s.ensureChat(42, "group", "Treasury team");
    expect(c).toMatchObject({ tz: "UTC", quietStart: null, paused: false, muted: [], networkAlerts: true, title: "Treasury team" });
    s.updateChat(42, { tz: "Africa/Lagos", quietStart: 23 * 60, quietEnd: 7 * 60, muted: ["staking"], paused: true });
    expect(s.chat(42)).toMatchObject({ tz: "Africa/Lagos", quietStart: 1380, quietEnd: 420, muted: ["staking"], paused: true });
    s.ensureChat(42, "supergroup");
    expect(s.chat(42)).toMatchObject({ type: "supergroup", title: "Treasury team", tz: "Africa/Lagos" });
  });

  it("adds, labels, lists and removes watches, and finds watchers of an address", () => {
    const s = new Store(":memory:");
    s.ensureChat(1, "private");
    s.ensureChat(2, "group");
    expect(s.addWatch(1, A, { label: "Main" })).toBe(true);
    expect(s.addWatch(2, A)).toBe(true);
    s.addWatch(1, B);
    expect(s.watches(1).map((w) => w.address)).toEqual([A, B]);
    expect(s.watchersOf(A).map((w) => w.chatId).sort()).toEqual([1, 2]);
    expect(s.watchedAddresses()).toEqual(new Set([A, B]));
    s.updateWatch(1, A, { minUqor: 5_000_000n, muted: ["money"] });
    expect(s.watch(1, A)).toMatchObject({ label: "Main", minUqor: 5_000_000n, muted: ["money"], owned: false });
    // Linking later keeps the label and marks it owned.
    s.addWatch(1, A, { owned: true, linkedTx: "ABC" });
    expect(s.watch(1, A)).toMatchObject({ label: "Main", owned: true, linkedTx: "ABC" });
    expect(s.removeWatch(1, B)).toBe(true);
    expect(s.removeWatch(1, B)).toBe(false);
  });

  it("enforces the per-chat watch limit", () => {
    const s = new Store(":memory:");
    s.ensureChat(1, "private");
    for (let i = 0; i < LIMITS.watchesPerChat; i++) expect(s.addWatch(1, `qor1fake${i}`)).toBe(true);
    expect(s.addWatch(1, "qor1onemore")).toBe(false);
    expect(s.addWatch(1, "qor1fake0", { label: "still editable" })).toBe(true);
  });

  it("issues one-time codes that expire, are single-use and purpose-bound", () => {
    const s = new Store(":memory:");
    s.ensureChat(7, "private");
    const t0 = 1_000_000;
    const code = s.createCode(7, "link", t0);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(s.consumeCode(code, "attest", A, t0)).toBeUndefined();
    expect(s.consumeCode(code, "link", A, t0 + 500)).toBeUndefined(); // not claimed yet
    expect(s.claimCode(code, A, t0 + 600)).toBe("claimed");
    expect(s.consumeCode(code, "link", A, t0 + 1000)).toEqual({ chatId: 7 });
    expect(s.consumeCode(code, "link", A, t0 + 2000)).toBeUndefined();
    const late = s.createCode(7, "link", t0);
    expect(s.claimCode(late, A, t0)).toBe("claimed");
    expect(s.consumeCode(late, "link", A, t0 + LIMITS.codeTtlMs + 1)).toBeUndefined();
    expect(s.claimCode(late, A, t0 + LIMITS.codeTtlMs + 1)).toBe("invalid");
    expect(s.consumeCode("NOPE2345", "link", A, t0)).toBeUndefined();
  });

  it("binds a link code to the address that claimed it, so a copied code is useless", () => {
    const s = new Store(":memory:");
    s.ensureChat(7, "private");
    const B = "qor1sx6dpevcmw8464tr76dsehsdvj7euy4rknm23c";
    const code = s.createCode(7, "link");
    expect(s.claimCode(code, A)).toBe("claimed");
    expect(s.claimCode(code, A)).toBe("claimed"); // a page reload
    expect(s.claimCode(code, B)).toBe("taken");
    // Someone copies the pending code into their own transaction: it does not link them.
    expect(s.consumeCode(code, "link", B)).toBeUndefined();
    // The rightful signer still links.
    expect(s.consumeCode(code, "link", A)).toEqual({ chatId: 7 });
    expect(s.codeInfo(code)).toMatchObject({ claimedBy: A, address: A });
    expect(s.claimCode(code, A)).toBe("invalid"); // used
    expect(s.claimCode("NOPE2345", A)).toBe("invalid");
    expect(s.claimCode(s.createCode(7, "attest"), A)).toBe("invalid");
  });

  it("draws codes from all 31 characters evenly", () => {
    const s = new Store(":memory:");
    s.ensureChat(7, "private");
    const counts = new Map<string, number>();
    for (let i = 0; i < 2000; i++) for (const ch of s.createCode(7, "attest")) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(31);
    const expected = 16000 / 31;
    for (const n of counts.values()) expect(Math.abs(n - expected)).toBeLessThan(expected * 0.25);
  });

  it("de-duplicates alerts per chat", () => {
    const s = new Store(":memory:");
    expect(s.markSent(1, "tx:ABC:transfer")).toBe(true);
    expect(s.markSent(1, "tx:ABC:transfer")).toBe(false);
    expect(s.markSent(2, "tx:ABC:transfer")).toBe(true);
  });

  it("holds alerts during quiet hours, capped, and hands them back in order", () => {
    const s = new Store(":memory:");
    s.hold(1, "a");
    s.hold(1, "b");
    expect(s.chatsWithHeld()).toEqual([1]);
    expect(s.takeHeld(1)).toEqual(["a", "b"]);
    expect(s.takeHeld(1)).toEqual([]);
    for (let i = 0; i < LIMITS.heldPerChat + 5; i++) s.hold(2, `m${i}`);
    const held = s.takeHeld(2);
    expect(held.length).toBe(LIMITS.heldPerChat);
    expect(held[0]).toBe("m5");
  });

  it("schedules by height or time, once per key", () => {
    const s = new Store(":memory:");
    s.schedule({ kind: "window_expiry", key: "w:A:100", address: A, dueHeight: 100, data: { expiry: 120 } });
    s.schedule({ kind: "window_expiry", key: "w:A:100", address: A, dueHeight: 50 });
    s.schedule({ kind: "unbond_done", key: "u:A:1", address: A, dueAt: 5_000 });
    expect(s.dueSchedules(99, 1000)).toEqual([]);
    const due = s.dueSchedules(100, 6000);
    expect(due.map((d) => d.kind)).toEqual(["window_expiry", "unbond_done"]);
    expect(due[0]!.data).toEqual({ expiry: 120 });
    s.completeSchedule(due[0]!.id);
    s.cancelSchedules("unbond_done", A);
    expect(s.dueSchedules(1000, 10_000)).toEqual([]);
  });

  it("tracks token approvals and drops revoked ones", () => {
    const s = new Store(":memory:");
    s.setApproval("0xowner", "0xtoken", "0xspender", 10n ** 30n, 5, "0xtx");
    expect(s.approvals("0xowner")).toHaveLength(1);
    s.setApproval("0xowner", "0xtoken", "0xspender", 0n, 6, "0xtx2");
    expect(s.approvals("0xowner")).toHaveLength(0);
  });

  it("forgets a chat completely", () => {
    const s = new Store(":memory:");
    s.ensureChat(1, "private");
    s.addWatch(1, A);
    s.setPoolWatch(1, "2", 5, 1.2);
    s.hold(1, "x");
    s.createCode(1, "link");
    s.forgetChat(1);
    expect(s.chat(1)).toBeUndefined();
    expect(s.watches(1)).toEqual([]);
    expect(s.poolWatches(1)).toEqual([]);
    expect(s.takeHeld(1)).toEqual([]);
  });

  it("keeps cursors and settings", () => {
    const s = new Store(":memory:");
    expect(s.cursor("native")).toBeUndefined();
    s.setCursor("native", 10);
    s.setCursor("native", 11);
    expect(s.cursor("native")).toBe(11);
    s.set("upgrade_notified", "v3.2.9");
    expect(s.get("upgrade_notified")).toBe("v3.2.9");
  });
});
