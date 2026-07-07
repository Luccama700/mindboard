import { describe, expect, test } from "vitest";
import {
  computeSpendBalance,
  summarizeCreateRecurringTask,
  summarizeCreateTask,
  summarizeLogSpend,
  validateCreateRecurringTask,
  validateCreateTask,
  validateLogSpend,
} from "@/app/lib/mcp/validate";

describe("validateCreateRecurringTask", () => {
  test("weekly needs at least one valid weekday; dedupes and sorts", () => {
    expect(
      validateCreateRecurringTask({ title: "gym", frequency: "weekly" }).ok,
    ).toBe(false);
    expect(
      validateCreateRecurringTask({
        title: "gym",
        frequency: "weekly",
        weekdays: [7],
      }).ok,
    ).toBe(false);
    const r = validateCreateRecurringTask({
      title: "gym",
      frequency: "weekly",
      weekdays: [5, 1, 3, 1],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.weekdays).toEqual([1, 3, 5]);
  });

  test("monthly needs dayOfMonth; custom needs intervalDays", () => {
    expect(
      validateCreateRecurringTask({ title: "rent", frequency: "monthly" }).ok,
    ).toBe(false);
    expect(
      validateCreateRecurringTask({
        title: "rent",
        frequency: "monthly",
        dayOfMonth: 31,
      }).ok,
    ).toBe(true);
    expect(
      validateCreateRecurringTask({ title: "water", frequency: "custom" }).ok,
    ).toBe(false);
    expect(
      validateCreateRecurringTask({
        title: "water",
        frequency: "custom",
        intervalDays: 3,
      }).ok,
    ).toBe(true);
  });

  test("rejects bad dueTime and durationMin without a time", () => {
    expect(
      validateCreateRecurringTask({
        title: "lunch",
        frequency: "daily",
        dueTime: "25:00",
      }).ok,
    ).toBe(false);
    expect(
      validateCreateRecurringTask({
        title: "lunch",
        frequency: "daily",
        durationMin: 30,
      }).ok,
    ).toBe(false);
    expect(
      validateCreateRecurringTask({
        title: "lunch",
        frequency: "daily",
        dueTime: "12:30",
        durationMin: 30,
      }).ok,
    ).toBe(true);
  });

  test("summary reads like a schedule and names the first landing day", () => {
    const r = validateCreateRecurringTask({
      title: "gym",
      groupId: "g1",
      frequency: "weekly",
      weekdays: [1, 3, 5],
      dueTime: "17:00",
      durationMin: 60,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const summary = summarizeCreateRecurringTask(r.value, "health", "2026-07-07");
    expect(summary).toContain('"gym"');
    expect(summary).toContain("mon/wed/fri");
    expect(summary).toContain("at 17:00 (60min)");
    expect(summary).toContain('group "health"');
    expect(summary).toContain("First lands 2026-07-08"); // Tue -> Wed
  });
});

describe("validateCreateTask", () => {
  test("requires a non-empty title", () => {
    expect(validateCreateTask({}).ok).toBe(false);
    expect(validateCreateTask({ title: "   " }).ok).toBe(false);
  });

  test("defaults group to inbox, priority to med, and trims", () => {
    const r = validateCreateTask({ title: "  buy milk  " });
    expect(r).toEqual({
      ok: true,
      value: {
        title: "buy milk",
        groupId: null,
        dueDate: null,
        notes: null,
        priority: "med",
      },
    });
  });

  test("rejects a malformed due date", () => {
    const r = validateCreateTask({ title: "x", dueDate: "07/05/2026" });
    expect(r).toEqual({ ok: false, error: "dueDate must be YYYY-MM-DD" });
  });

  test("accepts a valid due date and trims notes", () => {
    const r = validateCreateTask({
      title: "x",
      dueDate: "2026-07-05",
      notes: "  hi  ",
      groupId: "g1",
      priority: "high",
    });
    expect(r.ok && r.value).toMatchObject({
      dueDate: "2026-07-05",
      notes: "hi",
      groupId: "g1",
      priority: "high",
    });
  });

  test("rejects an invalid priority and a non-string groupId", () => {
    expect(validateCreateTask({ title: "x", priority: "urgent" }).ok).toBe(false);
    expect(validateCreateTask({ title: "x", groupId: 5 }).ok).toBe(false);
  });
});

describe("summarizeCreateTask", () => {
  test("names the inbox when no group", () => {
    const r = validateCreateTask({ title: "walk" });
    if (!r.ok) throw new Error("expected ok");
    expect(summarizeCreateTask(r.value, null)).toBe('Create task "walk" in inbox.');
  });

  test("names the group and due date", () => {
    const r = validateCreateTask({ title: "walk", groupId: "g1", dueDate: "2026-07-05" });
    if (!r.ok) throw new Error("expected ok");
    expect(summarizeCreateTask(r.value, "Home")).toBe(
      'Create task "walk" in group "Home", due 2026-07-05.',
    );
  });
});

describe("validateLogSpend", () => {
  test("requires an accountId and a positive amount", () => {
    expect(validateLogSpend({ amount: 5 }).ok).toBe(false);
    expect(validateLogSpend({ accountId: "a", amount: 0 }).ok).toBe(false);
    expect(validateLogSpend({ accountId: "a", amount: -3 }).ok).toBe(false);
    expect(validateLogSpend({ accountId: "a", amount: Number.NaN }).ok).toBe(false);
  });

  test("rounds the amount to cents and defaults category/note", () => {
    const r = validateLogSpend({ accountId: "a", amount: 12.005 });
    expect(r).toEqual({
      ok: true,
      value: { accountId: "a", amount: 12.01, categoryId: null, note: null },
    });
  });

  test("rejects a non-string categoryId", () => {
    expect(validateLogSpend({ accountId: "a", amount: 1, categoryId: 7 }).ok).toBe(false);
  });
});

describe("computeSpendBalance", () => {
  test("subtracts and rounds to the cent", () => {
    expect(computeSpendBalance(100, 12.5)).toBe(87.5);
    expect(computeSpendBalance(100.1, 0.2)).toBe(99.9);
  });

  test("can go negative (overdraft is the caller's concern)", () => {
    expect(computeSpendBalance(5, 20)).toBe(-15);
  });
});

describe("summarizeLogSpend", () => {
  test("includes the category when set", () => {
    const r = validateLogSpend({ accountId: "a", amount: 12, categoryId: "c1" });
    if (!r.ok) throw new Error("expected ok");
    expect(
      summarizeLogSpend(r.value, { accountName: "Checking", currency: "USD", categoryName: "groceries" }),
    ).toBe('Log $12.00 spent from "Checking" on groceries.');
  });

  test("omits the category when absent", () => {
    const r = validateLogSpend({ accountId: "a", amount: 12 });
    if (!r.ok) throw new Error("expected ok");
    expect(
      summarizeLogSpend(r.value, { accountName: "Checking", currency: "USD", categoryName: null }),
    ).toBe('Log $12.00 spent from "Checking".');
  });
});
