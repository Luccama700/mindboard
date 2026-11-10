import { describe, expect, test } from "vitest";

import { energyAsk, slipAsk } from "@/app/lib/v2/asks/builders";
import type { Block, PlannerRules } from "@/app/lib/v2/types";

function makeRules(overrides: Partial<PlannerRules> = {}): PlannerRules {
  const cap = { blocks: 2, small: 2, gym: false, social: false };
  return {
    timeZone: "Asia/Tokyo",
    wakeByWeekday: ["09:00", "07:00", "07:00", "07:00", "07:00", "07:00", "07:00"],
    lightsOut: "23:00",
    noFocusBefore: "09:00",
    blockMinutes: { floor: 25, standard: 50, long: 120 },
    bufferMinutes: 10,
    capacity: { low: cap, ok: cap, good: cap },
    hardWindowHours: 72,
    maxBlocksPerLanePerDay: 1,
    weeklyHourCap: null,
    capExemptRanges: [],
    incomeTarget: null,
    protectedWindows: [],
    travel: [],
    deadlineDay: { sessionMinutes: 90, earliestStart: "09:00", latestEnd: "20:00" },
    earlyTouch: { daysBefore: 2, minutes: 15 },
    gym: null,
    slipDefaultAfterMinutes: 30,
    interruptsPerDay: 3,
    ...overrides,
  };
}

function makeBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: "blk-7",
    date: "2026-07-08",
    start: "2026-07-08T10:00:00+09:00",
    end: "2026-07-08T10:50:00+09:00",
    kind: "focus",
    lane: "lane-a",
    taskId: "task-1",
    title: "Write the outline",
    state: "started",
    reason: "lane-next",
    ...overrides,
  };
}

const DASHES = /[–—]/;

describe("slipAsk", () => {
  const now = "2026-07-08T10:50:00+09:00";
  const draft = slipAsk(makeBlock(), "user-9", makeRules(), now);

  test("identity: kind, user, topic and dedupe key", () => {
    expect(draft.kind).toBe("slip");
    expect(draft.userId).toBe("user-9");
    expect(draft.topic).toBe("block:blk-7");
    expect(draft.dedupeKey).toBe("slip:blk-7");
  });

  test("text names the block", () => {
    expect(draft.text).toBe("Still doing Write the outline?");
  });

  test("is time-critical, opens now and has no reminder", () => {
    expect(draft.timeCritical).toBe(true);
    expect(draft.openedAt).toBe(now);
    expect(draft.remindAt).toBeNull();
  });

  test("expires slipDefaultAfterMinutes after now", () => {
    expect(Date.parse(draft.expiresAt)).toBe(Date.parse(now) + 30 * 60_000);
    const longer = slipAsk(makeBlock(), "user-9", makeRules({ slipDefaultAfterMinutes: 45 }), now);
    expect(Date.parse(longer.expiresAt)).toBe(Date.parse(now) + 45 * 60_000);
  });

  test("expiry is an instant with an explicit offset", () => {
    expect(draft.expiresAt).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
  });

  test("options come in order with the right labels and effects", () => {
    expect(draft.options).toEqual([
      { id: "did", label: "Did it", effect: { type: "block.done", blockId: "blk-7", fraction: 1 } },
      {
        id: "later",
        label: "Later today",
        effect: { type: "block.reschedule", blockId: "blk-7", to: "later-today" },
      },
      {
        id: "tomorrow",
        label: "Tomorrow",
        effect: { type: "block.reschedule", blockId: "blk-7", to: "tomorrow" },
      },
      { id: "drop", label: "Drop", effect: { type: "block.drop", blockId: "blk-7" } },
    ]);
  });

  test("the default is later, and it is one of the options", () => {
    expect(draft.defaultOptionId).toBe("later");
    expect(draft.options.map((o) => o.id)).toContain(draft.defaultOptionId);
  });

  test("option ids are short and URL-safe", () => {
    for (const option of draft.options) {
      expect(option.id.length).toBeLessThanOrEqual(12);
      expect(option.id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  test("a different block gets its own topic, key and effects", () => {
    const other = slipAsk(makeBlock({ id: "blk-8", title: "Read" }), "user-9", makeRules(), now);
    expect(other.topic).toBe("block:blk-8");
    expect(other.dedupeKey).toBe("slip:blk-8");
    expect(other.text).toBe("Still doing Read?");
    expect(other.options[0].effect).toEqual({ type: "block.done", blockId: "blk-8", fraction: 1 });
  });

  test("user-facing copy has no en or em dash", () => {
    expect(draft.text).not.toMatch(DASHES);
    for (const option of draft.options) expect(option.label).not.toMatch(DASHES);
  });
});

describe("energyAsk", () => {
  const rules = makeRules();
  const draft = energyAsk("2026-07-08", "user-9", rules, "2026-07-08T07:30:00+09:00");

  test("identity: kind, user, topic and dedupe key", () => {
    expect(draft.kind).toBe("energy");
    expect(draft.userId).toBe("user-9");
    expect(draft.topic).toBe("energy:2026-07-08");
    expect(draft.dedupeKey).toBe("energy:2026-07-08");
  });

  test("text is the plain question", () => {
    expect(draft.text).toBe("Energy today?");
  });

  test("is time-critical, opens now and has no reminder", () => {
    expect(draft.timeCritical).toBe(true);
    expect(draft.openedAt).toBe("2026-07-08T07:30:00+09:00");
    expect(draft.remindAt).toBeNull();
  });

  test("expires at 12:00 local on the date", () => {
    // 12:00 in Tokyo is 03:00 UTC.
    expect(Date.parse(draft.expiresAt)).toBe(Date.UTC(2026, 6, 8, 3, 0, 0));
  });

  test("expiry follows the zone across a daylight-saving change", () => {
    const ny = makeRules({ timeZone: "America/New_York" });
    // 2026-03-08: New York is already on EDT (UTC-4) by noon.
    const spring = energyAsk("2026-03-08", "user-9", ny, "2026-03-08T07:00:00-04:00");
    expect(Date.parse(spring.expiresAt)).toBe(Date.UTC(2026, 2, 8, 16, 0, 0));
    // 2026-11-01: clocks fall back at 02:00, so noon is EST (UTC-5).
    const fall = energyAsk("2026-11-01", "user-9", ny, "2026-11-01T07:00:00-05:00");
    expect(Date.parse(fall.expiresAt)).toBe(Date.UTC(2026, 10, 1, 17, 0, 0));
  });

  test("expiry for a zone without daylight saving", () => {
    const phoenix = makeRules({ timeZone: "America/Phoenix" });
    const result = energyAsk("2026-07-08", "user-9", phoenix, "2026-07-08T07:00:00-07:00");
    expect(Date.parse(result.expiresAt)).toBe(Date.UTC(2026, 6, 8, 19, 0, 0));
    const utc = energyAsk("2026-07-08", "user-9", makeRules({ timeZone: "UTC" }), "2026-07-08T07:00:00Z");
    expect(Date.parse(utc.expiresAt)).toBe(Date.UTC(2026, 6, 8, 12, 0, 0));
  });

  test("options are low, ok and good, each setting that date's energy", () => {
    expect(draft.options).toEqual([
      { id: "low", label: "Low", effect: { type: "energy.set", date: "2026-07-08", energy: "low" } },
      { id: "ok", label: "OK", effect: { type: "energy.set", date: "2026-07-08", energy: "ok" } },
      { id: "good", label: "Good", effect: { type: "energy.set", date: "2026-07-08", energy: "good" } },
    ]);
  });

  test("the default is ok, and it is one of the options", () => {
    expect(draft.defaultOptionId).toBe("ok");
    expect(draft.options.map((o) => o.id)).toContain(draft.defaultOptionId);
  });

  test("user-facing copy has no en or em dash", () => {
    expect(draft.text).not.toMatch(DASHES);
    for (const option of draft.options) expect(option.label).not.toMatch(DASHES);
  });
});
