// Call-site regression tests for the timezone sweep.
//
// __tests__/timezone-sweep.test.ts proves the PURE functions are correct given
// the right day. This file proves the CALL SITES hand them the right day, which
// is the actual thesis of the tranche — reverting any of these three sites to a
// process-clock value must turn a test red.
//
// Every case pins `user_settings.timezone` to Asia/Tokyo and freezes the clock
// at 2026-07-27T23:10Z. That instant is deliberately chosen so Tokyo's calendar
// day (2026-07-28) differs from BOTH the UTC day and the Vancouver day
// (2026-07-27): the assertions therefore fail identically on a UTC CI runner
// and on a Vancouver dev box, rather than passing by coincidence on one of
// them.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const TOKYO = "Asia/Tokyo";
// 08:10 on 2026-07-28 in Tokyo; 16:10 on 2026-07-27 in Vancouver; 23:10 on
// 2026-07-27 in UTC.
const INSTANT = new Date(Date.UTC(2026, 6, 27, 23, 10));

type QueryResult = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  authGetUser: vi.fn(),
  from: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.authGetUser },
    from: mocks.from,
  })),
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
  revalidateTag: vi.fn(),
}));

vi.mock("@/app/lib/data/recurring-tasks", () => ({
  RECURRING_TASK_COLUMNS: "id",
}));

vi.mock("@/utils/google/calendar", () => ({ createEvent: vi.fn() }));

vi.mock("@/app/lib/data/settings", () => ({
  getUserPreferences: vi.fn(async () => ({ timezone: TOKYO })),
}));

import {
  completeRecurringOccurrence,
  createRecurringTask,
} from "@/app/actions/recurring-tasks";
import { deleteBalanceChange } from "@/app/actions/finance";

// A minimal PostgREST-shaped builder: every method chains, and awaiting the
// builder (or any terminal like .maybeSingle()) resolves to the queued result
// for that table. Calls are recorded so a test can assert what was written.
type Recorded = { table: string; method: string; args: unknown[] };

function makeClient(queues: Record<string, QueryResult[]>) {
  const recorded: Recorded[] = [];

  class Builder {
    constructor(
      private table: string,
      private result: QueryResult,
    ) {}
    private record(method: string, args: unknown[]) {
      recorded.push({ table: this.table, method, args });
      return this;
    }
    select(...a: unknown[]) {
      return this.record("select", a);
    }
    eq(...a: unknown[]) {
      return this.record("eq", a);
    }
    gte(...a: unknown[]) {
      return this.record("gte", a);
    }
    order(...a: unknown[]) {
      return this.record("order", a);
    }
    limit(...a: unknown[]) {
      return this.record("limit", a);
    }
    maybeSingle(...a: unknown[]) {
      return this.record("maybeSingle", a);
    }
    single(...a: unknown[]) {
      return this.record("single", a);
    }
    insert(...a: unknown[]) {
      return this.record("insert", a);
    }
    upsert(...a: unknown[]) {
      return this.record("upsert", a);
    }
    update(...a: unknown[]) {
      return this.record("update", a);
    }
    delete(...a: unknown[]) {
      return this.record("delete", a);
    }
    then(
      onFulfilled?: (value: QueryResult) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) {
      return Promise.resolve(this.result).then(onFulfilled, onRejected);
    }
  }

  mocks.from.mockImplementation((table: string) => {
    const queue = queues[table];
    if (!queue || queue.length === 0) {
      throw new Error(`unexpected query on "${table}"`);
    }
    return new Builder(table, queue.shift() as QueryResult);
  });

  return {
    recorded,
    writeTo(table: string, method: string) {
      return recorded.find((r) => r.table === table && r.method === method);
    },
  };
}

const userSettings = () => [{ data: { timezone: TOKYO }, error: null }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(INSTANT);
  mocks.authGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("completeRecurringOccurrence guards on the user's day", () => {
  test("accepts the user's today even though UTC is already on the previous day", async () => {
    const client = makeClient({
      user_settings: userSettings(),
      recurring_task_completions: [{ error: null }],
    });

    await expect(
      completeRecurringOccurrence("rule-1", "2026-07-28"),
    ).resolves.toEqual({ error: null });

    const upsert = client.writeTo("recurring_task_completions", "upsert");
    expect(upsert?.args[0]).toMatchObject({
      user_id: "user-1",
      rule_id: "rule-1",
      occurred_on: "2026-07-28",
    });
  });

  test("rejects the UTC day, which is yesterday for this user", async () => {
    makeClient({ user_settings: userSettings() });

    await expect(
      completeRecurringOccurrence("rule-1", "2026-07-27"),
    ).resolves.toEqual({ error: "only today can be completed" });
  });

  test("rejects a malformed key before touching the database", async () => {
    makeClient({});

    await expect(
      completeRecurringOccurrence("rule-1", "28/07/2026"),
    ).resolves.toEqual({ error: "invalid date" });
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

describe("createRecurringTask defaults a custom start_date to the user's day", () => {
  test("stores the user's today, not the UTC day", async () => {
    const client = makeClient({
      user_settings: userSettings(),
      recurring_tasks: [{ data: { id: "r1" }, error: null }],
    });

    await expect(
      createRecurringTask({
        title: "stretch",
        frequency: "custom",
        intervalDays: 3,
      }),
    ).resolves.toMatchObject({ error: null });

    const insert = client.writeTo("recurring_tasks", "insert");
    expect(insert?.args[0]).toMatchObject({ start_date: "2026-07-28" });
  });
});

describe("deleteBalanceChange recomputes on the user's day", () => {
  test("a row dated today in the user's zone still counts toward the balance", async () => {
    // Anchor holds 100 at end of 2026-07-26. One outflow of 10 dated
    // 2026-07-28 — today in Tokyo, tomorrow in UTC. It must be counted, so the
    // persisted balance is 90. On a process-clock `today` the row reads as
    // future-dated, deriveBalance drops it, and this lands on 100.
    const client = makeClient({
      balance_changes: [
        { data: { id: "c1", account_id: "acc-1" }, error: null },
        { error: null },
        {
          data: [
            {
              occurred_at: "2026-07-28",
              direction: "out",
              amount: 10,
              created_at: "2026-07-27T23:05:00.000Z",
            },
          ],
          error: null,
        },
      ],
      user_settings: userSettings(),
      account_reconciliations: [
        {
          data: {
            balance: 100,
            as_of: "2026-07-26",
            created_at: "2026-07-26T10:00:00.000Z",
          },
          error: null,
        },
      ],
      accounts: [{ error: null }],
    });

    await expect(deleteBalanceChange("c1")).resolves.toEqual({ error: null });

    const update = client.writeTo("accounts", "update");
    expect(update?.args[0]).toMatchObject({ balance: 90 });
  });
});
