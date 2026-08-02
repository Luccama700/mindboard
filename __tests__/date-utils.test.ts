import { afterEach, describe, expect, test, vi } from "vitest";
import {
  daysFromToday,
  formatClock12,
  formatClockTime,
  formatDue,
  formatHourLabel,
  formatLongWeekdayMonthDay,
  formatMonthDay,
  formatMonthYear,
  formatRelativeToNow,
  formatWeekdayMonthDay,
  priorityRank,
  safeTimeZone,
  todayISO,
} from "@/app/_components/date-utils";

describe("date utilities", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("formats today-relative due dates from the local calendar day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 23, 12));

    expect(todayISO(null)).toBe("2026-05-23");
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

  test("timezone-aware helpers use the given zone's wall clock, not the process clock", () => {
    // 2026-07-07T06:38Z is 11:38pm on July 6 in Vancouver.
    const lateEvening = new Date("2026-07-07T06:38:00Z");

    expect(formatClock12(lateEvening, "America/Vancouver")).toBe("11:38pm");
    expect(
      formatLongWeekdayMonthDay(lateEvening, "America/Vancouver"),
    ).toBe("Monday, Jul 6");

    vi.useFakeTimers();
    vi.setSystemTime(lateEvening);
    expect(todayISO("America/Vancouver")).toBe("2026-07-06");
  });

  test("safeTimeZone rejects zones Intl cannot use", () => {
    expect(safeTimeZone("America/Vancouver")).toBe("America/Vancouver");
    expect(safeTimeZone("America/Vancuver")).toBeNull();
    expect(safeTimeZone(null)).toBeNull();
    expect(safeTimeZone("")).toBeNull();
  });

  test("orders known task priorities and defaults unknown values to medium", () => {
    expect(priorityRank("high")).toBeLessThan(priorityRank("med"));
    expect(priorityRank("med")).toBeLessThan(priorityRank("low"));
    expect(priorityRank("unexpected")).toBe(priorityRank("med"));
  });

  test("formatDue formats a past (overdue) date like any other non-today date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 23, 12));
    expect(formatDue("2026-05-20")).toBe("May 20");
  });

  describe("formatRelativeToNow", () => {
    const NOW = new Date(2026, 4, 23, 12, 0, 0);

    test("a past or already-arrived instant reads as now", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      expect(formatRelativeToNow(NOW.toISOString())).toBe("now"); // diffMs === 0
      expect(formatRelativeToNow(new Date(NOW.getTime() - 60_000).toISOString())).toBe(
        "now",
      );
    });

    test("an unparseable date also reads as now rather than throwing", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      expect(formatRelativeToNow("not-a-date")).toBe("now");
    });

    test("under an hour is minutes", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      expect(
        formatRelativeToNow(new Date(NOW.getTime() + 30 * 60_000).toISOString()),
      ).toBe("in 30m");
      expect(
        formatRelativeToNow(new Date(NOW.getTime() + 59 * 60_000).toISOString()),
      ).toBe("in 59m");
    });

    test("exactly 60 minutes crosses into the hour bucket", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      expect(
        formatRelativeToNow(new Date(NOW.getTime() + 60 * 60_000).toISOString()),
      ).toBe("in 1h");
    });

    test("hours round to one decimal place", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      expect(
        formatRelativeToNow(new Date(NOW.getTime() + 150 * 60_000).toISOString()),
      ).toBe("in 2.5h");
    });

    test("exactly 24 hours crosses into the day bucket", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      expect(
        formatRelativeToNow(new Date(NOW.getTime() + 24 * 60 * 60_000).toISOString()),
      ).toBe("in 1d");
      expect(
        formatRelativeToNow(new Date(NOW.getTime() + 3 * 24 * 60 * 60_000).toISOString()),
      ).toBe("in 3d");
    });
  });
});
