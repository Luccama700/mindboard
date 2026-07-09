// Pure timezone helpers for wake-window math on a UTC server. The process clock
// is UTC on Vercel, so `new Date().getHours()` is not the user's hour. These
// helpers turn a wall-clock time in an IANA zone into a UTC instant (and format
// instants back), so the schedule/free-gap math can reason in the user's day.
//
// When `timeZone` is null the process clock is used unchanged — this preserves
// the original behavior for callers that don't pass a zone, and is correct in
// the browser, where the process clock already IS the user's zone.

function offsetMsAt(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wallAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return wallAsUtc - utcMs;
}

// The UTC instant (ms) for a wall-clock time in the zone. `hour` may exceed 23
// (e.g. a wake window ending at 24:00 = next-day midnight), matching Date.UTC's
// rollover. DST: a wall time in the ~1h skipped/repeated window resolves to one
// of the two plausible instants, which is acceptable for wake-window bounds.
export function zonedWallTimeToUtcMs(
  dateKey: string,
  hour: number,
  minute: number,
  timeZone: string | null,
): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  if (!timeZone) {
    return new Date(y, m - 1, d, hour, minute, 0, 0).getTime();
  }
  const guess = Date.UTC(y, m - 1, d, hour, minute, 0);
  const offset = offsetMsAt(guess, timeZone);
  let result = guess - offset;
  // Re-check the offset at the resolved instant so a DST boundary between the
  // guess and the answer is corrected once.
  const offset2 = offsetMsAt(result, timeZone);
  if (offset2 !== offset) result = guess - offset2;
  return result;
}

// The YYYY-MM-DD date an instant falls on, in the zone.
export function zonedDateKey(utcMs: number, timeZone: string | null): string {
  const d = new Date(utcMs);
  if (!timeZone) {
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// Minutes past local midnight of an instant in the zone (0..1439).
export function zonedClockMinutes(
  utcMs: number,
  timeZone: string | null,
): number {
  const d = new Date(utcMs);
  if (!timeZone) return d.getHours() * 60 + d.getMinutes();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return get("hour") * 60 + get("minute");
}

// "HH:MM" wall clock of an instant in the zone.
export function zonedClock(utcMs: number, timeZone: string | null): string {
  const total = zonedClockMinutes(utcMs, timeZone);
  const h = String(Math.floor(total / 60)).padStart(2, "0");
  const m = String(total % 60).padStart(2, "0");
  return `${h}:${m}`;
}

// ISO 8601 with the zone's explicit numeric offset, e.g. 2026-07-08T14:30:00-04:00.
// Callers hand planning consumers unambiguous timestamps regardless of the
// server's own clock.
export function zonedIso(utcMs: number, timeZone: string | null): string {
  const d = new Date(utcMs);
  if (!timeZone) return d.toISOString();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const offsetMin = offsetMsAt(d.getTime(), timeZone) / 60_000;
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(Math.round(abs % 60)).padStart(2, "0");
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get(
    "minute",
  )}:${get("second")}${sign}${oh}:${om}`;
}
