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

  // America/New_York DST 2026: spring-forward 2026-03-08 (02:00 EST -> 03:00
  // EDT), fall-back 2026-11-01 (02:00 EDT -> 01:00 EST).
  describe("DST transitions", () => {
    test("spring-forward: wall-clock hours across the skipped hour reflect real elapsed time", () => {
      const before = zonedWallTimeToUtcMs("2026-03-08", 1, 0, "America/New_York");
      const after = zonedWallTimeToUtcMs("2026-03-08", 4, 0, "America/New_York");
      // 1am to 4am reads as 3 wall-clock hours, but the 2am hour is skipped:
      // only 2 real hours elapse.
      expect(after - before).toBe(2 * 60 * 60 * 1000);
    });

    test("spring-forward: a wall time inside the skipped hour still resolves to a single instant", () => {
      // 02:30 does not exist on 2026-03-08 (clocks jump 02:00 -> 03:00).
      expect(
        zonedWallTimeToUtcMs("2026-03-08", 2, 30, "America/New_York"),
      ).toBe(Date.UTC(2026, 2, 8, 6, 30, 0));
    });

    test("fall-back: wall-clock hours across the repeated hour reflect the extra real hour", () => {
      const before = zonedWallTimeToUtcMs("2026-11-01", 0, 30, "America/New_York");
      const after = zonedWallTimeToUtcMs("2026-11-01", 3, 0, "America/New_York");
      // 0:30 to 3:00 reads as 2.5 wall-clock hours, but the 1am hour repeats:
      // 3.5 real hours elapse.
      expect(after - before).toBe(3.5 * 60 * 60 * 1000);
    });
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

  test("null zone falls back to the process clock's own date and minutes", () => {
    const ms = new Date(2026, 6, 8, 15, 30, 0).getTime();
    expect(zonedDateKey(ms, null)).toBe("2026-07-08");
    expect(zonedClockMinutes(ms, null)).toBe(15 * 60 + 30);
  });
});

describe("zonedIso", () => {
  test("emits the local wall time with an explicit numeric offset", () => {
    const ms = Date.UTC(2026, 6, 8, 12, 0, 0);
    expect(zonedIso(ms, "America/New_York")).toBe("2026-07-08T08:00:00-04:00");
    expect(zonedIso(ms, "Asia/Kolkata")).toBe("2026-07-08T17:30:00+05:30");
  });

  test("pads a negative half-hour offset (Newfoundland, UTC-2:30 in summer)", () => {
    const ms = Date.UTC(2026, 6, 8, 12, 0, 0);
    expect(zonedIso(ms, "America/St_Johns")).toBe("2026-07-08T09:30:00-02:30");
  });

  test("a zero offset zone still emits an explicit + sign", () => {
    const ms = Date.UTC(2026, 6, 8, 12, 0, 0);
    expect(zonedIso(ms, "UTC")).toBe("2026-07-08T12:00:00+00:00");
  });

  test("null zone falls back to the process clock's own ISO string", () => {
    const d = new Date(2026, 6, 8, 8, 0, 0);
    expect(zonedIso(d.getTime(), null)).toBe(d.toISOString());
  });
});
