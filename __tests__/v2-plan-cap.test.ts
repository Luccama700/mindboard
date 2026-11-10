// Task 2, the weekly cap: the week starts on Monday in the user's own date
// keys, and the room left is the cap minus the rest of the week minus the
// capped hours already fixed on this day.

import { describe, expect, test } from "vitest";

import { parseRules } from "@/app/lib/v2/rules";
import { capRoomHours, weekStartKey } from "@/app/lib/v2/plan/cap";
import type { FixedEvent, WeekStats } from "@/app/lib/v2/types";

const DATE = "2026-03-10";

const week = (over: Partial<WeekStats> = {}): WeekStats => ({
  capHoursElsewhere: over.capHoursElsewhere ?? 0,
  incomeHoursElsewhere: over.incomeHoursElsewhere ?? 0,
  gymSessionsDone: over.gymSessionsDone ?? 0,
});

function shift(
  over: Partial<FixedEvent> & { start: string; end: string },
): FixedEvent {
  return {
    id: over.id ?? "shift-1",
    title: over.title ?? "Shift",
    allDay: over.allDay ?? false,
    calendarId: over.calendarId ?? null,
    location: over.location ?? null,
    countsTowardCap: over.countsTowardCap ?? true,
    source: over.source ?? "google",
    start: over.start,
    end: over.end,
  };
}

describe("weekStartKey", () => {
  test("gives the Monday of that week", () => {
    expect(weekStartKey("2026-03-09")).toBe("2026-03-09"); // Monday
    expect(weekStartKey("2026-03-10")).toBe("2026-03-09"); // Tuesday
    expect(weekStartKey("2026-03-14")).toBe("2026-03-09"); // Saturday
  });

  test("a Sunday belongs to the week that started six days earlier", () => {
    expect(weekStartKey("2026-03-08")).toBe("2026-03-02");
  });

  test("crosses month and year boundaries", () => {
    expect(weekStartKey("2026-03-01")).toBe("2026-02-23");
    expect(weekStartKey("2026-01-01")).toBe("2025-12-29");
  });
});

describe("capRoomHours", () => {
  test("is Infinity when there is no cap", () => {
    expect(capRoomHours(DATE, [], week(), parseRules({}))).toBe(Infinity);
  });

  test("is Infinity inside an exempt range, inclusive of both ends", () => {
    const rules = parseRules({
      weeklyHourCap: 24,
      capExemptRanges: [{ from: "2026-03-09", to: "2026-03-15" }],
    });
    expect(capRoomHours("2026-03-09", [], week(), rules)).toBe(Infinity);
    expect(capRoomHours("2026-03-15", [], week(), rules)).toBe(Infinity);
    expect(capRoomHours("2026-03-16", [], week(), rules)).toBe(24);
  });

  test("subtracts the rest of the week and this day's capped hours", () => {
    const rules = parseRules({ weeklyHourCap: 24 });
    const fixed = [
      shift({
        start: `${DATE}T13:00:00+00:00`,
        end: `${DATE}T17:30:00+00:00`,
      }),
    ];
    expect(
      capRoomHours(DATE, fixed, week({ capHoursElsewhere: 16 }), rules),
    ).toBe(3.5);
  });

  test("ignores events that do not count and all-day events", () => {
    const rules = parseRules({ weeklyHourCap: 24 });
    const fixed = [
      shift({
        id: "class",
        countsTowardCap: false,
        start: `${DATE}T13:00:00+00:00`,
        end: `${DATE}T17:00:00+00:00`,
      }),
      shift({
        id: "away",
        allDay: true,
        start: `${DATE}T00:00:00+00:00`,
        end: "2026-03-11T00:00:00+00:00",
      }),
    ];
    expect(capRoomHours(DATE, fixed, week(), rules)).toBe(24);
  });

  test("never goes below zero", () => {
    const rules = parseRules({ weeklyHourCap: 24 });
    expect(
      capRoomHours(DATE, [], week({ capHoursElsewhere: 30 }), rules),
    ).toBe(0);
  });
});
