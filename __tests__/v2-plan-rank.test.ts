// Task 2, the ranking half: which bucket a candidate falls in and the order
// inside each bucket. Energy is deliberately absent from this signature, so the
// low-energy tie-break lives in the planner, not here.

import { describe, expect, test } from "vitest";

import { parseRules } from "@/app/lib/v2/rules";
import { rankCandidates } from "@/app/lib/v2/plan/rank";
import type { Candidate } from "@/app/lib/v2/types";

const NOW = "2026-03-10T09:00:00+00:00";
/** The day being planned. Usually the day NOW falls on; not always (see below). */
const TODAY = "2026-03-10";
const rules = parseRules({});

function candidate(over: Partial<Candidate> & { id: string }): Candidate {
  return {
    title: over.title ?? `Task ${over.id}`,
    lane: over.lane ?? null,
    kind: over.kind ?? "step",
    due: over.due ?? null,
    hard: over.hard ?? false,
    minutes: over.minutes ?? null,
    energyCost: over.energyCost ?? null,
    expiresAt: over.expiresAt ?? null,
    pinned: over.pinned ?? false,
    earlyTouchDone: over.earlyTouchDone ?? false,
    id: over.id,
  };
}

const tiers = (list: Candidate[], today = TODAY) =>
  rankCandidates(list, NOW, rules, today).map((r) => [r.candidate.id, r.tier]);

describe("rankCandidates", () => {
  test("a hard item closing today is due-today", () => {
    expect(
      tiers([
        candidate({
          id: "a",
          hard: true,
          due: "2026-03-10T23:59:00+00:00",
        }),
      ]),
    ).toEqual([["a", "due-today"]]);
  });

  test("a hard item inside the hard window is hard-window", () => {
    expect(
      tiers([
        candidate({ id: "later", hard: true, due: "2026-03-12T10:00:00+00:00" }),
        candidate({ id: "sooner", hard: true, due: "2026-03-11T10:00:00+00:00" }),
      ]),
    ).toEqual([
      ["sooner", "hard-window"],
      ["later", "hard-window"],
    ]);
  });

  // F4. An overdue hard item used to be hard-window, and the hard window is
  // exempt from both capacity and the per-lane limit, so a backlog of them
  // produced one mandatory block each, on every day, with nothing dropped.
  test("a hard item that has already closed is not in the hard window", () => {
    expect(
      tiers([candidate({ id: "late", hard: true, due: "2026-03-09T10:00:00+00:00" })]),
    ).toEqual([["late", "lane-step"]]);
  });

  test("a hard item that closed earlier today is not due today either", () => {
    expect(
      tiers([candidate({ id: "missed", hard: true, due: "2026-03-10T08:00:00+00:00" })]),
    ).toEqual([["missed", "lane-step"]]);
  });

  test("overdue hard items rank by their date, earliest first", () => {
    expect(
      tiers([
        candidate({ id: "b", hard: true, lane: "lane-a", due: "2026-03-08T10:00:00+00:00" }),
        candidate({ id: "c", hard: true, lane: "lane-a", due: "2026-03-01T10:00:00+00:00" }),
        candidate({ id: "a", hard: true, lane: "lane-a", due: "2026-03-09T10:00:00+00:00" }),
      ]).map(([id]) => id),
    ).toEqual(["c", "b", "a"]);
  });

  test("an overdue hard side quest is a side quest, not a deadline", () => {
    expect(
      tiers([
        candidate({ id: "errand", kind: "side", hard: true, due: "2026-03-09T10:00:00+00:00" }),
      ]),
    ).toEqual([["errand", "side"]]);
  });

  test("a hard item outside the hard window falls back to its kind", () => {
    expect(
      tiers([
        candidate({ id: "far", hard: true, due: "2026-03-20T10:00:00+00:00" }),
        candidate({
          id: "errand",
          kind: "side",
          hard: true,
          due: "2026-03-20T10:00:00+00:00",
        }),
      ]),
    ).toEqual([
      ["far", "lane-step"],
      ["errand", "side"],
    ]);
  });

  test("a soft deadline never reaches the deadline buckets", () => {
    expect(
      tiers([
        candidate({ id: "soft", due: "2026-03-10T12:00:00+00:00" }),
        candidate({ id: "none" }),
      ]),
    ).toEqual([
      ["soft", "lane-step"],
      ["none", "lane-step"],
    ]);
  });

  test("the deadline buckets are decided before the kind, so a side quest can close today", () => {
    expect(
      tiers([
        candidate({
          id: "pay-rent",
          kind: "side",
          hard: true,
          due: "2026-03-10T17:00:00+00:00",
        }),
      ]),
    ).toEqual([["pay-rent", "due-today"]]);
  });

  test("buckets come out in order and deadlines sort earliest first", () => {
    const ranked = tiers([
      candidate({ id: "side-1", kind: "side", expiresAt: "2026-03-20T00:00:00+00:00" }),
      candidate({ id: "step-later", due: "2026-04-01T00:00:00+00:00" }),
      candidate({ id: "step-sooner", due: "2026-03-25T00:00:00+00:00" }),
      candidate({ id: "hard-2", hard: true, due: "2026-03-12T18:00:00+00:00" }),
      candidate({ id: "hard-1", hard: true, due: "2026-03-11T18:00:00+00:00" }),
      candidate({ id: "today", hard: true, due: "2026-03-10T20:00:00+00:00" }),
    ]);
    expect(ranked.map(([id]) => id)).toEqual([
      "today",
      "hard-1",
      "hard-2",
      "step-sooner",
      "step-later",
      "side-1",
    ]);
  });

  test("side quests go by expiry, soonest first, with pinned ones last", () => {
    const ranked = tiers([
      candidate({ id: "pinned", kind: "side", pinned: true }),
      candidate({ id: "no-expiry", kind: "side" }),
      candidate({ id: "late", kind: "side", expiresAt: "2026-03-24T00:00:00+00:00" }),
      candidate({ id: "soon", kind: "side", expiresAt: "2026-03-12T00:00:00+00:00" }),
    ]);
    expect(ranked.map(([id]) => id)).toEqual([
      "soon",
      "late",
      "no-expiry",
      "pinned",
    ]);
  });

  test("a step with no deadline sorts after one with a deadline, then by id", () => {
    const ranked = tiers([
      candidate({ id: "b" }),
      candidate({ id: "a" }),
      candidate({ id: "dated", due: "2026-04-01T00:00:00+00:00" }),
    ]);
    expect(ranked.map(([id]) => id)).toEqual(["dated", "a", "b"]);
  });

  test("the order does not depend on the order of the input", () => {
    const list = [
      candidate({ id: "a" }),
      candidate({ id: "b" }),
      candidate({ id: "c", kind: "side" }),
    ];
    const forward = rankCandidates(list, NOW, rules, TODAY).map((r) => r.candidate.id);
    const backward = rankCandidates([...list].reverse(), NOW, rules, TODAY).map(
      (r) => r.candidate.id,
    );
    expect(backward).toEqual(forward);
  });

  test("the hard window is measured from now in the rules' own hours", () => {
    const tight = parseRules({ hardWindowHours: 12 });
    const evening = "2026-03-10T20:00:00+00:00";
    // 22 hours out: past a 12 hour window.
    expect(
      rankCandidates(
        [candidate({ id: "x", hard: true, due: "2026-03-11T18:00:00+00:00" })],
        evening,
        tight,
        TODAY,
      )[0].tier,
    ).toBe("lane-step");
    // 10 hours out, and tomorrow rather than today.
    expect(
      rankCandidates(
        [candidate({ id: "x", hard: true, due: "2026-03-11T06:00:00+00:00" })],
        evening,
        tight,
        TODAY,
      )[0].tier,
    ).toBe("hard-window");
  });

  test("today is read in the rules' time zone", () => {
    // 2026-03-10T23:00Z is already the 11th in Tokyo, so it does not close
    // today there, and the 10th at 09:00 Tokyo is the 10th at 00:00 UTC.
    const tokyo = parseRules({ timeZone: "Asia/Tokyo" });
    const now = "2026-03-10T09:00:00+09:00";
    const due = "2026-03-10T23:00:00+00:00";
    expect(
      rankCandidates([candidate({ id: "x", hard: true, due })], now, tokyo, TODAY)[0]
        .tier,
    ).toBe("hard-window");
    expect(
      rankCandidates(
        [candidate({ id: "x", hard: true, due: "2026-03-10T20:00:00+09:00" })],
        now,
        tokyo,
        TODAY,
      )[0].tier,
    ).toBe("due-today");
  });

  // F3. The reference instant and the day being planned are the same day on an
  // ordinary day, and are NOT once lights out is after midnight: at 00:05 the
  // planning day is still yesterday. "Closes today" has to follow the planning
  // day, or tomorrow's deadline gets its three-hour session tonight.
  test("today is the day being planned, not the day the reference instant falls on", () => {
    const afterMidnight = "2026-03-11T00:05:00+00:00";
    const closesOnThe11th = candidate({
      id: "x",
      hard: true,
      due: "2026-03-11T23:59:00+00:00",
    });
    expect(
      rankCandidates([closesOnThe11th], afterMidnight, rules, "2026-03-10")[0].tier,
    ).toBe("hard-window");
    expect(
      rankCandidates([closesOnThe11th], afterMidnight, rules, "2026-03-11")[0].tier,
    ).toBe("due-today");
  });
});
