import { describe, expect, test } from "vitest";

import { daysSince, evaluateFeeds } from "@/app/lib/v2/watch/expectations";
import type { Expectation, FeedRun } from "@/app/lib/v2/types";

const NOW = "2026-07-08T12:00:00Z";
const NOW_MS = Date.parse(NOW);

function ago(minutes: number): string {
  return new Date(NOW_MS - minutes * 60_000).toISOString();
}

function expectation(overrides: Partial<Expectation> = {}): Expectation {
  return {
    feed: "feed-a",
    everyMinutes: 60,
    graceMinutes: 10,
    minCount: 1,
    activeHours: null,
    ...overrides,
  };
}

/** A run that finished `finishedAgo` minutes before NOW. */
function run(finishedAgo: number, overrides: Partial<FeedRun> = {}): FeedRun {
  return {
    feed: "feed-a",
    startedAt: ago(finishedAgo + 1),
    finishedAt: ago(finishedAgo),
    status: "ok",
    count: 5,
    errorClass: null,
    ...overrides,
  };
}

function evaluate(runs: FeedRun[], exp: Partial<Expectation> = {}, now = NOW, zone = "UTC") {
  return evaluateFeeds([expectation(exp)], runs, now, zone)[0];
}

describe("evaluateFeeds: what counts as a good run", () => {
  test("a finished ok run with enough items is good and sets lastGoodAt", () => {
    const status = evaluate([run(20, { count: 1 })]);
    expect(status.state).toBe("alive");
    expect(status.lastGoodAt).toBe(ago(20));
    expect(status.cause).toBeNull();
  });

  test("lastGoodAt is the newest good run, whatever the order of the list", () => {
    const status = evaluate([run(50), run(10), run(30)]);
    expect(status.lastGoodAt).toBe(ago(10));
  });

  test("an error run is not good", () => {
    const status = evaluate([run(100), run(5, { status: "error", errorClass: "auth-expired" })]);
    expect(status.lastGoodAt).toBe(ago(100));
  });

  test("an ok run with too few items is not good", () => {
    const status = evaluate([run(100), run(5, { count: 0 })]);
    expect(status.lastGoodAt).toBe(ago(100));
  });

  test("a run that has not finished is not good", () => {
    const status = evaluate([run(100), run(5, { finishedAt: null })]);
    expect(status.lastGoodAt).toBe(ago(100));
  });

  test("lastGoodAt is null when there has never been a good run", () => {
    expect(evaluate([]).lastGoodAt).toBeNull();
    expect(evaluate([run(5, { count: 0 })]).lastGoodAt).toBeNull();
  });

  test("minCount is per feed", () => {
    const status = evaluate([run(5, { count: 3 })], { minCount: 4 });
    expect(status.lastGoodAt).toBeNull();
    expect(status.state).toBe("failing");
  });

  test("runs of other feeds are ignored", () => {
    const status = evaluate([run(5, { feed: "feed-b" })]);
    expect(status.lastGoodAt).toBeNull();
    expect(status.state).toBe("blind");
  });
});

describe("evaluateFeeds: alive", () => {
  test("a good run within the interval plus grace is alive", () => {
    expect(evaluate([run(70)]).state).toBe("alive");
  });

  test("one minute past the interval plus grace is no longer alive", () => {
    expect(evaluate([run(71)]).state).toBe("late");
  });

  test("a good run beats an older error: the feed is alive", () => {
    const status = evaluate([run(30), run(90, { status: "error", errorClass: "boom" })]);
    expect(status.state).toBe("alive");
  });

  test("every feed gets a status, in the order of the expectations", () => {
    const result = evaluateFeeds(
      [expectation({ feed: "feed-b" }), expectation({ feed: "feed-a" })],
      [run(5, { feed: "feed-a" })],
      NOW,
      "UTC",
    );
    expect(result.map((s) => [s.feed, s.state])).toEqual([
      ["feed-b", "blind"],
      ["feed-a", "alive"],
    ]);
  });
});

describe("evaluateFeeds: failing on an error", () => {
  test("a newest finished run that errored is failing with its error class", () => {
    const status = evaluate([
      run(200),
      run(15, { status: "error", errorClass: "auth-expired", count: 0 }),
    ]);
    expect(status.state).toBe("failing");
    expect(status.cause).toBe("auth-expired");
    expect(status.lastGoodAt).toBe(ago(200));
  });

  test("an error with no class falls back to the plain cause 'error'", () => {
    const status = evaluate([run(200), run(15, { status: "error", errorClass: null })]);
    expect(status.state).toBe("failing");
    expect(status.cause).toBe("error");
  });

  test("a run that is still going does not hide the error before it", () => {
    const status = evaluate([
      run(200),
      run(30, { status: "error", errorClass: "rate-limited" }),
      run(1, { finishedAt: null }),
    ]);
    expect(status.state).toBe("failing");
    expect(status.cause).toBe("rate-limited");
  });

  test("an unfinished run is not the newest finished run", () => {
    // The only finished run is an old good one, so this is plain lateness.
    const status = evaluate([
      run(100),
      run(2, { finishedAt: null, status: "error", errorClass: "boom" }),
    ]);
    expect(status.state).toBe("late");
    expect(status.cause).toBe("no-run");
  });

  test("an error older than the last good run does not count", () => {
    const status = evaluate([run(100), run(300, { status: "error", errorClass: "boom" })]);
    expect(status.state).toBe("late");
    expect(status.cause).toBe("no-run");
  });
});

describe("evaluateFeeds: failing on an empty run", () => {
  test("a newest finished ok run with too few items is failing with cause empty-run", () => {
    const status = evaluate([run(200), run(5, { count: 0 })]);
    expect(status.state).toBe("failing");
    expect(status.cause).toBe("empty-run");
  });

  test("a run that finished ok with zero items is a failure after the grace period", () => {
    // The last good run is still inside interval + grace: nothing to report yet.
    const early = evaluate([run(65), run(5, { count: 0 })]);
    expect(early.state).toBe("alive");
    // Five minutes later the good run has aged out and the empty run stands.
    const later = evaluate([run(65), run(5, { count: 0 })], {}, "2026-07-08T12:06:00Z");
    expect(later.state).toBe("failing");
    expect(later.cause).toBe("empty-run");
  });

  test("an empty run with no good run before it is failing straight away", () => {
    const status = evaluate([run(1, { count: 0 })]);
    expect(status.state).toBe("failing");
    expect(status.cause).toBe("empty-run");
  });
});

describe("evaluateFeeds: late, then blind", () => {
  test("late up to twice the interval plus grace", () => {
    const status = evaluate([run(130)]);
    expect(status.state).toBe("late");
    expect(status.cause).toBe("no-run");
    expect(status.lastGoodAt).toBe(ago(130));
  });

  test("blind one minute after that", () => {
    const status = evaluate([run(131)]);
    expect(status.state).toBe("blind");
    expect(status.cause).toBe("no-run");
  });

  test("blind when there is no run at all", () => {
    const status = evaluate([]);
    expect(status.state).toBe("blind");
    expect(status.cause).toBe("no-run");
    expect(status.lastGoodAt).toBeNull();
  });

  test("the thresholds scale with the expectation", () => {
    expect(evaluate([run(20)], { everyMinutes: 5, graceMinutes: 5 }).state).toBe("blind");
    expect(evaluate([run(15)], { everyMinutes: 5, graceMinutes: 5 }).state).toBe("late");
    expect(evaluate([run(9)], { everyMinutes: 5, graceMinutes: 5 }).state).toBe("alive");
  });
});

describe("evaluateFeeds: active hours", () => {
  // NOW is 12:00 UTC, which is 21:00 in Tokyo.
  const tokyo = "Asia/Tokyo";

  test("outside active hours a stale feed is never late or blind", () => {
    const hours = { from: "09:00", to: "18:00" };
    expect(evaluate([run(131)], { activeHours: hours }, NOW, tokyo).state).toBe("alive");
    expect(evaluate([], { activeHours: hours }, NOW, tokyo).state).toBe("alive");
  });

  test("inside active hours the same feed is judged normally", () => {
    const hours = { from: "09:00", to: "22:00" };
    expect(evaluate([run(131)], { activeHours: hours }, NOW, tokyo).state).toBe("blind");
    expect(evaluate([run(100)], { activeHours: hours }, NOW, tokyo).state).toBe("late");
  });

  test("active hours are read in the given zone, not UTC", () => {
    const hours = { from: "09:00", to: "18:00" };
    // 12:00 UTC is inside 09:00-18:00 when the zone is UTC.
    expect(evaluate([run(131)], { activeHours: hours }, NOW, "UTC").state).toBe("blind");
    expect(evaluate([run(131)], { activeHours: hours }, NOW, tokyo).state).toBe("alive");
  });

  test("the window starts at 'from' and ends before 'to'", () => {
    const hours = { from: "21:00", to: "22:00" };
    // 21:00 Tokyo exactly: inside.
    expect(evaluate([run(131)], { activeHours: hours }, NOW, tokyo).state).toBe("blind");
    const endHours = { from: "20:00", to: "21:00" };
    // 21:00 Tokyo exactly is the end of this window: outside.
    expect(evaluate([run(131)], { activeHours: endHours }, NOW, tokyo).state).toBe("alive");
  });

  test("a window that runs past midnight works", () => {
    const hours = { from: "20:00", to: "06:00" };
    expect(evaluate([run(131)], { activeHours: hours }, NOW, tokyo).state).toBe("blind");
    const morning = "2026-07-08T00:00:00Z"; // 09:00 Tokyo
    expect(evaluate([], { activeHours: hours }, morning, tokyo).state).toBe("alive");
  });

  test("outside active hours an error still makes the feed failing", () => {
    const hours = { from: "09:00", to: "18:00" };
    const status = evaluate(
      [run(200), run(5, { status: "error", errorClass: "auth-expired" })],
      { activeHours: hours },
      NOW,
      tokyo,
    );
    expect(status.state).toBe("failing");
    expect(status.cause).toBe("auth-expired");
  });

  test("outside active hours an empty run still makes the feed failing", () => {
    const hours = { from: "09:00", to: "18:00" };
    const status = evaluate([run(200), run(5, { count: 0 })], { activeHours: hours }, NOW, tokyo);
    expect(status.state).toBe("failing");
    expect(status.cause).toBe("empty-run");
  });

  test("outside active hours a recent good run is simply alive", () => {
    const hours = { from: "09:00", to: "18:00" };
    const status = evaluate([run(5)], { activeHours: hours }, NOW, tokyo);
    expect(status.state).toBe("alive");
    expect(status.lastGoodAt).toBe(ago(5));
  });

  test("a stale feed outside active hours keeps its lastGoodAt and no cause", () => {
    const hours = { from: "09:00", to: "18:00" };
    const status = evaluate([run(500)], { activeHours: hours }, NOW, tokyo);
    expect(status.state).toBe("alive");
    expect(status.lastGoodAt).toBe(ago(500));
    expect(status.cause).toBeNull();
  });
});

describe("daysSince", () => {
  test("is 0 on the same day", () => {
    expect(daysSince("2026-07-08T01:00:00Z", "2026-07-08T23:30:00Z", "UTC")).toBe(0);
  });

  test("counts calendar days in the zone, not 24-hour spans", () => {
    // Two hours apart, but across midnight in Tokyo (23:00 on the 8th to 01:00 on the 9th).
    expect(daysSince("2026-07-08T14:00:00Z", "2026-07-08T16:00:00Z", "Asia/Tokyo")).toBe(1);
    // The same two instants are one UTC day.
    expect(daysSince("2026-07-08T14:00:00Z", "2026-07-08T16:00:00Z", "UTC")).toBe(0);
  });

  test("a full day later is 1, three days later is 3", () => {
    expect(daysSince("2026-07-05T08:00:00Z", "2026-07-06T08:00:00Z", "UTC")).toBe(1);
    expect(daysSince("2026-07-05T23:59:00Z", "2026-07-08T00:01:00Z", "UTC")).toBe(3);
  });

  test("a short day does not lose a calendar day", () => {
    // New York: 2026-03-08 is 23 hours long. From noon on the 7th to noon on the 9th is 47 hours.
    expect(daysSince("2026-03-07T12:00:00-05:00", "2026-03-09T12:00:00-04:00", "America/New_York")).toBe(2);
  });

  test("a long day does not gain a calendar day", () => {
    // 2026-11-01 is 25 hours long in New York.
    expect(daysSince("2026-10-31T12:00:00-04:00", "2026-11-02T12:00:00-05:00", "America/New_York")).toBe(2);
  });

  test("crosses month and year boundaries", () => {
    expect(daysSince("2026-12-30T12:00:00Z", "2027-01-02T12:00:00Z", "UTC")).toBe(3);
    expect(daysSince("2026-02-27T12:00:00Z", "2026-03-01T12:00:00Z", "America/Phoenix")).toBe(2);
  });

  test("is never negative when since is after now", () => {
    expect(daysSince("2026-07-10T12:00:00Z", "2026-07-08T12:00:00Z", "UTC")).toBe(0);
    expect(daysSince("2026-07-09T14:00:00Z", "2026-07-08T16:00:00Z", "Asia/Tokyo")).toBe(0);
  });
});
