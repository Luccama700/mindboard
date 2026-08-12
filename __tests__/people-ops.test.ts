import { describe, expect, test } from "vitest";

import {
  MAX_PEOPLE_OPS,
  receiptLine,
  renderPeopleReceipt,
  resolvePeopleOps,
  resolvePersonRef,
  validatePeopleOps,
  validateResolvedPeopleOps,
  type PersonOp,
  type ResolvablePerson,
  type ResolvedPersonOp,
} from "@/app/lib/mcp/people-ops";

const DAVI: ResolvablePerson = { id: "p-davi", name: "Davi", archived: false };
const DAVID: ResolvablePerson = { id: "p-david", name: "David", archived: false };
const EMMA: ResolvablePerson = { id: "p-emma", name: "Emma", archived: false };
const LUIS: ResolvablePerson = { id: "p-luis", name: "Luis", archived: true };

const ROSTER = [DAVI, EMMA, LUIS];

function ops(raw: unknown) {
  return validatePeopleOps({ operations: raw });
}

function resolveOk(raw: unknown, people: ResolvablePerson[] = ROSTER) {
  const parsed = ops(raw);
  if (!parsed.ok) throw new Error(`validation failed: ${parsed.error}`);
  return resolvePeopleOps(parsed.value, people);
}

describe("validatePeopleOps", () => {
  test("rejects a missing or empty operations array", () => {
    expect(validatePeopleOps({})).toEqual({
      ok: false,
      error: "operations must be a non-empty array",
    });
    expect(ops([])).toEqual({
      ok: false,
      error: "operations must be a non-empty array",
    });
  });

  test("rejects an oversized batch", () => {
    const many = Array.from({ length: MAX_PEOPLE_OPS + 1 }, () => ({
      op: "archive",
      person: "Davi",
    }));
    expect(ops(many)).toEqual({
      ok: false,
      error: `too many operations (max ${MAX_PEOPLE_OPS})`,
    });
  });

  test("rejects an unknown op", () => {
    const result = ops([{ op: "befriend", person: "Davi" }]);
    expect(result).toEqual({
      ok: false,
      error: 'operation 1: unknown op "befriend"',
    });
  });

  test("log_interaction accepts a bare person and normalizes the optionals", () => {
    const result = ops([{ op: "log_interaction", person: " Davi " }]);
    expect(result).toEqual({
      ok: true,
      value: [
        {
          op: "log_interaction",
          person: "Davi",
          summary: undefined,
          date: undefined,
          approx: false,
        },
      ],
    });
  });

  test("log_interaction rejects a non-ISO date", () => {
    for (const date of ["aug 3", "2026-8-3", "2026/08/03", "yesterday"]) {
      const result = ops([{ op: "log_interaction", person: "Davi", date }]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("date must be YYYY-MM-DD");
    }
  });

  test("approx without an explicit date is rejected", () => {
    const result = ops([
      { op: "log_interaction", person: "Davi", approx: true },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("approx needs an explicit date");
    }
  });

  test("approx with a date is accepted and carried through", () => {
    const result = ops([
      { op: "log_interaction", person: "Davi", date: "2026-07-14", approx: true },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0]).toMatchObject({ approx: true });
  });

  test("an over-long summary is rejected", () => {
    const result = ops([
      { op: "log_interaction", person: "Davi", summary: "x".repeat(501) },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("summary is too long");
  });

  test("an empty summary is dropped rather than stored blank", () => {
    const result = ops([
      { op: "log_interaction", person: "Davi", summary: "   " },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0]).toMatchObject({ summary: undefined });
  });

  test("set_checkin requires days and accepts null to clear", () => {
    expect(ops([{ op: "set_checkin", person: "Davi" }]).ok).toBe(false);
    const cleared = ops([{ op: "set_checkin", person: "Davi", days: null }]);
    expect(cleared).toEqual({
      ok: true,
      value: [{ op: "set_checkin", person: "Davi", days: null }],
    });
  });

  test("set_checkin rejects non-positive, fractional and absurd cadences", () => {
    for (const days of [0, -7, 1.5, 100000]) {
      const result = ops([{ op: "set_checkin", person: "Davi", days }]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("days must be");
    }
  });

  test("create_person requires a name", () => {
    expect(ops([{ op: "create_person", name: "  " }]).ok).toBe(false);
  });
});

describe("resolvePersonRef", () => {
  const pool = [DAVI, DAVID, EMMA];

  test("resolves by id, then exact name, then unique substring", () => {
    expect(resolvePersonRef("p-emma", pool)).toEqual({ ok: true, value: EMMA });
    expect(resolvePersonRef("davi", pool)).toEqual({ ok: true, value: DAVI });
    expect(resolvePersonRef("mm", pool)).toEqual({ ok: true, value: EMMA });
  });

  test("an ambiguous substring fails with the candidates", () => {
    const result = resolvePersonRef("dav", pool);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("is ambiguous");
      expect(result.error).toContain("Davi (p-davi)");
      expect(result.error).toContain("David (p-david)");
    }
  });

  test("an exact name still wins over a longer substring match", () => {
    expect(resolvePersonRef("Davi", pool)).toEqual({ ok: true, value: DAVI });
  });

  test("a miss says so", () => {
    expect(resolvePersonRef("Denise", pool)).toEqual({
      ok: false,
      error: 'no person matching "Denise"',
    });
  });
});

describe("resolvePeopleOps", () => {
  test("resolved ops store ids, never the caller's ref strings", () => {
    const result = resolveOk([
      { op: "log_interaction", person: "davi", date: "2026-08-03" },
      { op: "set_checkin", person: "emm", days: 30 },
      { op: "archive", person: "Emma" },
      { op: "restore", person: "Luis" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.map((op) =>
      op.kind === "create" ? null : op.personId,
    );
    expect(ids).toEqual(["p-davi", "p-emma", "p-emma", "p-luis"]);
    // The invariant that matters: nothing carries a name the user typed as the
    // write target, so a rename between propose and confirm cannot retarget it.
    expect(JSON.stringify(result.value)).not.toContain('"emm"');
  });

  test("a whole batch fails on one ambiguity", () => {
    const result = resolveOk(
      [
        { op: "log_interaction", person: "Emma" },
        { op: "archive", person: "dav" },
      ],
      [DAVI, DAVID, EMMA],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("is ambiguous");
  });

  test("logging against an archived person asks for a restore first", () => {
    const result = resolveOk([{ op: "log_interaction", person: "Luis" }]);
    expect(result).toEqual({
      ok: false,
      error: '"Luis" is not being tracked — add a restore op first',
    });
  });

  test("archiving someone already archived is refused", () => {
    const result = resolveOk([{ op: "archive", person: "Luis" }]);
    expect(result).toEqual({
      ok: false,
      error: '"Luis" is already not being tracked',
    });
  });

  test("restoring someone already active is refused", () => {
    const result = resolveOk([{ op: "restore", person: "Davi" }]);
    expect(result).toEqual({
      ok: false,
      error: '"Davi" is already being tracked',
    });
  });

  test("create-then-log resolves the later op as pending", () => {
    const result = resolveOk([
      { op: "create_person", name: "Denise" },
      { op: "log_interaction", person: "denise", summary: "called about Davi" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      { kind: "create", name: "Denise" },
      {
        kind: "log",
        personId: null,
        name: "Denise",
        summary: "called about Davi",
        date: null,
        precision: "exact",
        pendingPerson: "Denise",
      },
    ]);
  });

  test("create-then-set_checkin resolves the later op as pending", () => {
    const result = resolveOk([
      { op: "create_person", name: "Denise" },
      { op: "set_checkin", person: "Denise", days: 30 },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[1]).toEqual({
      kind: "checkin",
      personId: null,
      name: "Denise",
      days: 30,
      pendingPerson: "Denise",
    });
  });

  test("creating a name that already exists fails fast with the live id", () => {
    const result = resolveOk([{ op: "create_person", name: "davi" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("you already have a Davi (p-davi)");
    }
  });

  test("an archived person does not block a new person's name", () => {
    // people_user_name_key is partial on `not archived`, so only the live
    // roster can collide.
    const result = resolveOk([{ op: "create_person", name: "Luis" }]);
    expect(result).toEqual({ ok: true, value: [{ kind: "create", name: "Luis" }] });
  });

  test("the same name created twice in one batch fails", () => {
    const result = resolveOk([
      { op: "create_person", name: "Denise" },
      { op: "create_person", name: "denise" },
    ]);
    expect(result).toEqual({
      ok: false,
      error: '"denise" is created twice in this batch',
    });
  });

  test("approx precision survives resolution", () => {
    const result = resolveOk([
      { op: "log_interaction", person: "Davi", date: "2026-07-14", approx: true },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]).toMatchObject({
        precision: "approx",
        date: "2026-07-14",
      });
    }
  });
});

describe("renderPeopleReceipt", () => {
  const cases: [string, ResolvedPersonOp, string][] = [
    [
      "an undated log says today rather than naming a day",
      {
        kind: "log",
        personId: "p-davi",
        name: "Davi",
        summary: null,
        date: null,
        precision: "exact",
      },
      "Davi  talked · today",
    ],
    [
      "a dated log with a summary",
      {
        kind: "log",
        personId: "p-davi",
        name: "Davi",
        summary: "coffee, he's writing again",
        date: "2026-08-03",
        precision: "exact",
      },
      'Davi  talked · 2026-08-03 · "coffee, he\'s writing again"',
    ],
    [
      "an approximate date is marked, never rendered as firm",
      {
        kind: "log",
        personId: "p-davi",
        name: "Davi",
        summary: null,
        date: "2026-07-14",
        precision: "approx",
      },
      "Davi  talked · ~2026-07-14 (approx)",
    ],
    ["a create", { kind: "create", name: "Denise" }, "Denise  new person"],
    [
      "a cadence",
      { kind: "checkin", personId: "p-davi", name: "Davi", days: 21 },
      "Davi  check in every 21 days",
    ],
    [
      "a cleared cadence",
      { kind: "checkin", personId: "p-davi", name: "Davi", days: null },
      "Davi  check-in cadence cleared",
    ],
    [
      "an archive",
      { kind: "archive", personId: "p-davi", name: "Davi" },
      "Davi  stop tracking",
    ],
    [
      "a restore",
      { kind: "restore", personId: "p-luis", name: "Luis" },
      "Luis  tracking again",
    ],
  ];

  test.each(cases)("%s", (_label, op, expected) => {
    expect(receiptLine(op)).toBe(expected);
  });

  test("joins one line per op", () => {
    expect(
      renderPeopleReceipt([
        { kind: "create", name: "Denise" },
        {
          kind: "log",
          personId: null,
          name: "Denise",
          summary: null,
          date: null,
          precision: "exact",
          pendingPerson: "Denise",
        },
      ]),
    ).toBe("Denise  new person\nDenise  talked · today");
  });
});

describe("validateResolvedPeopleOps", () => {
  test("round-trips what resolvePeopleOps produced", () => {
    const resolved = resolveOk([
      { op: "create_person", name: "Denise" },
      { op: "log_interaction", person: "Denise" },
      { op: "log_interaction", person: "Davi", date: "2026-07-14", approx: true },
      { op: "set_checkin", person: "Emma", days: 30 },
      { op: "archive", person: "Emma" },
      { op: "restore", person: "Luis" },
    ]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // JSON round-trip: this is exactly how the proposal comes back out of the
    // audit row at confirm time.
    const stored = JSON.parse(
      JSON.stringify({ operations: resolved.value }),
    ) as unknown;
    expect(validateResolvedPeopleOps(stored)).toEqual({
      ok: true,
      value: resolved.value,
    });
  });

  test("rejects an empty or malformed stored batch", () => {
    expect(validateResolvedPeopleOps({ operations: [] })).toEqual({
      ok: false,
      error: "stored proposal has no operations",
    });
    expect(validateResolvedPeopleOps({ operations: ["nope"] })).toEqual({
      ok: false,
      error: "malformed stored operation",
    });
    expect(validateResolvedPeopleOps({ operations: [{ kind: "wat" }] })).toEqual({
      ok: false,
      error: "malformed stored operation",
    });
  });

  test("rejects a log with neither an id nor a pending create", () => {
    expect(
      validateResolvedPeopleOps({
        operations: [{ kind: "log", name: "Davi", date: null }],
      }),
    ).toEqual({ ok: false, error: "malformed log operation" });
  });

  test("rejects a stored approx log with no date", () => {
    expect(
      validateResolvedPeopleOps({
        operations: [
          {
            kind: "log",
            personId: "p-davi",
            name: "Davi",
            date: null,
            precision: "approx",
          },
        ],
      }),
    ).toEqual({ ok: false, error: "malformed log operation" });
  });

  test("rejects a stored archive with no id", () => {
    expect(
      validateResolvedPeopleOps({
        operations: [{ kind: "archive", name: "Davi" }],
      }),
    ).toEqual({ ok: false, error: "malformed archive operation" });
  });
});

describe("MAX_PEOPLE_OPS", () => {
  test("a full-size batch is accepted", () => {
    const many: PersonOp[] = Array.from({ length: MAX_PEOPLE_OPS }, () => ({
      op: "log_interaction",
      person: "Davi",
    }));
    const result = ops(many);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(MAX_PEOPLE_OPS);
  });
});
