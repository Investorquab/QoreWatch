import { describe, expect, it } from "vitest";
import { Store } from "../src/db/store.js";
import { Deliverer } from "../src/alerts/deliver.js";
import type { Alert } from "../src/alerts/types.js";
import { clock, inWindow, localMinute, parseClock, resolveTimeZone } from "../src/alerts/time.js";
import { fitMessage, keyboard, Pacer } from "../src/telegram/messenger.js";
import { silentLogger } from "../src/log.js";
import { FakeMessenger } from "./fakes.js";

const A = "qor1x46se3fzj60jjl6zreq3ur95fy6h9vdgrw5yq7";
const alert = (o: Partial<Alert> = {}): Alert => ({ key: `k${Math.random()}`, category: "money", level: "info", address: A, amountUqor: 10_000_000n, title: "💸 <b>Received 10 QOR</b>", body: ["line"], ...o });

function setup(at = "2026-11-19T12:00:00Z") {
  const store = new Store(":memory:");
  const m = new FakeMessenger();
  let now = new Date(at);
  const d = new Deliverer(store, m, silentLogger, () => now);
  store.ensureChat(1, "private");
  store.addWatch(1, A, { label: "Main" });
  return { store, m, d, setNow: (s: string) => (now = new Date(s)) };
}

describe("delivery rules", () => {
  it("sends an alert once, with the watch label and address", async () => {
    const { store, m, d } = setup();
    const a = alert({ key: "same" });
    expect(await d.deliver(store.chat(1)!, a, store.watch(1, A))).toBe("sent");
    expect(await d.deliver(store.chat(1)!, a, store.watch(1, A))).toBe("duplicate");
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]!.html).toContain("<b>Main</b>");
    expect(m.sent[0]!.html).toContain("qor1x46se3…rw5yq7");
  });

  it("respects pause, chat mutes, address mutes and money thresholds, but never for critical alerts", async () => {
    const { store, d } = setup();
    store.updateChat(1, { paused: true });
    expect(await d.deliver(store.chat(1)!, alert(), store.watch(1, A))).toBe("paused");
    expect(await d.deliver(store.chat(1)!, alert({ level: "critical", category: "security" }), store.watch(1, A))).toBe("sent");
    store.updateChat(1, { paused: false, muted: ["money"] });
    expect(await d.deliver(store.chat(1)!, alert(), store.watch(1, A))).toBe("muted");
    store.updateChat(1, { muted: [] });
    store.updateWatch(1, A, { muted: ["security"] });
    expect(await d.deliver(store.chat(1)!, alert({ category: "security", level: "warning" }), store.watch(1, A))).toBe("muted");
    expect(await d.deliver(store.chat(1)!, alert({ category: "security", level: "critical" }), store.watch(1, A))).toBe("sent");
    store.updateWatch(1, A, { muted: [], minUqor: 50_000_000n });
    expect(await d.deliver(store.chat(1)!, alert(), store.watch(1, A))).toBe("below_threshold");
    expect(await d.deliver(store.chat(1)!, alert({ amountUqor: 60_000_000n }), store.watch(1, A))).toBe("sent");
  });

  it("holds info alerts during quiet hours in the chat's time zone and sends them after", async () => {
    // 23:30 in Lagos (UTC+1) is 22:30 UTC.
    const { store, m, d, setNow } = setup("2026-11-19T22:30:00Z");
    store.updateChat(1, { tz: "Africa/Lagos", quietStart: parseClock("23:00")!, quietEnd: parseClock("07:00")! });
    expect(await d.deliver(store.chat(1)!, alert(), store.watch(1, A))).toBe("held");
    expect(await d.deliver(store.chat(1)!, alert({ category: "security", level: "warning", title: "🔐 window" }), store.watch(1, A))).toBe("sent");
    expect(m.sent).toHaveLength(1);
    expect(await d.flushHeld()).toBe(0); // still quiet
    setNow("2026-11-20T06:30:00Z"); // 07:30 Lagos
    expect(await d.flushHeld()).toBe(1);
    expect(m.sent.at(-1)!.html).toMatch(/While you were in quiet hours/);
    expect(m.sent.at(-1)!.html).toContain("Received 10 QOR");
  });

  it("pauses a chat that blocked the bot", async () => {
    const { store, m, d } = setup();
    m.next.push({ ok: false, blocked: true, error: "Forbidden: bot was blocked by the user" });
    expect(await d.deliver(store.chat(1)!, alert(), store.watch(1, A))).toBe("blocked");
    expect(store.chat(1)!.paused).toBe(true);
  });
});

describe("time helpers", () => {
  it("wraps quiet hours past midnight", () => {
    expect(inWindow(23 * 60 + 30, 23 * 60, 7 * 60)).toBe(true);
    expect(inWindow(6 * 60, 23 * 60, 7 * 60)).toBe(true);
    expect(inWindow(7 * 60, 23 * 60, 7 * 60)).toBe(false);
    expect(inWindow(12 * 60, 9 * 60, 17 * 60)).toBe(true);
    expect(inWindow(5, 5, 5)).toBe(false);
  });

  it("reads local time and clock input", () => {
    expect(localMinute("Africa/Lagos", new Date("2026-11-19T22:30:00Z"))).toBe(23 * 60 + 30);
    expect(localMinute("UTC", new Date("2026-11-19T00:05:00Z"))).toBe(5);
    expect(parseClock("23:00")).toBe(1380);
    expect(parseClock("7")).toBe(420);
    expect(parseClock("7.30")).toBe(450);
    expect(parseClock("25:00")).toBeUndefined();
    expect(clock(450)).toBe("07:30");
  });

  it("maps friendly time zone names", () => {
    expect(resolveTimeZone("Africa/Lagos")).toBe("Africa/Lagos");
    expect(resolveTimeZone("lagos")).toBe("Africa/Lagos");
    expect(resolveTimeZone("UTC+1")).toBe("Etc/GMT-1");
    expect(resolveTimeZone("UTC-5")).toBe("Etc/GMT+5");
    expect(resolveTimeZone("Mars/Base")).toBeUndefined();
  });
});

describe("Telegram formatting", () => {
  it("builds inline keyboards and drops empty buttons", () => {
    expect(keyboard([[{ text: "Open", url: "https://x" }, { text: "Bad" }], [{ text: "Mute", data: "m:1" }]])).toEqual({
      inline_keyboard: [[{ text: "Open", url: "https://x" }], [{ text: "Mute", callback_data: "m:1" }]],
    });
    expect(keyboard()).toBeUndefined();
  });

  it("cuts long messages at a line break and closes open tags", () => {
    const long = "<b>" + "line of text\n".repeat(500);
    const out = fitMessage(long, 400);
    expect(out.length).toBeLessThanOrEqual(420);
    expect(out.endsWith("</b>\n…")).toBe(true);
  });

  it("paces messages per chat", async () => {
    let t = 0;
    const waits: number[] = [];
    const p = new Pacer(25, 1000, 3000, () => t, async (ms) => { waits.push(ms); t += ms; });
    await p.run(1, async () => {});
    await p.run(1, async () => {});
    await p.run(-5, async () => {});
    await p.run(-5, async () => {});
    expect(waits).toEqual([1000, 3000]);
  });
});
