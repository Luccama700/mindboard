// Rendering regression test for the dashboard stream: task cards due today
// must actually appear. Server actions and sheets are stubbed — this tests
// the client rendering pipeline (visible(), overrides, sections), not writes.
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
    gcal_event_id: null,
    gcal_calendar_id: null,
    status: "todo",
    priority: "med",
    notes: null,
    group_id: null,
    created_at: "2026-07-08T09:00:00Z",
    completed_at: null,
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

const snapshot: StreamSnapshot = {
  pulse: { todayDelta: 0, currency: "CAD", toClear: 0, freeHours: 4, mood: null },
  now: [taskCard("t0", "overdue thing")],
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
  nextUp: null,
};

describe("StreamClient rendering", () => {
  test("renders task cards in now and next sections", () => {
    render(
      <StreamClient
        snapshot={snapshot}
        accounts={[]}
        categories={[]}
        gaps={[]}
        groups={[
          { id: "g1", name: "Personal", color: "#3CD9FF" },
          { id: "g2", name: "English Classes", color: "#9E44F8" },
        ]}
        todayLabel="tuesday, jul 8"
        clockLabel="9:41 am"
      />,
    );

    expect(screen.getByText("overdue thing")).toBeTruthy();
    expect(screen.getByText("Log Flavio Class")).toBeTruthy();
    expect(screen.getByText("Prepare for L license test")).toBeTruthy();
    // The group button wears the task's own group; inbox for the ungrouped.
    expect(screen.getByText("English Classes ▾")).toBeTruthy();
    expect(screen.getAllByText("inbox ▾").length).toBe(2);
  });
});
