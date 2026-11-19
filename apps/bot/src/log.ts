/** Minimal structured logger. Never logs secrets: callers pass ids and counts, not tokens or message text. */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export function createLogger(level: Level = "info", sink: (line: string) => void = (l) => process.stdout.write(l + "\n")): Logger {
  const at = (l: Level) => (msg: string, data?: Record<string, unknown>) => {
    if (ORDER[l] < ORDER[level]) return;
    sink(JSON.stringify({ t: new Date().toISOString(), level: l, msg, ...(data ? scrub(data) : {}) }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

/** Defence in depth: drop anything that looks like a Telegram token from log data. */
function scrub(d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (/token|secret|password|key$/i.test(k)) continue;
    out[k] = typeof v === "string" ? v.replace(/\d{5,}:[A-Za-z0-9_-]{30,}/g, "[redacted]") : v instanceof Error ? v.message.replace(/\d{5,}:[A-Za-z0-9_-]{30,}/g, "[redacted]") : v;
  }
  return out;
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
