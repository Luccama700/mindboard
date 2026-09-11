import { describe, expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  completeTaskCascade,
  missTaskCascade,
  reopenTaskCascade,
  slideTarget,
} from "@/app/lib/tasks/lifecycle";

// A scripted thenable query builder: every chained method records itself and
// returns the builder; awaiting it yields the next scripted response. Enough
// to assert which rows each cascade touches and with which guards.
type Op = [string, unknown[]];
type Call = { table: string; ops: Op[] };
type Response = { data?: unknown; error?: { message: string } | null; count?: number | null };

function fakeSupabase(script: Response[]) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const rec: Call = { table, ops: [] };
    calls.push(rec);
    const b: Record<string, unknown> = {};
    for (const m of ["select", "update", "eq", "in", "is", "maybeSingle"]) {
      b[m] = (...args: unknown[]) => {
        rec.ops.push([m, args]);
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(script.shift() ?? { data: null, error: null }).then(resolve, reject);
    return b;
  };
  return { client: { from } as unknown as SupabaseClient, calls };
}

function op(call: Call, name: string): unknown[] | undefined {
  return call.ops.find(([m]) => m === name)?.[1];
}

const NOW = new Date("2026-09-15T17:00:00.000Z");
const USER = "u1";

describe("completeTaskCascade", () => {
  test("completing the last open child completes the parent", async () => {
    const { client, calls } = fakeSupabase([
      { data: { id: "c2", title: "t", status: "todo", parent_task_id: "p", due_date: "2026-09-20", not_before: null } },
      { error: null }, // child → done
      { count: 0 }, // no open siblings
      { data: [{ id: "p" }] }, // parent → done
    ]);
    const r = await completeTaskCascade(client, USER, "c2", NOW);
    expect(r).toMatchObject({ ok: true, value: { parentCompleted: true, childrenCompleted: 0 } });
    expect(calls).toHaveLength(4);
    // child write: pinned to the user, stamped done
    expect(op(calls[1], "update")).toEqual([
      { status: "done", completed_at: NOW.toISOString(), missed_at: null },
    ]);
    expect(calls[1].ops).toContainEqual(["eq", ["user_id", USER]]);
    // sibling count only looks at OPEN children of that parent
    expect(calls[2].ops).toContainEqual(["eq", ["parent_task_id", "p"]]);
    expect(calls[2].ops).toContainEqual(["in", ["status", ["todo", "doing"]]]);
    // parent write is guarded on still-open, so a raced completion is a no-op
    expect(calls[3].ops).toContainEqual(["eq", ["id", "p"]]);
    expect(calls[3].ops).toContainEqual(["in", ["status", ["todo", "doing"]]]);
  });

  test("completing a child with siblings left leaves the parent alone", async () => {
    const { client, calls } = fakeSupabase([
      { data: { id: "c1", title: "t", status: "todo", parent_task_id: "p", due_date: "2026-09-18", not_before: null } },
      { error: null },
      { count: 2 },
    ]);
    const r = await completeTaskCascade(client, USER, "c1", NOW);
    expect(r).toMatchObject({ ok: true, value: { parentCompleted: false } });
    expect(calls).toHaveLength(3);
  });

  test("completing the parent completes every open child", async () => {
    const { client, calls } = fakeSupabase([
      { data: { id: "p", title: "t", status: "todo", parent_task_id: null, due_date: "2026-09-24", not_before: null } },
      { error: null },
      { data: [{ id: "c1" }, { id: "c3" }] },
    ]);
    const r = await completeTaskCascade(client, USER, "p", NOW);
    expect(r).toMatchObject({ ok: true, value: { parentCompleted: false, childrenCompleted: 2 } });
    expect(calls[2].ops).toContainEqual(["eq", ["parent_task_id", "p"]]);
    expect(calls[2].ops).toContainEqual(["eq", ["user_id", USER]]);
    expect(calls[2].ops).toContainEqual(["in", ["status", ["todo", "doing"]]]);
  });

  test("a task the user does not own is not found", async () => {
    const { client } = fakeSupabase([{ data: null }]);
    await expect(completeTaskCascade(client, USER, "x", NOW)).resolves.toEqual({
      ok: false,
      error: "task not found",
    });
  });
});

describe("reopenTaskCascade", () => {
  test("reopening a child reopens a resolved parent", async () => {
    const { client, calls } = fakeSupabase([
      { data: { id: "c1", title: "t", status: "done", parent_task_id: "p", due_date: "2026-09-18", not_before: null } },
      { error: null },
      { data: [{ id: "p" }] },
    ]);
    const r = await reopenTaskCascade(client, USER, "c1");
    expect(r).toMatchObject({ ok: true, value: { parentReopened: true } });
    expect(op(calls[1], "update")).toEqual([{ status: "todo", missed_at: null, completed_at: null }]);
    expect(calls[2].ops).toContainEqual(["in", ["status", ["done", "missed"]]]);
  });

  test("reopening a top-level task touches nothing else", async () => {
    const { client, calls } = fakeSupabase([
      { data: { id: "p", title: "t", status: "done", parent_task_id: null, due_date: null, not_before: null } },
      { error: null },
    ]);
    await reopenTaskCascade(client, USER, "p");
    expect(calls).toHaveLength(2);
  });
});

describe("slideTarget", () => {
  const today = "2026-09-15";
  test("tomorrow when the window allows it", () => {
    expect(slideTarget({ due_date: "2026-09-20", not_before: "2026-09-14" }, today)).toBe("2026-09-16");
    expect(slideTarget({ due_date: "2026-09-20", not_before: null }, today)).toBe("2026-09-16");
  });
  test("clamps to the window end", () => {
    expect(slideTarget({ due_date: "2026-09-16", not_before: null }, today)).toBe("2026-09-16");
    expect(slideTarget({ due_date: "2026-09-15", not_before: null }, today)).toBe("2026-09-15");
  });
  test("no slide once already at the window end, or with no window", () => {
    expect(slideTarget({ due_date: "2026-09-15", not_before: "2026-09-15" }, today)).toBeNull();
    expect(slideTarget({ due_date: "2026-09-16", not_before: "2026-09-16" }, today)).toBeNull();
    expect(slideTarget({ due_date: null, not_before: null }, today)).toBeNull();
  });
});

describe("missTaskCascade", () => {
  test("a skipped child slides its not_before instead of going missed", async () => {
    const { client, calls } = fakeSupabase([
      { data: { id: "c1", title: "t", status: "todo", parent_task_id: "p", due_date: "2026-09-20", not_before: "2026-09-14" } },
      { error: null },
    ]);
    const r = await missTaskCascade(client, USER, "c1", "2026-09-15", NOW);
    expect(r).toMatchObject({ ok: true, value: { kind: "slid", notBefore: "2026-09-16" } });
    expect(op(calls[1], "update")).toEqual([{ not_before: "2026-09-16" }]);
    expect(calls[1].ops.map(([m]) => m)).not.toContain("status");
  });

  test("a child on its last window day stays put and is still not missed", async () => {
    const { client, calls } = fakeSupabase([
      { data: { id: "c1", title: "t", status: "todo", parent_task_id: "p", due_date: "2026-09-15", not_before: "2026-09-15" } },
    ]);
    const r = await missTaskCascade(client, USER, "c1", "2026-09-15", NOW);
    expect(r).toMatchObject({ ok: true, value: { kind: "slid", notBefore: null } });
    expect(calls).toHaveLength(1);
  });

  test("missing a parent marks only the parent; children are left untouched", async () => {
    const { client, calls } = fakeSupabase([
      { data: { id: "p", title: "t", status: "todo", parent_task_id: null, due_date: "2026-09-10", not_before: null } },
      { data: [{ id: "p" }] },
    ]);
    const r = await missTaskCascade(client, USER, "p", "2026-09-15", NOW);
    expect(r).toMatchObject({ ok: true, value: { kind: "missed" } });
    expect(calls).toHaveLength(2);
    expect(op(calls[1], "update")).toEqual([{ status: "missed", missed_at: NOW.toISOString() }]);
    // Guarded on still-open, so a completion that raced in wins.
    expect(calls[1].ops).toContainEqual(["in", ["status", ["todo", "doing"]]]);
    const childWrites = calls.filter((c) =>
      c.ops.some(([m, a]) => m === "eq" && a[0] === "parent_task_id"),
    );
    expect(childWrites).toEqual([]);
  });

  test("a parent resolved meanwhile is reported, not silently re-stamped", async () => {
    const { client } = fakeSupabase([
      { data: { id: "p", title: "t", status: "todo", parent_task_id: null, due_date: "2026-09-10", not_before: null } },
      { data: [] },
    ]);
    await expect(missTaskCascade(client, USER, "p", "2026-09-15", NOW)).resolves.toEqual({
      ok: false,
      error: "task was resolved meanwhile",
    });
  });

  test("refuses a resolved task", async () => {
    const { client } = fakeSupabase([
      { data: { id: "p", title: "t", status: "done", parent_task_id: null, due_date: null, not_before: null } },
    ]);
    await expect(missTaskCascade(client, USER, "p", "2026-09-15", NOW)).resolves.toEqual({
      ok: false,
      error: "already done",
    });
  });
});

describe("cascade errors are surfaced, never read as success", () => {
  test("a failed sibling count must not be interpreted as zero siblings", async () => {
    const { client, calls } = fakeSupabase([
      { data: { id: "c", title: "t", status: "todo", parent_task_id: "p", due_date: "2026-09-15", not_before: null } },
      { error: null },
      { count: null, error: { message: "count unavailable" } },
      { data: [{ id: "p" }] },
    ]);
    const r = await completeTaskCascade(client, USER, "c", NOW);
    expect(r).toEqual({ ok: false, error: "count unavailable" });
    expect(calls).toHaveLength(3);
  });

  test("a failed child cascade must not report a clean parent completion", async () => {
    const { client } = fakeSupabase([
      { data: { id: "p", title: "t", status: "todo", parent_task_id: null, due_date: "2026-09-15", not_before: null } },
      { error: null },
      { data: null, error: { message: "child update failed" } },
    ]);
    await expect(completeTaskCascade(client, USER, "p", NOW)).resolves.toEqual({
      ok: false,
      error: "child update failed",
    });
  });

  test("a failed parent reopen is surfaced", async () => {
    const { client } = fakeSupabase([
      { data: { id: "c1", title: "t", status: "done", parent_task_id: "p", due_date: "2026-09-18", not_before: null } },
      { error: null },
      { data: null, error: { message: "parent reopen failed" } },
    ]);
    await expect(reopenTaskCascade(client, USER, "c1")).resolves.toEqual({
      ok: false,
      error: "parent reopen failed",
    });
  });
});
