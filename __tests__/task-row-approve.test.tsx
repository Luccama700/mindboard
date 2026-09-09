import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ setTaskAiState: vi.fn() }));

vi.mock("@/app/actions/tasks", () => ({
  pushTaskToCalendar: vi.fn(),
  queueTaskFollowup: vi.fn(),
  requestTaskDispatch: vi.fn(),
  setTaskAiState: mocks.setTaskAiState,
}));

import { TaskRow } from "@/app/_components/task-row";
import type { Task } from "@/app/_components/types";

function planned(): Task {
  return {
    id: "t1",
    group_id: null,
    title: "ship the thing",
    due_date: null,
    due_time: null,
    status: "todo",
    priority: "med",
    notes: "## AI plan — 2026-09-09\n\ndo x then y",
    estimated_minutes: null,
    ai_state: "planned",
    created_at: "2026-09-01T00:00:00.000Z",
    completed_at: null,
    missed_at: null,
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
  mocks.setTaskAiState.mockReset();
});

describe("approving a plan", () => {
  test("says the pc picks it up when the stamp landed", async () => {
    mocks.setTaskAiState.mockResolvedValue({ error: null, stamped: true, stampError: null });
    renderOpenRow(planned());
    fireEvent.click(screen.getByRole("button", { name: "approve" }));
    await waitFor(() => expect(screen.getByText("✦ queued")).toBeTruthy());
    expect(screen.getByText("the pc picks it up within ~5 min")).toBeTruthy();
  });

  test("says 4am when there is no pc for this account", async () => {
    mocks.setTaskAiState.mockResolvedValue({ error: null, stamped: false, stampError: null });
    renderOpenRow(planned());
    fireEvent.click(screen.getByRole("button", { name: "approve" }));
    await waitFor(() => expect(screen.getByText("queued for the 4am run")).toBeTruthy());
  });

  test("says it couldn't wake the pc when the stamp failed", async () => {
    mocks.setTaskAiState.mockResolvedValue({ error: null, stamped: false, stampError: "boom" });
    renderOpenRow(planned());
    fireEvent.click(screen.getByRole("button", { name: "approve" }));
    await waitFor(() =>
      expect(screen.getByText("couldn't wake the pc — it runs at 4am")).toBeTruthy(),
    );
  });
});
