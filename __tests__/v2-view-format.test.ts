// Task 8, the formatters. Every label the Today screen prints comes from here,
// so these are the strings a reviewer reads off the screen.
//
// No Intl long format is allowed in the implementation: its punctuation differs
// between Node and the browser, which would be a hydration mismatch rather than
// a cosmetic difference. These tests pin the exact spelling so that stays true.

import { describe, expect, test } from "vitest";

import {
  clockLabel,
  dayLabel,
  minutesLabel,
  sinceLabel,
} from "@/app/lib/v2/view/format";

const PHOENIX = "America/Phoenix";
const TOKYO = "Asia/Tokyo";

describe("clockLabel", () => {
  test("is 24 hour HH:MM in the given zone", () => {
    expect(clockLabel("2026-04-15T10:20:00-07:00", PHOENIX)).toBe("10:20");
    expect(clockLabel("2026-04-15T21:05:00-07:00", PHOENIX)).toBe("21:05");
  });

  test("reads the instant in the zone it is asked for, not the process clock", () => {
    const instant = "2026-04-15T10:20:00-07:00";
    expect(clockLabel(instant, "UTC")).toBe("17:20");
    expect(clockLabel(instant, TOKYO)).toBe("02:20");
  });

  test("pads single digits on both sides", () => {
    expect(clockLabel("2026-04-15T07:05:00-07:00", PHOENIX)).toBe("07:05");
    expect(clockLabel("2026-04-15T00:00:00-07:00", PHOENIX)).toBe("00:00");
  });
});

describe("dayLabel", () => {
  test("reads the weekday and the month out of the date key", () => {
    expect(dayLabel("2026-04-15")).toBe("Wednesday 15 April");
    expect(dayLabel("2026-03-10")).toBe("Tuesday 10 March");
    expect(dayLabel("2026-12-31")).toBe("Thursday 31 December");
  });

  test("does not pad the day of the month", () => {
    expect(dayLabel("2026-04-01")).toBe("Wednesday 1 April");
  });

  test("needs no zone, because a date key is already a local calendar date", () => {
    // Same answer whatever the process clock is doing.
    expect(dayLabel("2026-01-01")).toBe("Thursday 1 January");
    expect(dayLabel("2026-02-28")).toBe("Saturday 28 February");
  });
});

describe("minutesLabel", () => {
  test("counts minutes under an hour", () => {
    expect(minutesLabel(10)).toBe("10 minutes");
    expect(minutesLabel(25)).toBe("25 minutes");
    expect(minutesLabel(59)).toBe("59 minutes");
  });

  test("says one minute in the singular", () => {
    expect(minutesLabel(1)).toBe("1 minute");
  });

  test("counts whole hours", () => {
    expect(minutesLabel(60)).toBe("1 hour");
    expect(minutesLabel(120)).toBe("2 hours");
  });

  test("says both parts for a mixed length", () => {
    expect(minutesLabel(100)).toBe("1 hour 40 minutes");
    expect(minutesLabel(150)).toBe("2 hours 30 minutes");
    expect(minutesLabel(61)).toBe("1 hour 1 minute");
  });

  test("has nothing to say about a zero or negative length", () => {
    expect(minutesLabel(0)).toBe("");
    expect(minutesLabel(-5)).toBe("");
  });
});

describe("sinceLabel", () => {
  const now = "2026-04-15T10:20:00-07:00";

  test("gives the clock for a time earlier the same local day", () => {
    expect(sinceLabel("2026-04-15T08:05:00-07:00", now, PHOENIX)).toBe("08:05");
  });

  test("gives the day for an earlier day", () => {
    expect(sinceLabel("2026-04-11T08:05:00-07:00", now, PHOENIX)).toBe("11 April");
    expect(sinceLabel("2025-12-30T23:40:00-07:00", now, PHOENIX)).toBe("30 December");
  });

  test("is a sentence fragment, never a null", () => {
    expect(sinceLabel(null, now, PHOENIX)).toBe("the start");
  });

  test("buckets by the local day, not by the process clock", () => {
    // 2026-04-15T23:30-07:00 is already 2026-04-16 in UTC and in Tokyo.
    const lateLocal = "2026-04-15T23:30:00-07:00";
    const lateNow = "2026-04-15T23:50:00-07:00";
    expect(sinceLabel(lateLocal, lateNow, PHOENIX)).toBe("23:30");
    expect(sinceLabel(lateLocal, lateNow, "UTC")).toBe("06:30");
  });
});
