import { describe, expect, test } from "vitest";
import { financeSnapshot } from "@/app/lib/snapshots/finance";
import { inventorySnapshot } from "@/app/lib/snapshots/inventory";
import { tasksSnapshot } from "@/app/lib/snapshots/tasks";
import { scheduleSnapshot, type ScheduleEvent } from "@/app/lib/snapshots/schedule";
import {
  getTool,
  readTools,
  toolRegistry,
  writeTools,
} from "@/app/lib/agent/registry";
import type {
  Account,
  BalanceChange,
  RecurringExpense,
} from "@/app/_components/finance-types";
import type {
  InventoryItem,
  InventoryUsage,
} from "@/app/_components/inventory-types";
import type { TaskWithGroup } from "@/app/_components/types";

// ---------- factories ----------

function account(partial: Partial<Account>): Account {
  return {
    id: "a",
    name: "checking",
    type: "checking",
    color: "#b5ff3c",
    balance: 0,
    currency: "USD",
    archived: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

function change(partial: Partial<BalanceChange>): BalanceChange {
  return {
    id: "c",
    account_id: "a",
    category_id: null,
    direction: "out",
    amount: 0,
    note: null,
    occurred_at: "2026-06-01",
    created_at: "2026-06-01T00:00:00Z",
    source: "manual",
    is_transfer: false,
    ...partial,
  };
}

function expense(partial: Partial<RecurringExpense>): RecurringExpense {
  return {
    id: "e",
    name: "bill",
    amount: 100,
    category_id: null,
    frequency: "monthly",
    day_of_month: 1,
    weekday: null,
    interval_days: null,
    start_date: null,
    archived: false,
    created_at: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

function item(partial: Partial<InventoryItem>): InventoryItem {
  return {
    id: "i",
    name: "item",
    quantity: 10,
    unit: "",
    notes: null,
    image_url: null,
    inventory_group_id: null,
    reorder_threshold: null,
    priority: "med",
    archived: false,
    archived_at: null,
    last_restocked_at: null,
    shopping_pinned: false,
    buy_amount: null,
    est_price: null,
    price_source: null,
    price_checked_at: null,
    created_at: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

function usage(partial: Partial<InventoryUsage>): InventoryUsage {
  return {
    id: "u",
    inventory_item_id: "i",
    amount: 1,
    period: "day",
    interval_days: null,
    created_at: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

function task(partial: Partial<TaskWithGroup>): TaskWithGroup {
  return {
    id: "t",
    title: "task",
    due_date: null,
    due_time: null,
    duration_min: null,
    estimated_minutes: null,
    gcal_event_id: null,
    gcal_calendar_id: null,
    status: "todo",
    priority: "med",
    ai_state: null,
    notes: null,
    group_id: null,
    created_at: "2026-01-01T00:00:00Z",
    completed_at: null,
    missed_at: null,
    group_name: null,
    group_color: null,
    ...partial,
  };
}

const TODAY = "2026-06-01";

// ---------- finance ----------

describe("financeSnapshot", () => {
  test("net worth is the sum of account balances", () => {
    const snap = financeSnapshot({
      accounts: [account({ balance: 1200 }), account({ id: "b", balance: 300 })],
      todayChanges: [],
      recurringExpenses: [],
      today: TODAY,
    });
    expect(snap.netWorth).toBe(1500);
    expect(snap.currency).toBe("USD");
  });

  test("today delta is signed by direction", () => {
    const snap = financeSnapshot({
      accounts: [],
      todayChanges: [
        change({ direction: "in", amount: 500 }),
        change({ direction: "out", amount: 80 }),
      ],
      recurringExpenses: [],
      today: TODAY,
    });
    expect(snap.todayDelta).toBe(420);
  });

  test("next bill is the soonest recurring expense after today", () => {
    const snap = financeSnapshot({
      accounts: [],
      todayChanges: [],
      recurringExpenses: [
        expense({ name: "rent", amount: 900, frequency: "monthly", day_of_month: 4 }),
      ],
      today: TODAY,
    });
    expect(snap.nextBill).toEqual({
      name: "rent",
      amount: 900,
      dateKey: "2026-06-04",
    });
  });

  test("a daily expense lands tomorrow and wins over a later monthly one", () => {
    const snap = financeSnapshot({
      accounts: [],
      todayChanges: [],
      recurringExpenses: [
        expense({ name: "rent", amount: 900, frequency: "monthly", day_of_month: 4 }),
        expense({ id: "e2", name: "coffee", amount: 5, frequency: "daily" }),
      ],
      today: TODAY,
    });
    expect(snap.nextBill).toEqual({
      name: "coffee",
      amount: 5,
      dateKey: "2026-06-02",
    });
  });

  test("no recurring expenses means no next bill", () => {
    const snap = financeSnapshot({
      accounts: [],
      todayChanges: [],
      recurringExpenses: [],
      today: TODAY,
    });
    expect(snap.nextBill).toBeNull();
  });

  test("currency defaults to USD with no accounts", () => {
    const snap = financeSnapshot({
      accounts: [],
      todayChanges: [],
      recurringExpenses: [],
      today: TODAY,
    });
    expect(snap.currency).toBe("USD");
  });

  test("the first-listed expense wins when two land on the same soonest day", () => {
    const snap = financeSnapshot({
      accounts: [],
      todayChanges: [],
      recurringExpenses: [
        expense({ id: "e1", name: "rent", amount: 900, frequency: "monthly", day_of_month: 5 }),
        expense({ id: "e2", name: "phone", amount: 60, frequency: "monthly", day_of_month: 5 }),
      ],
      today: TODAY,
    });
    expect(snap.nextBill?.name).toBe("rent");
  });

  test("finds a bill exactly at the 62-day lookahead edge but not one day beyond it", () => {
    const withinLookahead = financeSnapshot({
      accounts: [],
      todayChanges: [],
      recurringExpenses: [
        expense({
          name: "annual-ish",
          amount: 40,
          frequency: "custom",
          interval_days: 62,
          start_date: TODAY,
        }),
      ],
      today: TODAY,
    });
    expect(withinLookahead.nextBill).toEqual({
      name: "annual-ish",
      amount: 40,
      dateKey: "2026-08-02",
    });

    const beyondLookahead = financeSnapshot({
      accounts: [],
      todayChanges: [],
      recurringExpenses: [
        expense({
          name: "too-far",
          amount: 40,
          frequency: "custom",
          interval_days: 63,
          start_date: TODAY,
        }),
      ],
      today: TODAY,
    });
    expect(beyondLookahead.nextBill).toBeNull();
  });

  test("coerces a Supabase-numeric-as-string balance/amount", () => {
    const snap = financeSnapshot({
      accounts: [account({ balance: "150.50" as unknown as number })],
      todayChanges: [change({ direction: "in", amount: "20.25" as unknown as number })],
      recurringExpenses: [],
      today: TODAY,
    });
    expect(snap.netWorth).toBe(150.5);
    expect(snap.todayDelta).toBe(20.25);
  });
});

// ---------- inventory ----------

describe("inventorySnapshot", () => {
  test("counts low and out items by reorder threshold", () => {
    const snap = inventorySnapshot({
      items: [
        item({ id: "ok", quantity: 10, reorder_threshold: 3 }),
        item({ id: "low", quantity: 2, reorder_threshold: 3 }),
        item({ id: "out", quantity: 0, reorder_threshold: 3 }),
      ],
      usages: [],
      today: TODAY,
    });
    expect(snap.lowCount).toBe(1);
    expect(snap.outCount).toBe(1);
  });

  test("soonest run-out picks the item that empties first", () => {
    const snap = inventorySnapshot({
      items: [
        item({ id: "milk", name: "milk", quantity: 3 }),
        item({ id: "rice", name: "rice", quantity: 10 }),
      ],
      usages: [
        usage({ id: "u1", inventory_item_id: "milk", amount: 1, period: "day" }),
        usage({ id: "u2", inventory_item_id: "rice", amount: 1, period: "day" }),
      ],
      today: TODAY,
    });
    expect(snap.soonestRunOut).toEqual({ name: "milk", dateKey: "2026-06-04" });
  });

  test("items with no usage never report a run-out date", () => {
    const snap = inventorySnapshot({
      items: [item({ quantity: 5 })],
      usages: [],
      today: TODAY,
    });
    expect(snap.soonestRunOut).toBeNull();
  });

  test("archived items are excluded from counts and run-out entirely", () => {
    const snap = inventorySnapshot({
      items: [
        item({ id: "gone", name: "gone", quantity: 0, reorder_threshold: 5, archived: true }),
      ],
      usages: [usage({ id: "u", inventory_item_id: "gone", amount: 5, period: "day" })],
      today: TODAY,
    });
    expect(snap.lowCount).toBe(0);
    expect(snap.outCount).toBe(0);
    expect(snap.soonestRunOut).toBeNull();
  });

  test("multiple usage rules for the same item combine into one effective rate", () => {
    const snap = inventorySnapshot({
      items: [item({ id: "milk", name: "milk", quantity: 10 })],
      usages: [
        usage({ id: "u1", inventory_item_id: "milk", amount: 1, period: "day" }),
        usage({ id: "u2", inventory_item_id: "milk", amount: 2, period: "day" }),
      ],
      today: TODAY,
    });
    // combined rate 3/day: ceil(10/3) = 4 days
    expect(snap.soonestRunOut).toEqual({ name: "milk", dateKey: "2026-06-05" });
  });

  test("a tied run-out date keeps the first item processed, not the last", () => {
    const snap = inventorySnapshot({
      items: [
        item({ id: "a", name: "first", quantity: 5 }),
        item({ id: "b", name: "second", quantity: 5 }),
      ],
      usages: [
        usage({ id: "u1", inventory_item_id: "a", amount: 1, period: "day" }),
        usage({ id: "u2", inventory_item_id: "b", amount: 1, period: "day" }),
      ],
      today: TODAY,
    });
    expect(snap.soonestRunOut).toEqual({ name: "first", dateKey: "2026-06-06" });
  });
});

// ---------- tasks ----------

describe("tasksSnapshot", () => {
  test("buckets open dated tasks into overdue / today / soon", () => {
    const snap = tasksSnapshot(
      [
        task({ id: "1", due_date: "2026-05-30" }), // overdue
        task({ id: "2", due_date: "2026-06-01" }), // today
        task({ id: "3", due_date: "2026-06-05" }), // soon
        task({ id: "4", due_date: "2026-06-20" }), // beyond a week
        task({ id: "5", due_date: "2026-06-02", status: "done" }), // done, ignored
        task({ id: "6", due_date: null }), // undated, ignored
      ],
      TODAY,
    );
    expect(snap).toEqual({ overdue: 1, dueToday: 1, dueSoon: 1 });
  });

  test("day 7 is the inclusive edge of dueSoon; day 8 falls outside it", () => {
    const snap = tasksSnapshot(
      [
        task({ id: "1", due_date: "2026-06-08" }), // exactly 7 days out
        task({ id: "2", due_date: "2026-06-09" }), // 8 days out
      ],
      TODAY,
    );
    expect(snap).toEqual({ overdue: 0, dueToday: 0, dueSoon: 1 });
  });

  test("in-progress tasks are counted like open tasks, not skipped like done ones", () => {
    const snap = tasksSnapshot(
      [task({ id: "1", due_date: "2026-06-01", status: "doing" })],
      TODAY,
    );
    expect(snap.dueToday).toBe(1);
  });

  test("missed tasks are skipped like done ones — never overdue, due today, or soon", () => {
    const snap = tasksSnapshot(
      [
        task({ id: "1", due_date: "2026-05-30", status: "missed" }), // would be overdue
        task({ id: "2", due_date: "2026-06-01", status: "missed" }), // would be today
        task({ id: "3", due_date: "2026-06-05", status: "missed" }), // would be soon
      ],
      TODAY,
    );
    expect(snap).toEqual({ overdue: 0, dueToday: 0, dueSoon: 0 });
  });
});

// ---------- schedule ----------

function localIso(hour: number, minute = 0): string {
  return new Date(2026, 5, 1, hour, minute, 0).toISOString();
}

function event(partial: Partial<ScheduleEvent>): ScheduleEvent {
  return { summary: "event", start: localIso(13), end: localIso(14), allDay: false, ...partial };
}

describe("scheduleSnapshot", () => {
  const NOON = new Date(2026, 5, 1, 12, 0, 0);

  test("free hours = wake window after now minus busy time", () => {
    const snap = scheduleSnapshot({
      events: [event({ start: localIso(13), end: localIso(14) })],
      now: NOON,
    });
    // window 12:00..22:00 = 10h, minus 1h busy = 9h
    expect(snap.freeHoursToday).toBeCloseTo(9);
    expect(snap.nextEvent?.summary).toBe("event");
  });

  test("overlapping events are merged, not double-counted", () => {
    const snap = scheduleSnapshot({
      events: [
        event({ start: localIso(13), end: localIso(15) }),
        event({ start: localIso(14), end: localIso(16) }),
      ],
      now: NOON,
    });
    // union 13:00..16:00 = 3h busy, 10h - 3h = 7h
    expect(snap.freeHoursToday).toBeCloseTo(7);
  });

  test("all-day and already-ended events are ignored", () => {
    const snap = scheduleSnapshot({
      events: [
        event({ summary: "past", start: localIso(9), end: localIso(10) }),
        event({ summary: "allday", allDay: true, start: "2026-06-01", end: "2026-06-02" }),
      ],
      now: NOON,
    });
    expect(snap.nextEvent).toBeNull();
    expect(snap.freeHoursToday).toBeCloseTo(10);
  });

  test("no free time once the wake window has passed", () => {
    const snap = scheduleSnapshot({
      events: [],
      now: new Date(2026, 5, 1, 23, 0, 0),
    });
    expect(snap.freeHoursToday).toBe(0);
  });
});

// ---------- registry seam ----------

describe("tool registry", () => {
  test("tool names are unique", () => {
    const names = toolRegistry.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every tool has a valid kind and maps to an implementation", () => {
    for (const tool of toolRegistry) {
      expect(["read", "write"]).toContain(tool.kind);
      expect(tool.mapsTo).toMatch(/#/);
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  test("write tools require confirmation (agreed autonomy stance)", () => {
    for (const tool of writeTools()) {
      expect(tool.confirm).toBe(true);
    }
    expect(readTools().length).toBeGreaterThan(0);
    expect(writeTools().length).toBeGreaterThan(0);
  });

  test("getTool looks up by name", () => {
    expect(getTool("life.financeSnapshot")?.kind).toBe("read");
    expect(getTool("tasks.create")?.kind).toBe("write");
    expect(getTool("nope")).toBeUndefined();
  });
});
