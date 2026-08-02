// Call-site regression test for the CLIENT write paths of the timezone sweep.
//
// __tests__/timezone-call-sites.test.ts covers the server actions. This covers
// the other half: a component whose date chip WRITES tasks.due_date must write
// the user's day (threaded from the server), not the device's.
//
// The device clock is frozen to a Vancouver evening — 2026-07-27T23:10Z is
// 16:10 on the 27th locally — while the server's day is 2026-07-28. Those
// differ for a default-configured account every evening, because
// user_settings.timezone is null until the user visits /settings, so the server
// falls back to UTC. Reverting TaskRow to todayISO(null) makes both assertions
// below fail on a Vancouver box and the second one fail anywhere.

import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/app/actions/tasks", () => ({
  pushTaskToCalendar: vi.fn(),
  setTaskAiState: vi.fn(),
}));

import { TaskRow } from "@/app/_components/task-row";
import type { Task } from "@/app/_components/types";

const DEVICE_INSTANT = new Date(Date.UTC(2026, 6, 27, 23, 10));
const SERVER_TODAY = "2026-07-28";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    group_id: null,
    title: "water the plants",
    due_date: null,
    due_time: null,
    status: "todo",
    priority: "med",
    notes: null,
    estimated_minutes: null,
    ai_state: null,
    created_at: "2026-07-20T00:00:00.000Z",
    completed_at: null,
    missed_at: null,
    ...overrides,
  } as Task;
}

function renderRow(t: Task, onUpdate: (id: string, patch: unknown) => void) {
  return render(
    <TaskRow
      task={t}
      today={SERVER_TODAY}
      groups={[]}
      onToggle={() => {}}
      onDelete={() => {}}
      onUpdate={onUpdate}
      open
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the task date chip writes the user's day", () => {
  test("tapping `today` writes the server's day, not the device's", () => {
    vi.useFakeTimers();
    vi.setSystemTime(DEVICE_INSTANT);
    const onUpdate = vi.fn();

    renderRow(task(), onUpdate);
    fireEvent.click(screen.getByText("today"));

    expect(onUpdate).toHaveBeenCalledWith("t1", { dueDate: SERVER_TODAY });
    // The device's day on a Vancouver box would be 2026-07-27; anywhere west of
    // UTC in the evening it is the previous day.
    expect(onUpdate).not.toHaveBeenCalledWith("t1", { dueDate: "2026-07-27" });
  });

  test("a task already due on the user's today reads as today and clears on tap", () => {
    vi.useFakeTimers();
    vi.setSystemTime(DEVICE_INSTANT);
    const onUpdate = vi.fn();

    renderRow(task({ due_date: SERVER_TODAY }), onUpdate);

    // Chip is in its active state because the task's due date IS the user's
    // today — on the device clock it would have rendered inactive, and the tap
    // below would have re-set the date instead of clearing it.
    fireEvent.click(screen.getByText("✓ today"));
    expect(onUpdate).toHaveBeenCalledWith("t1", { dueDate: null });
  });
});
