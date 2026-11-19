/** The local minute of the day (0–1439) in an IANA time zone. */
export function localMinute(tz: string, at: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === "hour")!.value);
  const m = Number(parts.find((p) => p.type === "minute")!.value);
  return h * 60 + m;
}

/** The local calendar date (YYYY-MM-DD) in a time zone. */
export function localDate(tz: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** True when `minute` falls in [start, end), wrapping past midnight (23:00–07:00). */
export function inWindow(minute: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "23:00" → 1380. Undefined for anything else. */
export function parseClock(s: string): number | undefined {
  const m = /^([01]?\d|2[0-3])[:.h]?([0-5]\d)?$/.exec(s.trim());
  if (!m) return undefined;
  return Number(m[1]) * 60 + Number(m[2] ?? 0);
}

export const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/** Accept common names for time zones: "Lagos", "WAT", "UTC+1" are mapped to IANA zones. */
export function resolveTimeZone(input: string): string | undefined {
  const s = input.trim();
  if (isValidTimeZone(s)) return canonical(s);
  const aliases: Record<string, string> = {
    utc: "UTC", gmt: "UTC", wat: "Africa/Lagos", lagos: "Africa/Lagos", nigeria: "Africa/Lagos", abuja: "Africa/Lagos",
    london: "Europe/London", bst: "Europe/London", cet: "Europe/Berlin", berlin: "Europe/Berlin", paris: "Europe/Paris",
    istanbul: "Europe/Istanbul", turkey: "Europe/Istanbul", dubai: "Asia/Dubai", india: "Asia/Kolkata", ist: "Asia/Kolkata",
    singapore: "Asia/Singapore", tokyo: "Asia/Tokyo", "new york": "America/New_York", est: "America/New_York", edt: "America/New_York",
    pst: "America/Los_Angeles", pdt: "America/Los_Angeles", "los angeles": "America/Los_Angeles", nairobi: "Africa/Nairobi",
    johannesburg: "Africa/Johannesburg", cairo: "Africa/Cairo", accra: "Africa/Accra", sydney: "Australia/Sydney",
  };
  const a = aliases[s.toLowerCase()];
  if (a) return a;
  const off = /^(?:utc|gmt)\s*([+-])\s*(\d{1,2})$/i.exec(s);
  if (off) {
    const n = Number(off[2]);
    if (n <= 14) return n === 0 ? "UTC" : `Etc/GMT${off[1] === "+" ? "-" : "+"}${n}`; // POSIX sign is inverted
  }
  return undefined;
}

function canonical(tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz }).resolvedOptions().timeZone;
}
