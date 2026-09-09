import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/app/actions/tasks", () => ({
  pushTaskToCalendar: vi.fn(),
  queueTaskFollowup: vi.fn(),
  requestTaskDispatch: vi.fn(async () => ({ error: null, dispatchId: "d1" })),
  setTaskAiState: vi.fn(),
}));

import { TaskRow } from "@/app/_components/task-row";
import type { Task } from "@/app/_components/types";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    group_id: null,
    title: "renew the passport",
    due_date: null,
    due_time: null,
    status: "todo",
    priority: "med",
    notes: null,
    estimated_minutes: null,
    ai_state: null,
    created_at: "2026-09-01T00:00:00.000Z",
    completed_at: null,
    missed_at: null,
    ...overrides,
  } as Task;
}

function renderOpenRow(t: Task) {
  return render(
    <TaskRow
      task={t}
      today="2026-09-09"
      groups={[]}
      onToggle={() => {}}
      onDelete={() => {}}
      onUpdate={() => {}}
      open
    />,
  );
}

afterEach(cleanup);

describe("✦ do it in the task edit panel", () => {
  test("sits beside ✦ follow up and opens the dispatch sheet", () => {
    renderOpenRow(task());
    expect(screen.getByRole("button", { name: "✦ follow up" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "✦ do it" }));
    expect(screen.getByRole("dialog", { name: "send to the agent" })).toBeTruthy();
    expect(screen.getByLabelText("note for the agent")).toBeTruthy();
  });

  test("is hidden once the task is done", () => {
    renderOpenRow(task({ status: "done" }));
    expect(screen.queryByRole("button", { name: "✦ do it" })).toBeNull();
  });
});
