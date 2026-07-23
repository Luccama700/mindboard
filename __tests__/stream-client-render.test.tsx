// Rendering regression test for the dashboard stream: task cards due today
// must actually appear. Server actions and sheets are stubbed — this tests
// the client rendering pipeline (visible(), overrides, sections), not writes.
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { StreamCard, StreamSnapshot } from "@/app/lib/snapshots/stream";
import type { Task } from "@/app/_components/types";

vi.mock("@/app/actions/tasks", () => ({
  createTask: vi.fn(async () => ({ error: null })),
  toggleTaskStatus: vi.fn(async () => ({ error: null })),
  updateTask: vi.fn(async () => ({ error: null })),
}));
vi.mock("@/app/actions/inventory", () => ({
  updateInventoryItem: vi.fn(async () => ({ error: null })),
}));
vi.mock("@/app/actions/recurring-tasks", () => ({
  completeRecurringOccurrence: vi.fn(async () => ({ error: null })),
  updateRecurringTask: vi.fn(async () => ({ error: null })),
  archiveRecurringTask: vi.fn(async () => ({ error: null })),
}));
vi.mock("@/app/_components/stream-sheets", () => ({
  DailyLogSheet: () => null,
  SpendSheet: () => null,
}));

import { StreamClient } from "@/app/_components/stream-client";

function task(id: string, title: string): Task {
  return {
    id,
    title,
    due_date: "2026-07-08",
    due_time: null,
    duration_min: null,
    estimated_minutes: null,
    gcal_event_id: null,
    gcal_calendar_id: null,
    status: "todo",
    priority: "med",
    notes: null,
    group_id: null,
    created_at: "2026-07-08T09:00:00Z",
    completed_at: null,
    missed_at: null,
  } as Task;
}

function taskCard(
  id: string,
  title: string,
  group?: { name: string; color: string },
): StreamCard {
  return {
    id: `task:${id}`,
    domain: "task",
    glyph: "○",
    fact: title,
    meta: "today",
    entity: {
      kind: "task",
      task: {
        ...task(id, title),
        group_name: group?.name ?? null,
        group_color: group?.color ?? null,
      },
    },
  } as StreamCard;
}

function rtaskCard(id: string, title: string): StreamCard {
  return {
    id: `rtask:${id}:2026-07-08`,
    domain: "task",
    glyph: "↻",
    fact: title,
    meta: "today · every day",
    entity: {
      kind: "rtask",
      ruleId: id,
      dateKey: "2026-07-08",
      title,
      dueTime: null,
      durationMin: 45,
      frequency: "daily",
      weekdays: null,
      day_of_month: null,
      interval_days: null,
      start_date: null,
      priority: "med",
      group_id: null,
      group_name: null,
      hasNotes: false,
      plannedStart: null,
      slotStart: null,
    },
  } as StreamCard;
}

const snapshot: StreamSnapshot = {
  pulse: { todayDelta: 0, currency: "CAD", toClear: 0, freeHours: 4, mood: null },
  now: [taskCard("t0", "overdue thing")],
  nowOverflow: 0,
  next: [
    taskCard("t1", "Log Flavio Class", {
      name: "English Classes",
      color: "#9E44F8",
    }),
    taskCard("t2", "Prepare for L license test"),
  ],
  nextOverflow: 0,
  later: [],
  laterOverflow: 0,
  loose: [],
  routines: [],
  routinesOverflow: 0,
  nextUp: null,
};

const GROUPS = [
  { id: "g1", name: "Personal", color: "#3CD9FF" },
  { id: "g2", name: "English Classes", color: "#9E44F8" },
];

function renderStream(snap: StreamSnapshot) {
  return render(
    <StreamClient
      snapshot={snap}
      accounts={[]}
      categories={[]}
      gaps={[]}
      groups={GROUPS}
      weekDone={0}
      weekMissed={0}
      todayLabel="tuesday, jul 8"
      clockLabel="9:41 am"
    />,
  );
}

// A NOW task card with explicit overrides for the fields tier/overdue logic
// reads. due_date "2020-01-01" is always overdue; "2999-01-01" never is.
function nowCard(
  id: string,
  over: Partial<StreamCard> & { taskOver?: Partial<Task> } = {},
): StreamCard {
  const { taskOver, ...cardOver } = over;
  const base = taskCard(id, `task ${id}`);
  return {
    ...base,
    ...cardOver,
    entity: {
      kind: "task",
      task: { ...(base.entity as { task: Task }).task, ...taskOver },
    },
  } as StreamCard;
}

afterEach(cleanup);

describe("StreamClient rendering", () => {
  test("renders task cards in now and next sections", () => {
    renderStream(snapshot);

    expect(screen.getByText("overdue thing")).toBeTruthy();
    expect(screen.getByText("Log Flavio Class")).toBeTruthy();
    expect(screen.getByText("Prepare for L license test")).toBeTruthy();
    // The group button wears the task's own group; inbox for the ungrouped.
    expect(screen.getByText("English Classes ▾")).toBeTruthy();
    expect(screen.getAllByText("inbox ▾").length).toBe(2);
  });

  test("an overdue task card shows the incomplete button", () => {
    renderStream({
      ...snapshot,
      now: [nowCard("late", { taskOver: { due_date: "2020-01-01" } })],
      next: [],
    });
    expect(screen.getByText("incomplete")).toBeTruthy();
  });

  test("a non-overdue task card has no incomplete button", () => {
    renderStream({
      ...snapshot,
      now: [nowCard("soon", { taskOver: { due_date: "2999-01-01" } })],
      next: [],
    });
    expect(screen.queryByText("incomplete")).toBeNull();
  });

  test("an rtask card title toggle opens the edit panel with stop repeating", () => {
    renderStream({
      ...snapshot,
      now: [],
      next: [],
      routines: [rtaskCard("r1", "morning stretch")],
    });
    // Collapsed: no panel yet.
    expect(screen.queryByText("stop repeating")).toBeNull();
    fireEvent.click(screen.getByText("morning stretch"));
    expect(screen.getByText("stop repeating")).toBeTruthy();
  });

  test("the routines section renders last and holds recurring cards", () => {
    const { container } = renderStream({
      ...snapshot,
      now: [taskCard("t0", "overdue thing")],
      next: [taskCard("t1", "log the class")],
      later: [],
      routines: [rtaskCard("r1", "morning stretch")],
    });
    // The recurring card lives under a "routines" section label.
    expect(screen.getByText("routines")).toBeTruthy();
    expect(screen.getByText("morning stretch")).toBeTruthy();
    // routines is the last section in the DOM, after now/next.
    const labels = Array.from(
      container.querySelectorAll("section"),
    ).map((s) => s.textContent ?? "");
    const routinesSection = labels.findIndex((t) => t.includes("routines"));
    const nextSection = labels.findIndex((t) => t.includes("log the class"));
    expect(routinesSection).toBeGreaterThan(nextSection);
  });

  test("a tier-3 task renders the focus treatment (glass panel + effort/lateness meta)", () => {
    const { container } = renderStream({
      ...snapshot,
      now: [
        nowCard("focus", {
          tier: 3,
          taskOver: { due_date: "2020-01-01", estimated_minutes: 120 },
        }),
      ],
      next: [],
    });
    expect(container.querySelector(".glass-panel")).toBeTruthy();
    // focus meta: effort + lateness (danger tint on the lateness)
    expect(screen.getByText("~2h")).toBeTruthy();
    expect(screen.getByText(/d late/)).toBeTruthy();
  });
});
