import { describe, expect, test } from "vitest";

import { decideDelivery, type DeliveryContext } from "@/app/lib/v2/asks/policy";
import type { Ask, PlannerRules } from "@/app/lib/v2/types";

function makeRules(overrides: Partial<PlannerRules> = {}): PlannerRules {
  const cap = { blocks: 2, small: 2, gym: false, social: false };
  return {
    timeZone: "Asia/Tokyo",
    wakeByWeekday: ["10:00", "07:00", "07:00", "07:00", "07:00", "07:00", "07:00"],
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

function makeAsk(overrides: Partial<Ask> = {}): Ask {
  return {
    id: "ask-1",
    userId: "user-1",
    kind: "slip",
    topic: "block:b1",
    text: "Still doing it?",
    options: [{ id: "ok", label: "OK", effect: { type: "none" } }],
    defaultOptionId: "ok",
    timeCritical: true,
    openedAt: "2026-07-08T12:00:00+09:00",
    remindAt: null,
    remindedAt: null,
    expiresAt: "2026-07-08T12:30:00+09:00",
    status: "open",
    answeredOptionId: null,
    answeredAt: null,
    assumed: false,
    dedupeKey: "slip:b1",
    ...overrides,
  };
}

// 2026-07-08 is a Wednesday. Asia/Tokyo has no daylight saving time.
function makeCtx(overrides: Partial<DeliveryContext> = {}): DeliveryContext {
  return {
    now: "2026-07-08T12:00:00+09:00",
    rules: makeRules(),
    interruptsSentToday: 0,
    unansweredOnTopicThisWeek: 0,
    weeklyAnswerRate: null,
    roughDay: false,
    ...overrides,
  };
}

describe("decideDelivery: quiet hours", () => {
  test("holds from lights out", () => {
    const ctx = makeCtx({ now: "2026-07-08T23:00:00+09:00" });
    expect(decideDelivery(makeAsk(), ctx)).toBe("hold");
  });

  test("holds up to the wake target of the day the night ends in", () => {
    const ctx = makeCtx({ now: "2026-07-09T06:59:00+09:00" });
    expect(decideDelivery(makeAsk(), ctx)).toBe("hold");
  });

  test("the wake target itself is no longer quiet", () => {
    const ctx = makeCtx({ now: "2026-07-09T07:00:00+09:00" });
    expect(decideDelivery(makeAsk(), ctx)).toBe("interrupt");
  });

  test("the minute before lights out is not quiet", () => {
    const ctx = makeCtx({ now: "2026-07-08T22:59:00+09:00" });
    expect(decideDelivery(makeAsk(), ctx)).toBe("interrupt");
  });

  test("uses the wake target of the weekday the night ends in", () => {
    // Saturday night into Sunday: Sunday's wake target is 10:00.
    const sundayMorning = makeCtx({ now: "2026-07-12T08:30:00+09:00" });
    expect(decideDelivery(makeAsk(), sundayMorning)).toBe("hold");
    // Sunday night into Monday: Monday's wake target is 07:00.
    const mondayMorning = makeCtx({ now: "2026-07-13T08:30:00+09:00" });
    expect(decideDelivery(makeAsk(), mondayMorning)).toBe("interrupt");
  });

  test("a lights-out time before 06:00 belongs to the next calendar day", () => {
    const rules = makeRules({ lightsOut: "01:00" });
    // 00:30 on the 9th is still the planning day that began on the 8th.
    const stillUp = makeCtx({ rules, now: "2026-07-09T00:30:00+09:00" });
    expect(decideDelivery(makeAsk(), stillUp)).toBe("interrupt");
    // The late evening before is nowhere near quiet.
    const evening = makeCtx({ rules, now: "2026-07-08T23:30:00+09:00" });
    expect(decideDelivery(makeAsk(), evening)).toBe("interrupt");
    // After 01:00 the night has started and runs to that day's wake target.
    const night = makeCtx({ rules, now: "2026-07-09T01:30:00+09:00" });
    expect(decideDelivery(makeAsk(), night)).toBe("hold");
    const lastMinute = makeCtx({ rules, now: "2026-07-09T06:59:00+09:00" });
    expect(decideDelivery(makeAsk(), lastMinute)).toBe("hold");
    const awake = makeCtx({ rules, now: "2026-07-09T07:00:00+09:00" });
    expect(decideDelivery(makeAsk(), awake)).toBe("interrupt");
  });

  test("quiet hours follow the user's zone, not UTC", () => {
    // 14:00 UTC on the 8th is 23:00 in Tokyo: quiet. 13:59 UTC is not.
    expect(decideDelivery(makeAsk(), makeCtx({ now: "2026-07-08T14:00:00Z" }))).toBe("hold");
    expect(decideDelivery(makeAsk(), makeCtx({ now: "2026-07-08T13:59:00Z" }))).toBe("interrupt");
  });

  test("quiet hours hold across a daylight-saving change", () => {
    // New York springs forward at 02:00 on 2026-03-08, a Sunday. Wake is 07:00 EDT.
    const rules = makeRules({
      timeZone: "America/New_York",
      wakeByWeekday: ["07:00", "07:00", "07:00", "07:00", "07:00", "07:00", "07:00"],
    });
    const asleep = makeCtx({ rules, now: "2026-03-08T06:30:00-04:00" });
    expect(decideDelivery(makeAsk(), asleep)).toBe("hold");
    const awake = makeCtx({ rules, now: "2026-03-08T07:00:00-04:00" });
    expect(decideDelivery(makeAsk(), awake)).toBe("interrupt");
  });

  test("a night-guard ask is not held by quiet hours", () => {
    const ctx = makeCtx({ now: "2026-07-08T23:30:00+09:00" });
    expect(decideDelivery(makeAsk({ kind: "night-guard" }), ctx)).toBe("interrupt");
  });

  test("quiet hours beat rough-day and budget rules for ordinary asks", () => {
    const ctx = makeCtx({ now: "2026-07-08T23:30:00+09:00", roughDay: true });
    expect(decideDelivery(makeAsk({ timeCritical: false }), ctx)).toBe("hold");
  });
});

describe("decideDelivery: topic backoff", () => {
  test("two unanswered asks on the topic this week hold the next one", () => {
    expect(decideDelivery(makeAsk(), makeCtx({ unansweredOnTopicThisWeek: 2 }))).toBe("hold");
  });

  test("more than two also hold", () => {
    expect(decideDelivery(makeAsk(), makeCtx({ unansweredOnTopicThisWeek: 5 }))).toBe("hold");
  });

  test("one unanswered ask does not hold", () => {
    expect(decideDelivery(makeAsk(), makeCtx({ unansweredOnTopicThisWeek: 1 }))).toBe("interrupt");
  });

  test("backoff beats a time-critical ask and a rough day", () => {
    const ctx = makeCtx({ unansweredOnTopicThisWeek: 2, roughDay: true });
    expect(decideDelivery(makeAsk({ timeCritical: true }), ctx)).toBe("hold");
  });
});

describe("decideDelivery: rough day", () => {
  test("everything is a digest, even a time-critical ask", () => {
    expect(decideDelivery(makeAsk({ timeCritical: true }), makeCtx({ roughDay: true }))).toBe(
      "digest",
    );
  });

  test("a non-critical ask is a digest too", () => {
    expect(decideDelivery(makeAsk({ timeCritical: false }), makeCtx({ roughDay: true }))).toBe(
      "digest",
    );
  });
});

describe("decideDelivery: time-critical and the interrupt budget", () => {
  test("an ask that is not time-critical goes to the digest", () => {
    expect(decideDelivery(makeAsk({ timeCritical: false }), makeCtx())).toBe("digest");
  });

  test("a time-critical ask interrupts while the day's budget has room", () => {
    expect(decideDelivery(makeAsk(), makeCtx({ interruptsSentToday: 0 }))).toBe("interrupt");
    expect(decideDelivery(makeAsk(), makeCtx({ interruptsSentToday: 2 }))).toBe("interrupt");
  });

  test("a time-critical ask goes to the digest once the budget is used", () => {
    expect(decideDelivery(makeAsk(), makeCtx({ interruptsSentToday: 3 }))).toBe("digest");
    expect(decideDelivery(makeAsk(), makeCtx({ interruptsSentToday: 7 }))).toBe("digest");
  });

  test("a weekly answer rate under 0.5 halves the budget, rounded up", () => {
    // 3 per day halves to 2.
    const low = { weeklyAnswerRate: 0.4 };
    expect(decideDelivery(makeAsk(), makeCtx({ ...low, interruptsSentToday: 1 }))).toBe("interrupt");
    expect(decideDelivery(makeAsk(), makeCtx({ ...low, interruptsSentToday: 2 }))).toBe("digest");
  });

  test("halving an odd budget rounds up", () => {
    const rules = makeRules({ interruptsPerDay: 5 });
    const low = { rules, weeklyAnswerRate: 0.2 };
    expect(decideDelivery(makeAsk(), makeCtx({ ...low, interruptsSentToday: 2 }))).toBe("interrupt");
    expect(decideDelivery(makeAsk(), makeCtx({ ...low, interruptsSentToday: 3 }))).toBe("digest");
  });

  test("an answer rate of exactly 0.5 keeps the full budget", () => {
    const ctx = makeCtx({ weeklyAnswerRate: 0.5, interruptsSentToday: 2 });
    expect(decideDelivery(makeAsk(), ctx)).toBe("interrupt");
  });

  test("an unknown answer rate keeps the full budget", () => {
    const ctx = makeCtx({ weeklyAnswerRate: null, interruptsSentToday: 2 });
    expect(decideDelivery(makeAsk(), ctx)).toBe("interrupt");
  });

  test("a zero answer rate still counts as a number under 0.5", () => {
    const ctx = makeCtx({ weeklyAnswerRate: 0, interruptsSentToday: 2 });
    expect(decideDelivery(makeAsk(), ctx)).toBe("digest");
  });
});
