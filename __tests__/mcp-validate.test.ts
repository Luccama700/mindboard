import { describe, expect, test } from "vitest";
import {
  computeSpendBalance,
  summarizeCreateRecurringTask,
  summarizeCreateTask,
  summarizeLogSpend,
  validateCreateRecurringTask,
  validateCreateTask,
  validateLogSpend,
  validateUpdateRecurringTask,
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

  test("rejects a bad dueTime; accepts a timed block", () => {
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
        dueTime: "12:30",
        durationMin: 30,
      }).ok,
    ).toBe(true);
  });

  test("duration is decoupled from dueTime: a duration alone is valid", () => {
    const r = validateCreateRecurringTask({
      title: "vacuum",
      frequency: "daily",
      durationMin: 45,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.durationMin).toBe(45);
      expect(r.value.dueTime).toBeNull();
    }
    expect(
      validateCreateRecurringTask({
        title: "vacuum",
        frequency: "daily",
        durationMin: 10,
      }).ok,
    ).toBe(false);
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

describe("validateUpdateRecurringTask", () => {
  test("accepts a lone durationMin patch (no dueTime required)", () => {
    const r = validateUpdateRecurringTask({ ruleId: "r1", durationMin: 45 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.durationMin).toBe(45);
      expect(r.value.dueTime).toBeUndefined();
    }
  });

  test("accepts a frequency patch carrying a durationMin but no dueTime", () => {
    const r = validateUpdateRecurringTask({
      ruleId: "r1",
      frequency: "daily",
      durationMin: 30,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.recurrence?.frequency).toBe("daily");
      expect(r.value.durationMin).toBe(30);
    }
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

  test("accepts a positive integer estimatedMinutes and rejects junk", () => {
    const r = validateCreateTask({ title: "x", estimatedMinutes: 90 });
    expect(r.ok && r.value.estimatedMinutes).toBe(90);
    expect(validateCreateTask({ title: "x", estimatedMinutes: 0 }).ok).toBe(false);
    expect(validateCreateTask({ title: "x", estimatedMinutes: -5 }).ok).toBe(false);
    expect(validateCreateTask({ title: "x", estimatedMinutes: 2.5 }).ok).toBe(false);
    expect(validateCreateTask({ title: "x", estimatedMinutes: "2h" }).ok).toBe(false);
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

describe("validateUpdateTask", () => {
  test("requires a taskId and at least one change", async () => {
    const { validateUpdateTask } = await import("@/app/lib/mcp/validate");
    expect(validateUpdateTask({}).ok).toBe(false);
    expect(validateUpdateTask({ taskId: "t1" }).ok).toBe(false);
    expect(validateUpdateTask({ taskId: "t1", title: "new" }).ok).toBe(true);
  });

  test("validates dates, times, and durations; null clears", async () => {
    const { validateUpdateTask } = await import("@/app/lib/mcp/validate");
    expect(validateUpdateTask({ taskId: "t1", dueDate: "tomorrow" }).ok).toBe(false);
    expect(validateUpdateTask({ taskId: "t1", dueDate: null }).ok).toBe(true);
    expect(validateUpdateTask({ taskId: "t1", dueTime: "25:00" }).ok).toBe(false);
    expect(validateUpdateTask({ taskId: "t1", dueTime: "09:30" }).ok).toBe(true);
    expect(validateUpdateTask({ taskId: "t1", durationMin: 5 }).ok).toBe(false);
    expect(validateUpdateTask({ taskId: "t1", title: "  " }).ok).toBe(false);
  });

  test("estimatedMinutes accepts a positive integer or null and rejects junk", async () => {
    const { validateUpdateTask } = await import("@/app/lib/mcp/validate");
    expect(validateUpdateTask({ taskId: "t1", estimatedMinutes: 90 }).ok).toBe(true);
    expect(validateUpdateTask({ taskId: "t1", estimatedMinutes: null }).ok).toBe(true);
    expect(validateUpdateTask({ taskId: "t1", estimatedMinutes: 0 }).ok).toBe(false);
    expect(validateUpdateTask({ taskId: "t1", estimatedMinutes: -5 }).ok).toBe(false);
    expect(validateUpdateTask({ taskId: "t1", estimatedMinutes: 2.5 }).ok).toBe(false);
    expect(validateUpdateTask({ taskId: "t1", estimatedMinutes: "2h" }).ok).toBe(false);
  });

  test("aiState: agent states pass, 'approved' is user-only, junk rejected", async () => {
    const { validateUpdateTask } = await import("@/app/lib/mcp/validate");
    expect(validateUpdateTask({ taskId: "t1", aiState: "planned" }).ok).toBe(true);
    expect(validateUpdateTask({ taskId: "t1", aiState: "built" }).ok).toBe(true);
    expect(validateUpdateTask({ taskId: "t1", aiState: null }).ok).toBe(true);
    // The human approval gate is server-enforced, not just UI convention.
    expect(validateUpdateTask({ taskId: "t1", aiState: "approved" }).ok).toBe(false);
    expect(validateUpdateTask({ taskId: "t1", aiState: "shipped" }).ok).toBe(false);
  });
});

describe("validateManageGroup", () => {
  test("routes the three actions", async () => {
    const { validateManageGroup } = await import("@/app/lib/mcp/validate");
    expect(
      validateManageGroup({ action: "create", name: "School", type: "course" }).ok,
    ).toBe(true);
    expect(validateManageGroup({ action: "create", name: "", type: "course" }).ok).toBe(false);
    expect(validateManageGroup({ action: "create", name: "X", type: "blob" }).ok).toBe(false);
    expect(validateManageGroup({ action: "update", groupId: "g1" }).ok).toBe(false);
    expect(
      validateManageGroup({ action: "update", groupId: "g1", googleCalendarId: null }).ok,
    ).toBe(true);
    expect(validateManageGroup({ action: "archive", groupId: "g1" }).ok).toBe(true);
    expect(validateManageGroup({ action: "delete", groupId: "g1" }).ok).toBe(false);
  });
});

describe("validateRescheduleEvent / validateCreateEvent", () => {
  test("checks timed vs all-day shapes", async () => {
    const { validateRescheduleEvent } = await import("@/app/lib/mcp/validate");
    expect(
      validateRescheduleEvent({
        calendarId: "c",
        eventId: "e",
        start: "2026-07-09T10:00:00",
        end: "2026-07-09T09:00:00",
      }).ok,
    ).toBe(false);
    expect(
      validateRescheduleEvent({
        calendarId: "c",
        eventId: "e",
        allDay: true,
        start: "2026-07-09",
        end: "2026-07-10",
      }).ok,
    ).toBe(true);
  });

  test("createEvent defaults duration and calendar, and ties duration to a time", async () => {
    const { validateCreateEvent } = await import("@/app/lib/mcp/validate");
    const timed = validateCreateEvent({ summary: "Dentist", date: "2026-07-09", startTime: "14:00" });
    expect(timed.ok).toBe(true);
    if (timed.ok) {
      expect(timed.value.durationMin).toBe(60);
      expect(timed.value.calendarId).toBe("primary");
    }
    expect(
      validateCreateEvent({ summary: "X", date: "2026-07-09", durationMin: 30 }).ok,
    ).toBe(false);
  });
});

describe("validateDailyLog / validateUpdateSettings", () => {
  test("bounds mood/energy/sleep", async () => {
    const { validateDailyLog } = await import("@/app/lib/mcp/validate");
    expect(validateDailyLog({ mood: 3, energy: 4 }).ok).toBe(true);
    expect(validateDailyLog({ mood: 0, energy: 4 }).ok).toBe(false);
    expect(validateDailyLog({ mood: 3, energy: 4, sleepHours: 30 }).ok).toBe(false);
  });

  test("bounds the wake window when both edges are present", async () => {
    const { validateUpdateSettings } = await import("@/app/lib/mcp/validate");
    expect(validateUpdateSettings({}).ok).toBe(false);
    expect(validateUpdateSettings({ timezone: "America/New_York" }).ok).toBe(true);
    expect(validateUpdateSettings({ wakeStartHour: 9, wakeEndHour: 8 }).ok).toBe(false);
    expect(validateUpdateSettings({ wakeStartHour: 7, wakeEndHour: 23 }).ok).toBe(true);
  });

  test("bounds streamMaxTasks to 3-15", async () => {
    const { validateUpdateSettings } = await import("@/app/lib/mcp/validate");
    expect(validateUpdateSettings({ streamMaxTasks: 3 }).ok).toBe(true);
    expect(validateUpdateSettings({ streamMaxTasks: 15 }).ok).toBe(true);
    expect(validateUpdateSettings({ streamMaxTasks: 2 }).ok).toBe(false);
    expect(validateUpdateSettings({ streamMaxTasks: 16 }).ok).toBe(false);
    expect(validateUpdateSettings({ streamMaxTasks: 2.5 }).ok).toBe(false);
  });
});
