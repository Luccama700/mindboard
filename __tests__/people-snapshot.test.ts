import { describe, expect, test } from "vitest";

import {
  backfillToDate,
  computePeopleAttention,
  hydratePeopleAttention,
  type BackfillChoice,
  type MentionCandidateRef,
  type PersonAttention,
} from "@/app/lib/snapshots/people";
import type { Person, PersonInteraction } from "@/app/_components/people-types";

const TODAY = "2026-08-12";

function person(over: Partial<Person> & { id: string; name: string }): Person {
  return {
    vault_path: null,
    aliases: [],
    checkin_days: null,
    attention_snoozed_until: null,
    archived: false,
    archived_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function interaction(
  personId: string,
  occurredAt: string,
  over: Partial<PersonInteraction> = {},
): PersonInteraction {
  return {
    id: `i-${personId}-${occurredAt}`,
    person_id: personId,
    summary: null,
    occurred_at: occurredAt,
    occurred_precision: "exact",
    source: "logged",
    created_at: `${occurredAt}T12:00:00Z`,
    ...over,
  };
}

function compute(
  people: Person[],
  interactions: PersonInteraction[],
  candidates: MentionCandidateRef[] = [],
) {
  return computePeopleAttention({
    people,
    interactions,
    candidates,
    today: TODAY,
  });
}

function candidate(
  personId: string,
  occurredAt: string,
  status: "new" | "confirmed" | "dismissed" = "new",
): MentionCandidateRef {
  return { person_id: personId, occurred_at: occurredAt, status };
}

describe("computePeopleAttention — eligibility", () => {
  test("attention is opt-in: no cadence means never surfacing", () => {
    const vitals = compute(
      [person({ id: "p1", name: "Davi" })],
      [interaction("p1", "2025-01-01")],
    );
    expect(vitals.attention).toEqual([]);
    expect(vitals.tracked).toBe(0);
    expect(vitals.total).toBe(1);
  });

  test("a cadence with nothing logged is EXCLUDED, not surfaced", () => {
    // A setup gap, not an overdue relationship — the backfill prompt closes it.
    const vitals = compute(
      [person({ id: "p1", name: "Davi", checkin_days: 14 })],
      [],
    );
    expect(vitals.attention).toEqual([]);
    // Still counted as tracked: the user did opt in.
    expect(vitals.tracked).toBe(1);
  });

  test("archived people are excluded from every count", () => {
    const vitals = compute(
      [
        person({ id: "p1", name: "Davi", checkin_days: 7, archived: true }),
        person({ id: "p2", name: "Emma" }),
      ],
      [interaction("p1", "2025-01-01")],
    );
    expect(vitals.attention).toEqual([]);
    expect(vitals.total).toBe(1);
    expect(vitals.tracked).toBe(0);
  });

  test("within cadence is not overdue; strictly greater surfaces", () => {
    const people = [person({ id: "p1", name: "Davi", checkin_days: 7 })];
    // Exactly at the cadence: quiet.
    expect(compute(people, [interaction("p1", "2026-08-05")]).attention).toEqual(
      [],
    );
    // One day past: surfaces, overdue by 1.
    const over = compute(people, [interaction("p1", "2026-08-04")]);
    expect(over.attention).toHaveLength(1);
    expect(over.attention[0]).toMatchObject({
      daysSinceTalked: 8,
      checkinDays: 7,
      overdueBy: 1,
    });
  });

  test("only the newest interaction per person is read", () => {
    const vitals = compute(
      [person({ id: "p1", name: "Davi", checkin_days: 7 })],
      [
        interaction("p1", "2025-03-01"),
        interaction("p1", "2026-08-09"),
        interaction("p1", "2024-01-01"),
      ],
    );
    expect(vitals.attention).toEqual([]);
  });

  test("approx-precision rows count normally for the math", () => {
    // The date is real enough for cadence; it just must never be RENDERED as a
    // firm day (§2.4). Precision is carried through untouched.
    const vitals = compute(
      [person({ id: "p1", name: "Davi", checkin_days: 7 })],
      [
        interaction("p1", "2026-07-01", {
          occurred_precision: "approx",
          summary: "coffee",
        }),
      ],
    );
    expect(vitals.attention[0].lastInteraction).toEqual({
      summary: "coffee",
      occurredAt: "2026-07-01",
      precision: "approx",
    });
    expect(vitals.attention[0].daysSinceTalked).toBe(42);
  });
});

describe("computePeopleAttention — snooze windows", () => {
  const overdue = [interaction("p1", "2026-01-01")];
  const base = { id: "p1", name: "Davi", checkin_days: 7 };

  const cases: [string, string | null, boolean][] = [
    ["no snooze set → surfaces", null, true],
    ["snoozed until tomorrow → quiet", "2026-08-13", false],
    ["snoozed far ahead → quiet", "2026-12-25", false],
    // The boundary the product promise turns on: "not now until the 12th"
    // means the 12th is when they come back.
    ["snoozed until today → eligible again", TODAY, true],
    ["snoozed until yesterday → eligible again", "2026-08-11", true],
  ];

  test.each(cases)("%s", (_label, snoozedUntil, expected) => {
    const vitals = compute(
      [person({ ...base, attention_snoozed_until: snoozedUntil })],
      overdue,
    );
    expect(vitals.attention.length > 0).toBe(expected);
    // Snoozed or not, the person stays counted as tracked.
    expect(vitals.tracked).toBe(1);
  });
});

// §2's asymmetry rule: evidence may QUIET the system; only the user may speak
// for it. Wrongly claiming contact is the trust-destroying error; wrongly
// staying quiet costs one un-sent nudge nobody notices.
describe("computePeopleAttention — mention-candidate suppression", () => {
  const people = [person({ id: "p1", name: "Davi", checkin_days: 7 })];
  // Last logged contact was 2026-07-01; cadence blown by a mile.
  const logged = [interaction("p1", "2026-07-01")];

  const cases: [string, MentionCandidateRef[], boolean][] = [
    ["no candidates → surfaces", [], true],
    [
      "an unreviewed mention NEWER than the last contact quiets it",
      [candidate("p1", "2026-08-09")],
      false,
    ],
    [
      "an unreviewed mention OLDER than the last contact does not",
      [candidate("p1", "2026-06-01")],
      true,
    ],
    [
      "same day as the last contact is not newer, so no suppression",
      [candidate("p1", "2026-07-01")],
      true,
    ],
    [
      "a CONFIRMED candidate never suppresses — the user already spoke",
      [candidate("p1", "2026-08-09", "confirmed")],
      true,
    ],
    [
      "a DISMISSED candidate never suppresses — reviewing lifts the quiet",
      [candidate("p1", "2026-08-09", "dismissed")],
      true,
    ],
    [
      "another person's candidate is irrelevant",
      [candidate("p2", "2026-08-09")],
      true,
    ],
    [
      "the NEWEST unreviewed candidate decides, not the first in the array",
      [candidate("p1", "2026-06-01"), candidate("p1", "2026-08-09")],
      false,
    ],
  ];

  test.each(cases)("%s", (_label, candidates, expected) => {
    const vitals = compute(people, logged, candidates);
    expect(vitals.attention.length > 0).toBe(expected);
    // Suppressed or not, the person stays counted as tracked: quieting is not
    // un-opting-in.
    expect(vitals.tracked).toBe(1);
    // A suppressed nudge SAYS SO rather than vanishing: exactly the people held
    // back by the candidate rule appear in quieted[].
    expect(vitals.quieted.length).toBe(expected ? 0 : 1);
  });

  test("quieted names the person, so the surface can explain the silence", () => {
    const vitals = compute(people, logged, [candidate("p1", "2026-08-09")]);
    expect(vitals.quieted).toEqual([{ personId: "p1", name: "Davi" }]);
    // Names ONLY — never the excerpt that did the quieting (§9).
    expect(JSON.stringify(vitals.quieted)).not.toContain("occurred_at");
  });

  test("quieted holds ONLY candidate-suppressed people, not every silent one", () => {
    const roster = [
      // Overdue and quieted by evidence.
      person({ id: "p1", name: "Davi", checkin_days: 7 }),
      // Overdue but snoozed — a different rule, and not what quieted explains.
      person({
        id: "p2",
        name: "Emma",
        checkin_days: 7,
        attention_snoozed_until: "2026-12-01",
      }),
      // No cadence at all.
      person({ id: "p3", name: "Carla" }),
      // Overdue and genuinely surfacing.
      person({ id: "p4", name: "Avalon", checkin_days: 7 }),
    ];
    const vitals = compute(
      roster,
      [
        interaction("p1", "2026-07-01"),
        interaction("p2", "2026-07-01"),
        interaction("p3", "2026-07-01"),
        interaction("p4", "2026-07-01"),
      ],
      [candidate("p1", "2026-08-09")],
    );
    expect(vitals.quieted).toEqual([{ personId: "p1", name: "Davi" }]);
    expect(vitals.attention.map((a) => a.personId)).toEqual(["p4"]);
  });

  test("quieted is empty when nothing was suppressed", () => {
    expect(compute(people, logged).quieted).toEqual([]);
  });

  test("suppression never fabricates contact — lastTalked is untouched", () => {
    // The candidate quiets the nudge but must not advance 'last talked'; the
    // moment it is dismissed, the original overdue fact is unchanged.
    const quiet = compute(people, logged, [candidate("p1", "2026-08-09")]);
    expect(quiet.attention).toEqual([]);
    const reviewed = compute(people, logged, [
      candidate("p1", "2026-08-09", "dismissed"),
    ]);
    expect(reviewed.attention[0].lastInteraction?.occurredAt).toBe("2026-07-01");
    expect(reviewed.attention[0].daysSinceTalked).toBe(42);
  });

  test("a candidate cannot resurrect someone who was never logged", () => {
    // Evidence may quiet; it may never speak. Never-logged stays excluded.
    const vitals = compute(people, [], [candidate("p1", "2026-08-09")]);
    expect(vitals.attention).toEqual([]);
  });
});

describe("computePeopleAttention — ordering", () => {
  test("most overdue first, then name, then id — a total order", () => {
    const people = [
      person({ id: "p-c", name: "Carla", checkin_days: 7 }),
      person({ id: "p-a", name: "Avalon", checkin_days: 7 }),
      person({ id: "p-d", name: "Davi", checkin_days: 30 }),
      person({ id: "p-b", name: "Avalon", checkin_days: 7 }),
    ];
    const interactions = [
      // Carla and both Avalons are tied at overdueBy 3 …
      interaction("p-c", "2026-08-02"),
      interaction("p-a", "2026-08-02"),
      interaction("p-b", "2026-08-02"),
      // … Davi is overdue by 12, so he leads.
      interaction("p-d", "2026-07-01"),
    ];
    const vitals = compute(people, interactions);
    expect(vitals.attention.map((a) => a.personId)).toEqual([
      "p-d",
      "p-a",
      "p-b",
      "p-c",
    ]);
    expect(vitals.attention[0].overdueBy).toBe(12);
  });

  test("the returned set is unbounded — bounding is the caller's job", () => {
    const people = Array.from({ length: 30 }, (_, i) =>
      person({ id: `p${i}`, name: `P${i}`, checkin_days: 1 }),
    );
    const interactions = people.map((p) => interaction(p.id, "2026-01-01"));
    expect(compute(people, interactions).attention).toHaveLength(30);
  });
});

describe("hydratePeopleAttention", () => {
  const base: PersonAttention = {
    personId: "p1",
    name: "Davi",
    vaultPath: "People/Davi.md",
    daysSinceTalked: 21,
    checkinDays: 7,
    overdueBy: 14,
    lastInteraction: null,
    openLoops: [],
  };

  test("attaches loops by personId and leaves the rest untouched", () => {
    const [hydrated] = hydratePeopleAttention([base], {
      p1: ["does he still want the writing feedback?"],
    });
    expect(hydrated).toEqual({
      ...base,
      openLoops: ["does he still want the writing feedback?"],
    });
  });

  test("a person with no note keeps an empty list rather than going missing", () => {
    // Denise: no vault_path at all, so a vaultPath-keyed map would have no slot
    // for her. personId keying is what makes her expressible.
    const denise = { ...base, personId: "p2", name: "Denise", vaultPath: null };
    const [hydrated] = hydratePeopleAttention([denise], {});
    expect(hydrated.openLoops).toEqual([]);
    expect(hydrated.personId).toBe("p2");
  });

  test("does not mutate its input", () => {
    const input = [{ ...base }];
    hydratePeopleAttention(input, { p1: ["x"] });
    expect(input[0].openLoops).toEqual([]);
  });
});

describe("backfillToDate", () => {
  const cases: [BackfillChoice, string | null, "exact" | "approx" | null][] = [
    ["today", TODAY, "exact"],
    ["this_week", "2026-08-09", "approx"],
    ["this_month", "2026-07-29", "approx"],
    ["longer_ago", "2026-06-13", "approx"],
    ["not_sure", null, null],
  ];

  test.each(cases)("%s", (choice, occurredAt, precision) => {
    const result = backfillToDate(choice, TODAY);
    if (occurredAt === null) {
      // A legitimate terminal state: no row, and the exclusion rule keeps that
      // person quiet until there is one.
      expect(result).toBeNull();
      return;
    }
    expect(result).toEqual({ occurredAt, precision });
  });

  test("only the today chip claims an exact day", () => {
    const choices: BackfillChoice[] = [
      "today",
      "this_week",
      "this_month",
      "longer_ago",
    ];
    const exact = choices.filter(
      (c) => backfillToDate(c, TODAY)?.precision === "exact",
    );
    expect(exact).toEqual(["today"]);
  });

  test("every chip derives from the injected today, never a clock", () => {
    const other = backfillToDate("this_week", "2027-01-02");
    expect(other).toEqual({ occurredAt: "2026-12-30", precision: "approx" });
  });
});

// ---------------------------------------------------------------------------
// Zone / DST boundaries — the __tests__/timezone-sweep.test.ts table pattern.
// This module never reads a clock: `today` is injected and every span is
// UTC-anchored day-key arithmetic, so a DST boundary inside the span must not
// change the count. These rows are the regression pin for that.
// ---------------------------------------------------------------------------

describe("day-key math across DST boundaries", () => {
  type SpanCase = {
    label: string;
    from: string;
    today: string;
    expected: number;
  };

  const SPANS: SpanCase[] = [
    {
      // Spring forward, 2026-03-08 (02:00 PST → 03:00 PDT). The span loses an
      // hour of wall time; it must still be exactly 7 calendar days.
      label: "spans US spring-forward",
      from: "2026-03-05",
      today: "2026-03-12",
      expected: 7,
    },
    {
      // Fall back, 2026-11-01 (02:00 PDT → 01:00 PST): an extra hour.
      label: "spans US fall-back",
      from: "2026-10-29",
      today: "2026-11-05",
      expected: 7,
    },
    {
      label: "the DST day itself",
      from: "2026-03-08",
      today: "2026-03-09",
      expected: 1,
    },
    { label: "same day is zero", from: TODAY, today: TODAY, expected: 0 },
    {
      label: "crosses a year boundary",
      from: "2025-12-30",
      today: "2026-01-02",
      expected: 3,
    },
    {
      label: "crosses a leap day",
      from: "2028-02-27",
      today: "2028-03-01",
      expected: 3,
    },
  ];

  test.each(SPANS)("$label", ({ from, today, expected }) => {
    const vitals = computePeopleAttention({
      people: [person({ id: "p1", name: "Davi", checkin_days: 1 })],
      interactions: [interaction("p1", from)],
      candidates: [],
      today,
    });
    if (expected <= 1) {
      expect(vitals.attention).toEqual([]);
      return;
    }
    expect(vitals.attention[0].daysSinceTalked).toBe(expected);
    expect(vitals.attention[0].overdueBy).toBe(expected - 1);
  });

  test("backfill chips land the same calendar day across spring-forward", () => {
    // today - 3 across the boundary is still three calendar days back.
    expect(backfillToDate("this_week", "2026-03-09")).toEqual({
      occurredAt: "2026-03-06",
      precision: "approx",
    });
  });
});
