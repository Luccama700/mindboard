import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  setTaskAiState: vi.fn(async () => ({ error: null, stamped: false, stampError: null })),
}));

vi.mock("@/app/actions/tasks", () => ({
  pushTaskToCalendar: vi.fn(),
  queueTaskFollowup: vi.fn(),
  requestTaskDispatch: vi.fn(),
  setTaskAiState: mocks.setTaskAiState,
}));

import { TaskRow } from "@/app/_components/task-row";
import type { Task } from "@/app/_components/types";

const DECLINED_NOTES = [
  "ask the landlord about the lease",
  "",
  "---",
  "",
  "## AI triage — 2026-09-09",
  "",
  "needs a phone call, which I can't make",
  "",
  "*✦ follow up or ✦ do it if you want the PC to try anyway.*",
].join("\n");

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    group_id: null,
    title: "lease renewal",
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

afterEach(() => {
  cleanup();
  mocks.setTaskAiState.mockClear();
});

describe("a declined task", () => {
  test("shows ✦ not taken with the triage reason and the follow-up box already open", () => {
    renderOpenRow(task({ ai_state: "declined", notes: DECLINED_NOTES }));
    expect(screen.getByText("✦ not taken")).toBeTruthy();
    expect(screen.getByText("needs a phone call, which I can't make")).toBeTruthy();
    expect(screen.getByLabelText("follow-up instruction")).toBeTruthy();
    expect(screen.getByRole("button", { name: "✦ do it" })).toBeTruthy();
  });

  test("falls back to 'see the notes' when no triage section exists", () => {
    renderOpenRow(task({ ai_state: "declined", notes: "plain notes" }));
    expect(screen.getByText("see the notes")).toBeTruthy();
  });

  test("clear sends the state back to null", () => {
    renderOpenRow(task({ ai_state: "declined", notes: DECLINED_NOTES }));
    fireEvent.click(screen.getByRole("button", { name: "clear" }));
    expect(mocks.setTaskAiState).toHaveBeenCalledWith("t1", null);
  });
});

describe("a planned task", () => {
  test("does not pre-open the follow-up box", () => {
    renderOpenRow(task({ ai_state: "planned", notes: "## AI plan — 2026-09-09\n\ndo x" }));
    expect(screen.queryByLabelText("follow-up instruction")).toBeNull();
    expect(screen.getByText("✦ plan ready")).toBeTruthy();
  });
});
