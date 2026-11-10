// Task 2, the rules half: DEFAULT_RULES is the generic shape every user starts
// from (nothing personal lives here, so the numbers below are the spec's own
// defaults), and parseRules is the only door a stored rules row comes through.

import { describe, expect, test } from "vitest";

import { DEFAULT_RULES, parseRules } from "@/app/lib/v2/rules";

describe("DEFAULT_RULES", () => {
  test("carries the generic defaults from the spec", () => {
    expect(DEFAULT_RULES.timeZone).toBe("UTC");
    expect(DEFAULT_RULES.wakeByWeekday).toEqual([
      "08:00",
      "08:00",
      "08:00",
      "08:00",
      "08:00",
      "08:00",
      "08:00",
    ]);
    expect(DEFAULT_RULES.lightsOut).toBe("23:00");
    expect(DEFAULT_RULES.noFocusBefore).toBe("09:00");
    expect(DEFAULT_RULES.blockMinutes).toEqual({
      floor: 25,
      standard: 50,
      long: 120,
    });
    expect(DEFAULT_RULES.bufferMinutes).toBe(10);
    expect(DEFAULT_RULES.capacity.low).toEqual({
      blocks: 0,
      small: 1,
      gym: false,
      social: false,
    });
    expect(DEFAULT_RULES.capacity.ok).toEqual({
      blocks: 2,
      small: 0,
      gym: false,
      social: false,
    });
    expect(DEFAULT_RULES.capacity.good).toEqual({
      blocks: 3,
      small: 0,
      gym: true,
      social: true,
    });
    expect(DEFAULT_RULES.hardWindowHours).toBe(72);
    expect(DEFAULT_RULES.maxBlocksPerLanePerDay).toBe(1);
    expect(DEFAULT_RULES.weeklyHourCap).toBeNull();
    expect(DEFAULT_RULES.capExemptRanges).toEqual([]);
    expect(DEFAULT_RULES.incomeTarget).toBeNull();
    expect(DEFAULT_RULES.protectedWindows).toEqual([]);
    expect(DEFAULT_RULES.travel).toEqual([]);
    expect(DEFAULT_RULES.deadlineDay).toEqual({
      sessionMinutes: 180,
      earliestStart: "17:00",
      latestEnd: "23:00",
    });
    expect(DEFAULT_RULES.earlyTouch).toEqual({ daysBefore: 3, minutes: 25 });
    expect(DEFAULT_RULES.gym).toBeNull();
    expect(DEFAULT_RULES.slipDefaultAfterMinutes).toBe(30);
    expect(DEFAULT_RULES.interruptsPerDay).toBe(3);
  });
});

describe("parseRules", () => {
  test("an empty, missing or null input is the defaults", () => {
    expect(parseRules({})).toEqual(DEFAULT_RULES);
    expect(parseRules(undefined)).toEqual(DEFAULT_RULES);
    expect(parseRules(null)).toEqual(DEFAULT_RULES);
  });

  test("merges over the defaults and leaves the rest alone", () => {
    const rules = parseRules({ lightsOut: "01:00", bufferMinutes: 0 });
    expect(rules.lightsOut).toBe("01:00");
    expect(rules.bufferMinutes).toBe(0);
    expect(rules.noFocusBefore).toBe(DEFAULT_RULES.noFocusBefore);
    expect(rules.blockMinutes).toEqual(DEFAULT_RULES.blockMinutes);
  });

  test("merges nested objects key by key", () => {
    const rules = parseRules({
      blockMinutes: { standard: 45 },
      capacity: { ok: { blocks: 4 } },
      deadlineDay: { sessionMinutes: 120 },
      earlyTouch: { minutes: 15 },
    });
    expect(rules.blockMinutes).toEqual({ floor: 25, standard: 45, long: 120 });
    expect(rules.capacity.ok).toEqual({
      blocks: 4,
      small: 0,
      gym: false,
      social: false,
    });
    expect(rules.capacity.good).toEqual(DEFAULT_RULES.capacity.good);
    expect(rules.deadlineDay).toEqual({
      sessionMinutes: 120,
      earliestStart: "17:00",
      latestEnd: "23:00",
    });
    expect(rules.earlyTouch).toEqual({ daysBefore: 3, minutes: 15 });
  });

  test("arrays and nullable objects replace instead of merging", () => {
    const rules = parseRules({
      capExemptRanges: [{ from: "2026-12-22", to: "2027-01-04" }],
      travel: [
        {
          calendarId: null,
          locationIncludes: "campus",
          minutesBefore: 20,
          minutesAfter: 20,
        },
      ],
      incomeTarget: { lane: "lane-a", weeklyHours: 10, blockMinutes: 120 },
      gym: { perWeek: 2, minutes: 60, notBefore: "16:00" },
      wakeByWeekday: [
        "11:30",
        "10:30",
        "09:30",
        "10:30",
        "09:30",
        "10:30",
        "11:30",
      ],
    });
    expect(rules.capExemptRanges).toEqual([
      { from: "2026-12-22", to: "2027-01-04" },
    ]);
    expect(rules.travel).toHaveLength(1);
    expect(rules.incomeTarget).toEqual({
      lane: "lane-a",
      weeklyHours: 10,
      blockMinutes: 120,
    });
    expect(rules.gym).toEqual({ perWeek: 2, minutes: 60, notBefore: "16:00" });
    expect(rules.wakeByWeekday[2]).toBe("09:30");
  });

  test("an explicit null clears a nullable field", () => {
    const rules = parseRules({ weeklyHourCap: 24, gym: null });
    expect(rules.weeklyHourCap).toBe(24);
    expect(rules.gym).toBeNull();
  });

  test("throws on a malformed wall time", () => {
    expect(() => parseRules({ lightsOut: "25:00" })).toThrow();
    expect(() => parseRules({ noFocusBefore: "9:00" })).toThrow();
    expect(() => parseRules({ deadlineDay: { latestEnd: "eleven" } })).toThrow();
    expect(() =>
      parseRules({
        protectedWindows: [
          { weekday: 1, from: "18:00", to: "24:00", unlessDueToday: false },
        ],
      }),
    ).toThrow();
  });

  test("throws on a malformed date key", () => {
    expect(() =>
      parseRules({ capExemptRanges: [{ from: "2026-12-22", to: "22/01/2027" }] }),
    ).toThrow();
    expect(() =>
      parseRules({ capExemptRanges: [{ from: "2026-13-01", to: "2026-13-02" }] }),
    ).toThrow();
  });

  test("throws on an unknown time zone", () => {
    expect(() => parseRules({ timeZone: "Mars/Olympus" })).toThrow();
    expect(() => parseRules({ timeZone: "" })).toThrow();
    expect(parseRules({ timeZone: "Asia/Tokyo" }).timeZone).toBe("Asia/Tokyo");
  });

  test("throws on a wake list that is not seven days", () => {
    expect(() => parseRules({ wakeByWeekday: ["08:00", "08:00"] })).toThrow();
  });

  test("throws on an input that is not an object", () => {
    expect(() => parseRules("08:00")).toThrow();
    expect(() => parseRules(7)).toThrow();
  });
});
