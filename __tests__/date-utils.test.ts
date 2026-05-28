import { afterEach, describe, expect, test, vi } from "vitest";
import {
  daysFromToday,
  formatClockTime,
  formatDue,
  formatHourLabel,
  formatLongWeekdayMonthDay,
  formatMonthDay,
  formatMonthYear,
  formatWeekdayMonthDay,
  priorityRank,
  todayISO,
} from "@/app/_components/date-utils";

describe("date utilities", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("formats today-relative due dates from the local calendar day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 23, 12));

    expect(todayISO()).toBe("2026-05-23");
    expect(formatDue("2026-05-23")).toBe("today");
    expect(formatDue("2026-05-25")).toBe("May 25");
    expect(daysFromToday("2026-05-22")).toBe(-1);
    expect(daysFromToday("2026-05-23")).toBe(0);
    expect(daysFromToday("2026-05-30")).toBe(7);
  });

  test("formats calendar labels consistently", () => {
    const date = new Date(2026, 4, 23, 14, 5);

    expect(formatClockTime("2026-05-23T14:05:00")).toBe("14:05");
    expect(formatHourLabel(6)).toBe("06");
    expect(formatMonthYear(date)).toBe("May 2026");
    expect(formatMonthDay(date)).toBe("May 23");
    expect(formatMonthDay(date, false)).toBe("23");
    expect(formatWeekdayMonthDay(date)).toBe("Sat, May 23");
    expect(formatLongWeekdayMonthDay(date)).toBe("Saturday, May 23");
  });

  test("orders known task priorities and defaults unknown values to medium", () => {
    expect(priorityRank("high")).toBeLessThan(priorityRank("med"));
    expect(priorityRank("med")).toBeLessThan(priorityRank("low"));
    expect(priorityRank("unexpected")).toBe(priorityRank("med"));
  });
});
