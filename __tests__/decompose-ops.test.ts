import { describe, expect, test } from "vitest";

import {
  MAX_CHILDREN,
  MIN_CHILDREN,
  renderDecompositionReceipt,
  validateDecomposition,
  type ProposedChild,
} from "@/app/lib/mcp/decompose-ops";

const TODAY = "2026-09-10";
const PARENT = { id: "p", title: "Write PHIL 240 essay", dueDate: "2026-09-24" };

function child(over: Partial<ProposedChild> & { title: string }): ProposedChild {
  return {
    estimatedMinutes: 30,
    energyCost: 3,
    notBefore: "2026-09-15",
    dueDate: "2026-09-20",
    ...over,
  };
}

describe("validateDecomposition", () => {
  test("accepts a clean breakdown, from a bare array or a {children} payload", () => {
    const list = [
      child({ title: "Pull three quotes", estimatedMinutes: 20, energyCost: 2, notBefore: "2026-09-15", dueDate: "2026-09-18" }),
      child({ title: "Outline argument", estimatedMinutes: 40, energyCost: 4, notBefore: "2026-09-17", dueDate: "2026-09-20" }),
      child({ title: "Draft body", estimatedMinutes: 90, energyCost: 5, notBefore: "2026-09-19", dueDate: "2026-09-22" }),
      child({ title: "Edit and submit", estimatedMinutes: 45, energyCost: 3, notBefore: "2026-09-22", dueDate: "2026-09-24" }),
    ];
    expect(validateDecomposition(list, PARENT, TODAY)).toEqual({ ok: true, value: list });
    expect(validateDecomposition({ children: list }, PARENT, TODAY)).toEqual({ ok: true, value: list });
  });

  test("bounds the count", () => {
    const one = [child({ title: "only" })];
    expect(validateDecomposition(one, PARENT, TODAY)).toMatchObject({ ok: false });
    const seven = Array.from({ length: MAX_CHILDREN + 1 }, (_, i) => child({ title: `s${i}` }));
    const r = validateDecomposition(seven, PARENT, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(new RegExp(`${MIN_CHILDREN} to ${MAX_CHILDREN}`));
    expect(validateDecomposition("nope", PARENT, TODAY)).toMatchObject({ ok: false });
  });

  test("clamps windows into [today, parent due] instead of failing the batch", () => {
    const r = validateDecomposition(
      [
        child({ title: "early", notBefore: "2026-09-01", dueDate: "2026-09-12" }),
        child({ title: "late", notBefore: "2026-09-20", dueDate: "2026-09-30" }),
      ],
      PARENT,
      TODAY,
    );
    expect(r).toMatchObject({
      ok: true,
      value: [
        { title: "early", notBefore: TODAY, dueDate: "2026-09-12" },
        { title: "late", notBefore: "2026-09-20", dueDate: "2026-09-24" },
      ],
    });
  });

  test("a window that is empty after clamping is an error naming the step", () => {
    const r = validateDecomposition(
      [child({ title: "ok" }), child({ title: "after deadline", notBefore: "2026-09-26", dueDate: "2026-09-28" })],
      PARENT,
      TODAY,
    );
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/step 2/);
  });

  test("rejects a parent whose deadline has passed", () => {
    expect(validateDecomposition([child({ title: "a" }), child({ title: "b" })], PARENT, "2026-09-25")).toMatchObject({ ok: false });
  });

  test("field checks: title, minutes, energy, dates", () => {
    const ok = child({ title: "ok" });
    const bad = (over: Partial<ProposedChild> & { title?: string }) =>
      validateDecomposition([ok, { ...ok, ...over }], PARENT, TODAY).ok;
    expect(bad({ title: "  " })).toBe(false);
    expect(bad({ title: "x".repeat(201) })).toBe(false);
    expect(bad({ estimatedMinutes: 0 })).toBe(false);
    expect(bad({ energyCost: 0 })).toBe(false);
    expect(bad({ energyCost: 6 })).toBe(false);
    expect(bad({ notBefore: "next week" as unknown as string })).toBe(false);
    expect(bad({ dueDate: "" })).toBe(false);
    // strict numbers: no coercion, no truncation — the receipt shows exactly
    // what was proposed
    expect(bad({ estimatedMinutes: 45.9 })).toBe(false);
    expect(bad({ energyCost: 4.9 })).toBe(false);
    expect(bad({ estimatedMinutes: "30" as unknown as number })).toBe(false);
    expect(bad({ energyCost: true as unknown as number })).toBe(false);
    // real calendar dates only
    expect(bad({ dueDate: "2026-02-30" })).toBe(false);
    expect(bad({ notBefore: "2026-13-01" })).toBe(false);
    const r = validateDecomposition([ok, { ...ok, title: "  Trim me " }], PARENT, TODAY);
    expect(r).toMatchObject({ ok: true, value: [ok, { title: "Trim me" }] });
  });
});

describe("renderDecompositionReceipt", () => {
  test("one line per step with minutes, energy and window, plus the total", () => {
    const text = renderDecompositionReceipt(PARENT, [
      child({ title: "Pull three quotes", estimatedMinutes: 20, energyCost: 2, notBefore: "2026-09-15", dueDate: "2026-09-18" }),
      child({ title: "Edit and submit", estimatedMinutes: 100, energyCost: 3, notBefore: "2026-09-24", dueDate: "2026-09-24" }),
    ]);
    expect(text).toBe(
      [
        'Break "Write PHIL 240 essay" (due 2026-09-24) into 2 steps:',
        "1. Pull three quotes · 20m · energy 2 · sep 15–18",
        "2. Edit and submit · 1.7h · energy 3 · sep 24",
        '≈ 2h in total. The steps land in your stream on their planned days; "Write PHIL 240 essay" stays as the thing owed and shows progress.',
      ].join("\n"),
    );
  });
});
