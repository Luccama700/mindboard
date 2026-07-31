// claim_task_dispatch / update_task_dispatch: the two fenced direct writes the
// overnight worker uses to pull a "do this now" dispatch and report back.
// The service client is faked with a tiny in-memory PostgREST so the claim's
// ordering, staleness window, per-user scoping, and lost-race retry are
// exercised for real rather than asserted call-by-call.
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createServiceClient: vi.fn() }));

vi.mock("@/utils/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));

import { claimTaskDispatch, updateTaskDispatch } from "@/app/lib/mcp/writes";

type Row = Record<string, unknown>;

type Db = {
  from: (table: string) => unknown;
  tables: Record<string, Row[]>;
  beforeUpdate: ((table: string) => void) | null;
};

function makeDb(tables: Record<string, Row[]>): Db {
  const db: Db = {
    tables,
    beforeUpdate: null,
    from: (table: string) => {
      const filters: ((r: Row) => boolean)[] = [];
      let mode: "select" | "update" = "select";
      let patch: Row = {};
      let orderKey: string | null = null;
      let limitN: number | null = null;

      const rowsOf = () => tables[table] ?? [];
      const matched = () => rowsOf().filter((r) => filters.every((f) => f(r)));

      function run(): { data: Row[]; error: null } {
        if (mode === "update") {
          db.beforeUpdate?.(table);
          const hit = matched();
          for (const row of hit) Object.assign(row, patch);
          return { data: hit.map((r) => ({ ...r })), error: null };
        }
        let out = matched().map((r) => ({ ...r }));
        if (orderKey) {
          const key = orderKey;
          out = out.sort((a, b) => String(a[key]).localeCompare(String(b[key])));
        }
        if (limitN !== null) out = out.slice(0, limitN);
        return { data: out, error: null };
      }

      const q = {
        select: () => q,
        update: (p: Row) => {
          mode = "update";
          patch = p;
          return q;
        },
        eq: (c: string, v: unknown) => {
          filters.push((r) => r[c] === v);
          return q;
        },
        in: (c: string, vs: unknown[]) => {
          filters.push((r) => vs.includes(r[c]));
          return q;
        },
        is: (c: string) => {
          filters.push((r) => r[c] === null || r[c] === undefined);
          return q;
        },
        lt: (c: string, v: string) => {
          filters.push((r) => r[c] !== null && String(r[c]) < v);
          return q;
        },
        order: (c: string) => {
          orderKey = c;
          return q;
        },
        limit: (n: number) => {
          limitN = n;
          return q;
        },
        maybeSingle: async () => ({ data: run().data[0] ?? null, error: null }),
        single: async () => {
          const { data } = run();
          return data.length === 1
            ? { data: data[0], error: null }
            : { data: null, error: { message: "no rows" } };
        },
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
          Promise.resolve(run()).then(resolve),
      };
      return q;
    },
  };
  return db;
}

const NOW = new Date("2026-07-31T12:00:00.000Z");
const FRESH = new Date("2026-07-31T11:30:00.000Z").toISOString(); // 30 min ago
const STALE = new Date("2026-07-31T10:59:00.000Z").toISOString(); // 61 min ago

function dispatch(over: Partial<Row> = {}): Row {
  return {
    id: "d1",
    user_id: "user-1",
    task_id: "task-1",
    note: "do the thing",
    status: "requested",
    attempts: 0,
    result_summary: null,
    created_at: "2026-07-31T09:00:00.000Z",
    claimed_at: null,
    finished_at: null,
    ...over,
  };
}

function install(
  dispatches: Row[],
  tasks: Row[] = [
    {
      id: "task-1",
      user_id: "user-1",
      title: "Book the room",
      notes: "prefer mornings",
    },
  ],
): Db {
  const db = makeDb({ task_dispatches: dispatches, tasks });
  mocks.createServiceClient.mockReturnValue(db);
  return db;
}

describe("claimTaskDispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  test("returns null when nothing is pending", async () => {
    install([]);
    await expect(claimTaskDispatch("user-1")).resolves.toEqual({
      ok: true,
      value: { dispatch: null },
    });
  });

  test("claims the oldest requested dispatch and carries the task title", async () => {
    const db = install([
      dispatch({ id: "new", created_at: "2026-07-31T11:00:00.000Z" }),
      dispatch({ id: "old", created_at: "2026-07-31T08:00:00.000Z" }),
    ]);

    const result = await claimTaskDispatch("user-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dispatch?.id).toBe("old");
    expect(result.value.dispatch?.status).toBe("claimed");
    expect(result.value.dispatch?.claimed_at).toBe(NOW.toISOString());
    expect(result.value.dispatch?.task_title).toBe("Book the room");
    // the write-back fallback travels with the claim
    expect(result.value.dispatch?.task_notes).toBe("prefer mornings");
    expect(result.value.dispatch?.attempts).toBe(1);
    expect(db.tables.task_dispatches.find((r) => r.id === "new")?.status).toBe(
      "requested",
    );
  });

  test("a fresh request wins over an older stale reclaim", async () => {
    install([
      dispatch({
        id: "sick",
        status: "running",
        claimed_at: STALE,
        attempts: 1,
        created_at: "2026-07-31T06:00:00.000Z",
      }),
      dispatch({ id: "fresh", created_at: "2026-07-31T11:00:00.000Z" }),
    ]);

    const result = await claimTaskDispatch("user-1");
    expect(result.ok && result.value.dispatch?.id).toBe("fresh");
  });

  test("a row past the attempts cap is retired, not claimed", async () => {
    const db = install([
      dispatch({ id: "poison", status: "running", claimed_at: STALE, attempts: 3 }),
    ]);

    await expect(claimTaskDispatch("user-1")).resolves.toEqual({
      ok: true,
      value: { dispatch: null },
    });
    const row = db.tables.task_dispatches[0];
    expect(row.status).toBe("failed");
    expect(row.result_summary).toBe("gave up after 3 attempts");
    expect(row.finished_at).toBe(NOW.toISOString());
  });

  // Otherwise the card reads ✦ working… forever, and the nightly sweep reads
  // a stale 'building' as a crashed claim and re-runs the task as a life task.
  test("retiring a dispatch fails its task's badge too", async () => {
    const db = install(
      [dispatch({ id: "poison", status: "running", claimed_at: STALE, attempts: 3 })],
      [
        {
          id: "task-1",
          user_id: "user-1",
          title: "Book the room",
          notes: null,
          ai_state: "building",
        },
      ],
    );

    await claimTaskDispatch("user-1");
    expect(db.tables.tasks[0].ai_state).toBe("failed");
  });

  test("retiring leaves a task the user has since re-planned alone", async () => {
    const db = install(
      [dispatch({ id: "poison", status: "running", claimed_at: STALE, attempts: 3 })],
      [
        {
          id: "task-1",
          user_id: "user-1",
          title: "Book the room",
          notes: null,
          ai_state: "planned",
        },
      ],
    );

    await claimTaskDispatch("user-1");
    expect(db.tables.tasks[0].ai_state).toBe("planned");
    expect(db.tables.task_dispatches[0].status).toBe("failed");
  });

  test("retiring an exhausted row does not block the next healthy one", async () => {
    const db = install([
      dispatch({
        id: "poison",
        status: "running",
        claimed_at: STALE,
        attempts: 3,
        created_at: "2026-07-31T06:00:00.000Z",
      }),
      dispatch({ id: "healthy", created_at: "2026-07-31T10:00:00.000Z" }),
    ]);

    const result = await claimTaskDispatch("user-1");
    expect(result.ok && result.value.dispatch?.id).toBe("healthy");
    expect(db.tables.task_dispatches.find((r) => r.id === "poison")?.status).toBe(
      "failed",
    );
  });

  test("a claimed row with no claimed_at is still reachable", async () => {
    install([dispatch({ id: "orphan", status: "claimed", claimed_at: null })]);
    const result = await claimTaskDispatch("user-1");
    expect(result.ok && result.value.dispatch?.id).toBe("orphan");
  });

  test("a task with no notes claims with a null fallback", async () => {
    install([dispatch()], [
      { id: "task-1", user_id: "user-1", title: "Book the room", notes: null },
    ]);
    const result = await claimTaskDispatch("user-1");
    expect(result.ok && result.value.dispatch?.task_notes).toBeNull();
  });

  test("a taskId filters the claim to that task", async () => {
    install([
      dispatch({ id: "other", task_id: "task-2", created_at: "2026-07-31T08:00:00.000Z" }),
      dispatch({ id: "mine", task_id: "task-1", created_at: "2026-07-31T09:00:00.000Z" }),
    ]);

    const result = await claimTaskDispatch("user-1", "task-1");
    expect(result.ok && result.value.dispatch?.id).toBe("mine");
  });

  test("a taskId with no pending dispatch claims nothing", async () => {
    install([dispatch({ id: "other", task_id: "task-2" })]);
    await expect(claimTaskDispatch("user-1", "task-1")).resolves.toEqual({
      ok: true,
      value: { dispatch: null },
    });
  });

  test("a claimed row older than 60 minutes is reclaimable", async () => {
    install([dispatch({ id: "dead", status: "claimed", claimed_at: STALE })]);

    const result = await claimTaskDispatch("user-1");
    expect(result.ok && result.value.dispatch?.id).toBe("dead");
    expect(result.ok && result.value.dispatch?.claimed_at).toBe(NOW.toISOString());
  });

  test("a running row older than 60 minutes is reclaimable", async () => {
    install([dispatch({ id: "hung", status: "running", claimed_at: STALE })]);
    const result = await claimTaskDispatch("user-1");
    expect(result.ok && result.value.dispatch?.id).toBe("hung");
  });

  test("a freshly claimed row is left alone", async () => {
    install([dispatch({ id: "live", status: "claimed", claimed_at: FRESH })]);
    await expect(claimTaskDispatch("user-1")).resolves.toEqual({
      ok: true,
      value: { dispatch: null },
    });
  });

  test("finished rows are never reclaimed", async () => {
    install([
      dispatch({ id: "done", status: "done", claimed_at: STALE }),
      dispatch({ id: "failed", status: "failed", claimed_at: STALE }),
    ]);
    await expect(claimTaskDispatch("user-1")).resolves.toEqual({
      ok: true,
      value: { dispatch: null },
    });
  });

  test("another user's dispatch is invisible", async () => {
    install([dispatch({ id: "theirs", user_id: "user-2" })]);
    await expect(claimTaskDispatch("user-1")).resolves.toEqual({
      ok: true,
      value: { dispatch: null },
    });
  });

  test("losing the guarded update to a concurrent claimer retries once", async () => {
    const db = install([
      dispatch({ id: "contested", created_at: "2026-07-31T08:00:00.000Z" }),
      dispatch({ id: "second", created_at: "2026-07-31T09:00:00.000Z" }),
    ]);
    let stolen = false;
    db.beforeUpdate = (table) => {
      if (table !== "task_dispatches" || stolen) return;
      stolen = true;
      // Another poll claimed it between our select and our update.
      const row = db.tables.task_dispatches.find((r) => r.id === "contested");
      if (row) {
        row.status = "claimed";
        row.claimed_at = FRESH;
      }
    };

    const result = await claimTaskDispatch("user-1");
    expect(result.ok && result.value.dispatch?.id).toBe("second");
  });

  test("rejects a non-string taskId", async () => {
    install([]);
    await expect(claimTaskDispatch("user-1", 7)).resolves.toEqual({
      ok: false,
      error: "taskId must be a string",
    });
  });
});

describe("updateTaskDispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  test("running sets the status without a finish stamp", async () => {
    const db = install([dispatch({ status: "claimed", claimed_at: FRESH })]);
    await expect(
      updateTaskDispatch("user-1", { dispatchId: "d1", status: "running" }),
    ).resolves.toEqual({ ok: true, value: { ok: true } });

    const row = db.tables.task_dispatches[0];
    expect(row.status).toBe("running");
    expect(row.finished_at).toBeNull();
  });

  test("done stamps finished_at and stores the summary", async () => {
    const db = install([dispatch({ status: "running", claimed_at: FRESH })]);
    await expect(
      updateTaskDispatch("user-1", {
        dispatchId: "d1",
        status: "done",
        resultSummary: "wrote hello.md",
      }),
    ).resolves.toEqual({ ok: true, value: { ok: true } });

    const row = db.tables.task_dispatches[0];
    expect(row.status).toBe("done");
    expect(row.finished_at).toBe(NOW.toISOString());
    expect(row.result_summary).toBe("wrote hello.md");
  });

  test("failed stamps finished_at too", async () => {
    const db = install([dispatch({ status: "running", claimed_at: FRESH })]);
    await updateTaskDispatch("user-1", { dispatchId: "d1", status: "failed" });
    expect(db.tables.task_dispatches[0].finished_at).toBe(NOW.toISOString());
  });

  test("another user's dispatch cannot be updated", async () => {
    const db = install([dispatch({ user_id: "user-2", status: "claimed" })]);
    await expect(
      updateTaskDispatch("user-1", { dispatchId: "d1", status: "done" }),
    ).resolves.toEqual({ ok: false, error: "dispatch not found" });
    expect(db.tables.task_dispatches[0].status).toBe("claimed");
  });

  test("running is only reachable from claimed", async () => {
    const db = install([dispatch({ status: "requested" })]);
    await expect(
      updateTaskDispatch("user-1", { dispatchId: "d1", status: "running" }),
    ).resolves.toEqual({
      ok: false,
      error: "dispatch is requested — cannot move it to running",
    });
    expect(db.tables.task_dispatches[0].status).toBe("requested");
  });

  test("a terminal dispatch is immutable", async () => {
    const db = install([
      dispatch({
        status: "failed",
        claimed_at: FRESH,
        result_summary: "gave up after 3 attempts",
        finished_at: FRESH,
      }),
    ]);
    await expect(
      updateTaskDispatch("user-1", {
        dispatchId: "d1",
        status: "done",
        resultSummary: "actually it worked",
      }),
    ).resolves.toEqual({
      ok: false,
      error: "dispatch is failed — cannot move it to done",
    });
    const row = db.tables.task_dispatches[0];
    expect(row.status).toBe("failed");
    expect(row.result_summary).toBe("gave up after 3 attempts");
  });

  test("failed is reachable from claimed without passing through running", async () => {
    const db = install([dispatch({ status: "claimed", claimed_at: FRESH })]);
    await expect(
      updateTaskDispatch("user-1", { dispatchId: "d1", status: "failed" }),
    ).resolves.toEqual({ ok: true, value: { ok: true } });
    expect(db.tables.task_dispatches[0].status).toBe("failed");
  });

  test("rejects a bad status and a missing id", async () => {
    install([dispatch()]);
    await expect(
      updateTaskDispatch("user-1", { dispatchId: "d1", status: "requested" }),
    ).resolves.toEqual({
      ok: false,
      error: "status must be running, done, or failed",
    });
    await expect(
      updateTaskDispatch("user-1", { dispatchId: "", status: "done" }),
    ).resolves.toEqual({ ok: false, error: "dispatchId is required" });
  });
});
