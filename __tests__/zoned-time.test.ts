import { describe, expect, test } from "vitest";

import {
  zonedClock,
  zonedClockMinutes,
  zonedDateKey,
  zonedIso,
  zonedWallTimeToUtcMs,
} from "@/app/lib/snapshots/zoned-time";

describe("zonedWallTimeToUtcMs", () => {
  test("resolves a wall time in a fixed-offset-in-summer zone (EDT = UTC-4)", () => {
    // 08:00 in New York on a July day is 12:00 UTC.
    expect(zonedWallTimeToUtcMs("2026-07-08", 8, 0, "America/New_York")).toBe(
      Date.UTC(2026, 6, 8, 12, 0, 0),
    );
  });

  test("honors DST: the same wall time is UTC-5 in winter", () => {
    expect(zonedWallTimeToUtcMs("2026-01-08", 8, 0, "America/New_York")).toBe(
      Date.UTC(2026, 0, 8, 13, 0, 0),
    );
  });

  test("handles a half-hour zone (IST = UTC+5:30)", () => {
    expect(zonedWallTimeToUtcMs("2026-07-08", 8, 0, "Asia/Kolkata")).toBe(
      Date.UTC(2026, 6, 8, 2, 30, 0),
    );
  });

  test("hour 24 rolls to next-day midnight (wake window ending at 24:00)", () => {
    expect(zonedWallTimeToUtcMs("2026-07-08", 24, 0, "America/New_York")).toBe(
      Date.UTC(2026, 6, 9, 4, 0, 0),
    );
  });

  test("null zone falls back to the process clock", () => {
    expect(zonedWallTimeToUtcMs("2026-07-08", 8, 0, null)).toBe(
      new Date(2026, 6, 8, 8, 0, 0, 0).getTime(),
    );
  });
});

describe("zonedDateKey / zonedClock", () => {
  test("an early-UTC instant belongs to the previous local day in the Americas", () => {
    const ms = Date.UTC(2026, 6, 8, 2, 0, 0); // 02:00 UTC = 22:00 EDT prior day
    expect(zonedDateKey(ms, "America/New_York")).toBe("2026-07-07");
    expect(zonedClock(ms, "America/New_York")).toBe("22:00");
    expect(zonedClockMinutes(ms, "America/New_York")).toBe(22 * 60);
  });

  test("round-trips a wall time back to its own date and clock minutes", () => {
    for (const tz of ["America/New_York", "Asia/Kolkata", "Europe/Paris"]) {
      const ms = zonedWallTimeToUtcMs("2026-07-08", 17, 15, tz);
      expect(zonedDateKey(ms, tz)).toBe("2026-07-08");
      expect(zonedClockMinutes(ms, tz)).toBe(17 * 60 + 15);
    }
  });
});

describe("zonedIso", () => {
  test("emits the local wall time with an explicit numeric offset", () => {
    const ms = Date.UTC(2026, 6, 8, 12, 0, 0);
    expect(zonedIso(ms, "America/New_York")).toBe("2026-07-08T08:00:00-04:00");
    expect(zonedIso(ms, "Asia/Kolkata")).toBe("2026-07-08T17:30:00+05:30");
  });
});
