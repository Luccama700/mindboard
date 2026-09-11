import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  proposeBreakdown: vi.fn(),
  confirmBreakdown: vi.fn(),
  cancelBreakdown: vi.fn(),
}));

vi.mock("@/app/actions/tasks", () => ({
  pushTaskToCalendar: vi.fn(),
  queueTaskFollowup: vi.fn(),
  requestTaskDispatch: vi.fn(),
  setTaskAiState: vi.fn(),
  proposeBreakdown: mocks.proposeBreakdown,
  confirmBreakdown: mocks.confirmBreakdown,
  cancelBreakdown: mocks.cancelBreakdown,
}));

import { TaskRow } from "@/app/_components/task-row";
import type { Task } from "@/app/_components/types";

const TODAY = "2026-09-15";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    group_id: null,
    title: "Write PHIL 240 essay",
    due_date: "2026-09-24",
    due_time: null,
    duration_min: null,
    status: "todo",
    priority: "med",
    notes: null,
    estimated_minutes: 240,
    ai_state: null,
    gcal_event_id: null,
    gcal_calendar_id: null,
    created_at: "2026-09-01T00:00:00.000Z",
    completed_at: null,
    missed_at: null,
    energy_cost: 4,
    energy_source: "ai",
    parent_task_id: null,
    not_before: null,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("energy on the task row", () => {
  test("the row shows the AI default as a suggested rating; one tap sets a user value", () => {
    const onUpdate = vi.fn();
    render(
      <TaskRow
        task={task()}
        today={TODAY}
        groups={[]}
        onToggle={() => {}}
        onDelete={() => {}}
        onUpdate={onUpdate}
        open
      />,
    );
    // Subtitle dots (read-only) name the level and that it is a suggestion.
    expect(screen.getAllByLabelText("energy 4 of 5, suggested").length).toBeGreaterThan(0);
    // The control reads "suggested" for an AI value…
    expect(screen.getByText("suggested")).toBeTruthy();
    // …and one tap on a dot writes that level.
    fireEvent.click(screen.getByRole("radio", { name: "energy 2 of 5" }));
    expect(onUpdate).toHaveBeenCalledWith("t1", { energyCost: 2 });
    // Tapping the current level clears it.
    fireEvent.click(screen.getByRole("radio", { name: "energy 4 of 5" }));
    expect(onUpdate).toHaveBeenCalledWith("t1", { energyCost: null });
  });

  test("a user-set value reads as yours", () => {
    render(
      <TaskRow
        task={task({ energy_source: "user", energy_cost: 5 })}
        today={TODAY}
        groups={[]}
        onToggle={() => {}}
        onDelete={() => {}}
        onUpdate={() => {}}
        open
      />,
    );
    expect(screen.getByText("yours")).toBeTruthy();
    expect(screen.getAllByLabelText("energy 5 of 5").length).toBeGreaterThan(0);
  });
});

describe("decomposition on the task row", () => {
  test("a parent shows progress and offers a big-task breakdown only when it has no steps yet", () => {
    const { rerender } = render(
      <TaskRow
        task={task()}
        today={TODAY}
        groups={[]}
        onToggle={() => {}}
        onDelete={() => {}}
        onUpdate={() => {}}
        open
      />,
    );
    expect(screen.getByRole("button", { name: "✂ break down · big task" })).toBeTruthy();

    rerender(
      <TaskRow
        task={task()}
        today={TODAY}
        groups={[]}
        onToggle={() => {}}
        onDelete={() => {}}
        onUpdate={() => {}}
        open
        progress={{ done: 2, total: 5 }}
      />,
    );
    expect(screen.getByText("2 of 5 done")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /break down/ })).toBeNull();
    expect(screen.getByRole("button", { name: "delete + 5 steps" })).toBeTruthy();
  });

  test("a child shows its parent and window and never offers 'incomplete' or a breakdown", () => {
    const onMiss = vi.fn();
    render(
      <TaskRow
        task={task({
          id: "c1",
          title: "Pull three quotes",
          parent_task_id: "t1",
          not_before: "2026-09-16",
          due_date: "2026-09-14",
          estimated_minutes: 20,
        })}
        today={TODAY}
        groups={[]}
        onToggle={() => {}}
        onDelete={() => {}}
        onUpdate={() => {}}
        onMiss={onMiss}
        variant="overdue"
        parentTitle="Write PHIL 240 essay"
        open
      />,
    );
    expect(screen.getByText("↳ Write PHIL 240 essay")).toBeTruthy();
    expect(screen.getByLabelText("not before")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "incomplete" })).toBeNull();
    expect(screen.queryByRole("button", { name: /break down/ })).toBeNull();
  });

  test("break down proposes, renders the steps, and writes only on the confirm tap", async () => {
    mocks.proposeBreakdown.mockResolvedValue({
      error: null,
      proposalId: "prop-1",
      preview: "…",
      children: [
        { title: "Pull three quotes", estimatedMinutes: 20, energyCost: 2, notBefore: "2026-09-15", dueDate: "2026-09-18" },
        { title: "Outline argument", estimatedMinutes: 40, energyCost: 4, notBefore: "2026-09-17", dueDate: "2026-09-20" },
      ],
    });
    mocks.confirmBreakdown.mockResolvedValue({ error: null, preview: "…" });
    render(
      <TaskRow
        task={task()}
        today={TODAY}
        groups={[]}
        onToggle={() => {}}
        onDelete={() => {}}
        onUpdate={() => {}}
        open
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "✂ break down · big task" }));
    await waitFor(() => expect(screen.getByText("Pull three quotes")).toBeTruthy());
    expect(mocks.proposeBreakdown).toHaveBeenCalledWith("t1");
    expect(mocks.confirmBreakdown).not.toHaveBeenCalled();
    expect(screen.getByText("Outline argument")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "add steps" }));
    await waitFor(() => expect(mocks.confirmBreakdown).toHaveBeenCalledWith("prop-1"));
    await waitFor(() =>
      expect(screen.getByText(/2 steps added/)).toBeTruthy(),
    );
  });

  test("skip rejects the proposal", async () => {
    mocks.proposeBreakdown.mockResolvedValue({
      error: null,
      proposalId: "prop-2",
      preview: "…",
      children: [
        { title: "a", estimatedMinutes: 20, energyCost: 2, notBefore: "2026-09-15", dueDate: "2026-09-18" },
        { title: "b", estimatedMinutes: 40, energyCost: 4, notBefore: "2026-09-17", dueDate: "2026-09-20" },
      ],
    });
    mocks.cancelBreakdown.mockResolvedValue({ error: null });
    render(
      <TaskRow
        task={task({ estimated_minutes: 30 })}
        today={TODAY}
        groups={[]}
        onToggle={() => {}}
        onDelete={() => {}}
        onUpdate={() => {}}
        open
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "✂ break down" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "skip" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "skip" }));
    await waitFor(() => expect(mocks.cancelBreakdown).toHaveBeenCalledWith("prop-2"));
    expect(mocks.confirmBreakdown).not.toHaveBeenCalled();
  });

  test("a propose error is shown, nothing else changes", async () => {
    mocks.proposeBreakdown.mockResolvedValue({
      error: '"Write PHIL 240 essay" needs a due date first — the steps are planned backwards from it',
    });
    render(
      <TaskRow
        task={task({ due_date: null, estimated_minutes: 30 })}
        today={TODAY}
        groups={[]}
        onToggle={() => {}}
        onDelete={() => {}}
        onUpdate={() => {}}
        open
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "✂ break down" }));
    await waitFor(() => expect(screen.getByText(/needs a due date first/)).toBeTruthy());
  });
});
