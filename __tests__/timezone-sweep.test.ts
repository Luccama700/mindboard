// Table-driven regression suite for the UTC-clock defect class (audit
// 2026-07-28, plan of record item 2). Every row here is a fact that was wrong
// when a server-side caller took the process clock — which is UTC on Vercel —
// instead of the user's stored timezone.
//
// Three zones on purpose: America/Vancouver (negative offset, observes DST),
// Asia/Tokyo (positive offset, never observes DST — the only zone where the
// balance-recompute bug bit), and UTC (the process clock itself, which must
// keep behaving exactly as before). Both 2026 US/Canada DST boundaries are
// covered: spring-forward 2026-03-08 (02:00 PST -> 03:00 PDT, i.e. 10:00Z) and
// fall-back 2026-11-01 (02:00 PDT -> 01:00 PST, i.e. 09:00Z).
//
// ON "how many of these catch a regression": vitest.config.mts now pins
// process.env.TZ = "UTC", so the answer is stable rather than a property of
// whoever ran it. It is still not a meaningful headline number — under the pin
// the UTC rows agree with pre-fix code by construction, which is the point of
// having Vancouver and Tokyo rows beside them. The assertions that hold
// regardless of any host setting live in __tests__/timezone-call-sites.test.ts
// (Asia/Tokyo at an instant whose day differs from both UTC and Vancouver) and
// __tests__/timezone-write-paths.test.tsx.

import { afterEach, describe, expect, test, vi } from "vitest";

import { safeTimeZone, todayISO } from "@/app/_components/date-utils";
import { deriveBalance } from "@/app/lib/finance/derive";
import {
  occurrenceBusyEvents,
  slotBusyEvents,
  type RecurringSlot,
  type RecurringTaskRule,
} from "@/app/lib/recurrence";
import { freeGaps, scheduleSnapshot } from "@/app/lib/snapshots/schedule";
import { zonedDateKey } from "@/app/lib/snapshots/zoned-time";

const VANCOUVER = "America/Vancouver";
const TOKYO = "Asia/Tokyo";
const UTC = "UTC";

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// todayISO: which calendar day is "today"
// ---------------------------------------------------------------------------

type DayCase = {
  label: string;
  instant: number;
  expected: Record<string, string>;
};

const DAY_CASES: DayCase[] = [
  {
    // The habit-completion bug: 18:30 on the 27th in Vancouver, already the
    // 28th in UTC. The completion guard rejected every evening tap.
    label: "summer evening in Vancouver, already tomorrow in UTC",
    instant: Date.UTC(2026, 6, 28, 1, 30),
    expected: {
      [VANCOUVER]: "2026-07-27",
      [TOKYO]: "2026-07-28",
      [UTC]: "2026-07-28",
    },
  },
  {
    // The mirror case: Tokyo's morning is still yesterday in UTC. This is the
    // one that silently dropped same-day ledger rows from the cached balance.
    label: "summer morning in Tokyo, still yesterday in UTC",
    instant: Date.UTC(2026, 6, 27, 22, 30),
    expected: {
      [VANCOUVER]: "2026-07-27",
      [TOKYO]: "2026-07-28",
      [UTC]: "2026-07-27",
    },
  },
  {
    label: "winter (PST) late evening in Vancouver",
    instant: Date.UTC(2026, 0, 15, 7, 30),
    expected: {
      [VANCOUVER]: "2026-01-14",
      [TOKYO]: "2026-01-15",
      [UTC]: "2026-01-15",
    },
  },
  {
    label: "spring-forward day, minutes before the 02:00 PST jump",
    instant: Date.UTC(2026, 2, 8, 9, 59),
    expected: {
      [VANCOUVER]: "2026-03-08",
      [TOKYO]: "2026-03-08",
      [UTC]: "2026-03-08",
    },
  },
  {
    label: "spring-forward day, minutes after the jump to PDT",
    instant: Date.UTC(2026, 2, 8, 10, 1),
    expected: {
      [VANCOUVER]: "2026-03-08",
      [TOKYO]: "2026-03-08",
      [UTC]: "2026-03-08",
    },
  },
  {
    label: "the PST evening before spring-forward is still the 7th locally",
    instant: Date.UTC(2026, 2, 8, 7, 30),
    expected: {
      [VANCOUVER]: "2026-03-07",
      [TOKYO]: "2026-03-08",
      [UTC]: "2026-03-08",
    },
  },
  {
    label: "fall-back day, 01:30 PDT (before the repeat)",
    instant: Date.UTC(2026, 10, 1, 8, 30),
    expected: {
      [VANCOUVER]: "2026-11-01",
      [TOKYO]: "2026-11-01",
      [UTC]: "2026-11-01",
    },
  },
  {
    label: "fall-back day, 01:30 PST (the repeated hour) is the same local day",
    instant: Date.UTC(2026, 10, 1, 9, 30),
    expected: {
      [VANCOUVER]: "2026-11-01",
      [TOKYO]: "2026-11-01",
      [UTC]: "2026-11-01",
    },
  },
  {
    label: "the PDT evening before fall-back is still October locally",
    instant: Date.UTC(2026, 10, 1, 6, 30),
    expected: {
      [VANCOUVER]: "2026-10-31",
      [TOKYO]: "2026-11-01",
      [UTC]: "2026-11-01",
    },
  },
];

describe("todayISO across zones and DST boundaries", () => {
  for (const { label, instant, expected } of DAY_CASES) {
    for (const zone of [VANCOUVER, TOKYO, UTC]) {
      test(`${label} — ${zone}`, () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(instant));
        expect(todayISO(zone)).toBe(expected[zone]);
      });
    }
  }

  test("an explicit null means the process clock, deliberately", () => {
    vi.useFakeTimers();
    // Constructed in the process zone, so this is the process clock's own day
    // whatever TZ the test host runs in.
    vi.setSystemTime(new Date(2026, 6, 27, 18, 30));
    expect(todayISO(null)).toBe("2026-07-27");
  });

  test("an unusable stored zone degrades to the process clock, never throws", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 27, 18, 30));
    expect(todayISO(safeTimeZone("America/Vancuver"))).toBe("2026-07-27");
  });
});

// ---------------------------------------------------------------------------
// Recurring busy blocks: a rule's due_time is a WALL CLOCK time in the zone
// ---------------------------------------------------------------------------

function dailyRule(overrides: Partial<RecurringTaskRule> = {}): RecurringTaskRule {
  return {
    id: "r1",
    title: "gym",
    due_time: "09:00",
    duration_min: null,
    frequency: "daily",
    weekdays: null,
    day_of_month: null,
    interval_days: null,
    start_date: null,
    ...overrides,
  };
}

type WallClockCase = {
  label: string;
  zone: string;
  dateKey: string;
  dueTime: string;
  expectedUtc: number;
};

const WALL_CLOCK_CASES: WallClockCase[] = [
  {
    label: "Vancouver summer (PDT, UTC-7)",
    zone: VANCOUVER,
    dateKey: "2026-07-06",
    dueTime: "09:00",
    expectedUtc: Date.UTC(2026, 6, 6, 16, 0),
  },
  {
    label: "Vancouver winter (PST, UTC-8)",
    zone: VANCOUVER,
    dateKey: "2026-01-06",
    dueTime: "09:00",
    expectedUtc: Date.UTC(2026, 0, 6, 17, 0),
  },
  {
    label: "Vancouver spring-forward day, before the jump (still PST)",
    zone: VANCOUVER,
    dateKey: "2026-03-08",
    dueTime: "01:00",
    expectedUtc: Date.UTC(2026, 2, 8, 9, 0),
  },
  {
    label: "Vancouver spring-forward day, after the jump (PDT)",
    zone: VANCOUVER,
    dateKey: "2026-03-08",
    dueTime: "09:00",
    expectedUtc: Date.UTC(2026, 2, 8, 16, 0),
  },
  {
    label: "Vancouver fall-back day, before the repeat (still PDT)",
    zone: VANCOUVER,
    dateKey: "2026-11-01",
    dueTime: "00:30",
    expectedUtc: Date.UTC(2026, 10, 1, 7, 30),
  },
  {
    label: "Vancouver fall-back day, after the repeat (PST)",
    zone: VANCOUVER,
    dateKey: "2026-11-01",
    dueTime: "09:00",
    expectedUtc: Date.UTC(2026, 10, 1, 17, 0),
  },
  {
    label: "Tokyo summer (JST, UTC+9 — no DST)",
    zone: TOKYO,
    dateKey: "2026-07-06",
    dueTime: "09:00",
    expectedUtc: Date.UTC(2026, 6, 6, 0, 0),
  },
  {
    label: "Tokyo winter is the same offset (no DST)",
    zone: TOKYO,
    dateKey: "2026-01-06",
    dueTime: "09:00",
    expectedUtc: Date.UTC(2026, 0, 6, 0, 0),
  },
  {
    label: "UTC is its own wall clock",
    zone: UTC,
    dateKey: "2026-07-06",
    dueTime: "09:00",
    expectedUtc: Date.UTC(2026, 6, 6, 9, 0),
  },
];

describe("occurrenceBusyEvents resolves due_time in the user's zone", () => {
  for (const { label, zone, dateKey, dueTime, expectedUtc } of WALL_CLOCK_CASES) {
    test(label, () => {
      const events = occurrenceBusyEvents(
        [dailyRule({ due_time: dueTime })],
        [dateKey],
        undefined,
        zone,
      );
      expect(events).toHaveLength(1);
      expect(new Date(events[0].start).getTime()).toBe(expectedUtc);
      // Default 30-minute occupancy is measured in real elapsed time, so it is
      // unaffected by a DST transition inside the block.
      expect(new Date(events[0].end).getTime() - expectedUtc).toBe(30 * 60_000);
    });
  }
});

describe("slotBusyEvents resolves start_time in the user's zone", () => {
  for (const { label, zone, dateKey, dueTime, expectedUtc } of WALL_CLOCK_CASES) {
    test(label, () => {
      const slots: RecurringSlot[] = [
        {
          rule_id: "r1",
          occurred_on: dateKey,
          start_time: `${dueTime}:00`,
          duration_min: 45,
        },
      ];
      const events = slotBusyEvents(
        slots,
        [{ id: "r1", title: "gym", duration_min: null }],
        zone,
      );
      expect(events).toHaveLength(1);
      expect(new Date(events[0].start).getTime()).toBe(expectedUtc);
      expect(new Date(events[0].end).getTime() - expectedUtc).toBe(45 * 60_000);
    });
  }
});

// ---------------------------------------------------------------------------
// The audit's exact repro: free hours on the dashboard pulse
// ---------------------------------------------------------------------------

describe("free-time math with zone-built busy blocks", () => {
  // 2026-07-06T15:00Z is 08:00 in Vancouver — the start of the default wake
  // window (08:00–22:00), so a clean 14 free hours before any commitments.
  const now = new Date(Date.UTC(2026, 6, 6, 15, 0));
  const gym = dailyRule({ due_time: "09:00", duration_min: null });
  const dayKeys = ["2026-07-06", "2026-07-07"];

  test("a 09:00 Vancouver routine subtracts its half hour from the day", () => {
    const events = occurrenceBusyEvents([gym], dayKeys, undefined, VANCOUVER);
    expect(
      scheduleSnapshot({
        events,
        now,
        wakeStartHour: 8,
        wakeEndHour: 22,
        timeZone: VANCOUVER,
      }).freeHoursToday,
    ).toBe(13.5);
  });

  test("regression: the same routine built on the UTC clock subtracts nothing", () => {
    // 09:00Z is 02:00 in Vancouver — outside the wake window entirely, so the
    // pulse reported a full 14 free hours. This is the shape of the bug.
    const events = occurrenceBusyEvents([gym], dayKeys, undefined, UTC);
    expect(
      scheduleSnapshot({
        events,
        now,
        wakeStartHour: 8,
        wakeEndHour: 22,
        timeZone: VANCOUVER,
      }).freeHoursToday,
    ).toBe(14);
  });

  test("freeGaps splits the Vancouver day around the routine", () => {
    const events = occurrenceBusyEvents([gym], dayKeys, undefined, VANCOUVER);
    const gaps = freeGaps({
      events,
      now,
      wakeStartHour: 8,
      wakeEndHour: 22,
      timeZone: VANCOUVER,
      limit: 2,
    });
    expect(gaps).toEqual([
      { dateKey: "2026-07-06", start: "08:00", end: "09:00", minutes: 60 },
      { dateKey: "2026-07-06", start: "09:30", end: "22:00", minutes: 750 },
    ]);
  });

  test("the same wake window in Tokyo is anchored to Tokyo's day", () => {
    // 2026-07-06T00:00Z is 09:00 in Tokyo: one hour into the wake window, so
    // 13 hours remain, minus the 30-minute 09:00 routine that starts exactly
    // now.
    const tokyoNow = new Date(Date.UTC(2026, 6, 6, 0, 0));
    const events = occurrenceBusyEvents([gym], dayKeys, undefined, TOKYO);
    expect(
      scheduleSnapshot({
        events,
        now: tokyoNow,
        wakeStartHour: 8,
        wakeEndHour: 22,
        timeZone: TOKYO,
      }).freeHoursToday,
    ).toBe(12.5);
  });

  test("UTC behaves exactly as the process clock did before the sweep", () => {
    const utcNow = new Date(Date.UTC(2026, 6, 6, 8, 0));
    const events = occurrenceBusyEvents([gym], dayKeys, undefined, UTC);
    expect(
      scheduleSnapshot({
        events,
        now: utcNow,
        wakeStartHour: 8,
        wakeEndHour: 22,
        timeZone: UTC,
      }).freeHoursToday,
    ).toBe(13.5);
  });
});

// ---------------------------------------------------------------------------
// Balance recompute: a same-day row must not read as future-dated
// ---------------------------------------------------------------------------

describe("deriveBalance with the user's today", () => {
  const anchor = {
    balance: 100,
    as_of: "2026-07-26",
    created_at: "2026-07-26T10:00:00.000Z",
  };
  // Logged at 08:10 on 2026-07-28 in Tokyo, which is still 2026-07-27 in UTC.
  const rows = [
    {
      occurred_at: "2026-07-28",
      direction: "out" as const,
      amount: 10,
      created_at: "2026-07-27T23:10:00.000Z",
    },
  ];

  test("Tokyo: the row counts, because it is today in the user's zone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 27, 23, 10)));
    expect(deriveBalance(anchor, rows, todayISO(TOKYO))).toBe(90);
  });

  test("regression: on the UTC process clock the same row is dropped", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 27, 23, 10)));
    expect(todayISO(UTC)).toBe("2026-07-27");
    expect(deriveBalance(anchor, rows, todayISO(UTC))).toBe(100);
  });

  test("Vancouver is never affected — a negative offset cannot look ahead", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 27, 23, 10)));
    // Same instant, 16:10 on the 27th locally. A row the user could have
    // written today is dated on or before their today, so it still counts.
    const localRows = [{ ...rows[0], occurred_at: "2026-07-27" }];
    expect(deriveBalance(anchor, localRows, todayISO(VANCOUVER))).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// Wage-shift bucketing: which day a timed calendar event is filed under
// ---------------------------------------------------------------------------

describe("timed events bucket onto the user's calendar day", () => {
  // A Friday 18:00–23:00 Vancouver shift: 2026-07-04T01:00Z–06:00Z, i.e. all of
  // it lands on Saturday in UTC and falls outside the Friday pay period.
  const shiftStart = Date.UTC(2026, 6, 4, 1, 0);

  test.each([
    [VANCOUVER, "2026-07-03"],
    [TOKYO, "2026-07-04"],
    [UTC, "2026-07-04"],
  ])("%s files the shift on %s", (zone, expected) => {
    expect(zonedDateKey(shiftStart, zone)).toBe(expected);
  });
});
