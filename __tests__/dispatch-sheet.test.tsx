// The "✦ do it" affordance: the sheet that sends an operator note to the home
// worker, and its entry point on the day stream. The server action is stubbed —
// this covers the client pipeline (validation, states, wiring), not the write.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { StreamCard, StreamSnapshot } from "@/app/lib/snapshots/stream";
import type { Task } from "@/app/_components/types";

const mocks = vi.hoisted(() => ({ requestTaskDispatch: vi.fn() }));

vi.mock("@/app/actions/tasks", () => ({
  createTask: vi.fn(async () => ({ error: null })),
  toggleTaskStatus: vi.fn(async () => ({ error: null })),
  updateTask: vi.fn(async () => ({ error: null })),
  markTaskMissed: vi.fn(async () => ({ error: null })),
  requestTaskDispatch: mocks.requestTaskDispatch,
}));
vi.mock("@/app/actions/inventory", () => ({
  updateInventoryItem: vi.fn(async () => ({ error: null })),
}));
vi.mock("@/app/actions/recurring-tasks", () => ({
  completeRecurringOccurrence: vi.fn(async () => ({ error: null })),
  updateRecurringTask: vi.fn(async () => ({ error: null })),
  archiveRecurringTask: vi.fn(async () => ({ error: null })),
}));

import { DispatchSheet } from "@/app/_components/dispatch-sheet";
import { StreamClient } from "@/app/_components/stream-client";

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestTaskDispatch.mockResolvedValue({
    error: null,
    dispatchId: "d1",
  });
});

describe("DispatchSheet", () => {
  const TASK = { id: "task-1", title: "book the practice room" };

  test("renders the task title, a note field, and a disabled send", () => {
    render(<DispatchSheet task={TASK} onClose={() => {}} />);

    expect(screen.getByText("book the practice room")).toBeTruthy();
    expect(
      screen.getByPlaceholderText("anything the agent should know or do?"),
    ).toBeTruthy();
    const send = screen.getByRole("button", { name: "✦ do it" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });

  test("a whitespace-only note keeps send disabled", () => {
    render(<DispatchSheet task={TASK} onClose={() => {}} />);
    const field = screen.getByPlaceholderText(
      "anything the agent should know or do?",
    );
    fireEvent.change(field, { target: { value: "   " } });
    const send = screen.getByRole("button", { name: "✦ do it" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });

  test("sending dispatches the trimmed note and confirms", async () => {
    render(<DispatchSheet task={TASK} onClose={() => {}} />);
    fireEvent.change(
      screen.getByPlaceholderText("anything the agent should know or do?"),
      { target: { value: "  check the booking site  " } },
    );
    fireEvent.click(screen.getByRole("button", { name: "✦ do it" }));

    await waitFor(() =>
      expect(mocks.requestTaskDispatch).toHaveBeenCalledWith({
        taskId: "task-1",
        note: "check the booking site",
      }),
    );
    await screen.findByText("✦ dispatched — the pc picks it up within ~5 min");
  });

  test("an action error is shown and the note is kept", async () => {
    mocks.requestTaskDispatch.mockResolvedValue({
      error: "no agent PC serves this account",
    });
    render(<DispatchSheet task={TASK} onClose={() => {}} />);
    fireEvent.change(
      screen.getByPlaceholderText("anything the agent should know or do?"),
      { target: { value: "do it" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "✦ do it" }));

    await screen.findByText("no agent PC serves this account");
    expect(
      (
        screen.getByPlaceholderText(
          "anything the agent should know or do?",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("do it");
  });
});

// ---------- the stream entry point ----------

function task(id: string, title: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title,
    due_date: "2026-07-31",
    due_time: null,
    duration_min: null,
    estimated_minutes: null,
    gcal_event_id: null,
    gcal_calendar_id: null,
    status: "todo",
    priority: "med",
    notes: null,
    group_id: null,
    created_at: "2026-07-31T09:00:00Z",
    completed_at: null,
    missed_at: null,
    ...over,
  } as Task;
}

function taskCard(id: string, title: string, over: Partial<Task> = {}): StreamCard {
  return {
    id: `task:${id}`,
    domain: "task",
    glyph: "○",
    fact: title,
    meta: "today",
    entity: {
      kind: "task",
      task: { ...task(id, title, over), group_name: null, group_color: null },
    },
  } as StreamCard;
}

function snapshotWith(cards: StreamCard[]): StreamSnapshot {
  return {
    pulse: { todayDelta: 0, currency: "CAD", toClear: 0, freeHours: 4, mood: null },
    now: cards,
    nowOverflow: 0,
    next: [],
    nextOverflow: 0,
    later: [],
    laterOverflow: 0,
    loose: [],
    routines: [],
    routinesOverflow: 0,
    nextUp: null,
  };
}

function renderStream(cards: StreamCard[], agentServiced: boolean) {
  return render(
    <StreamClient
      snapshot={snapshotWith(cards)}
      accounts={[]}
      categories={[]}
      gaps={[]}
      groups={[]}
      weekDone={0}
      weekMissed={0}
      mindshare={null}
      todayLabel="friday, jul 31"
      clockLabel="9:41 am"
      agentServiced={agentServiced}
    />,
  );
}

describe("stream do-it button", () => {
  test("no ✦ do it when no agent PC serves the account", () => {
    renderStream([taskCard("t1", "book the room")], false);
    expect(screen.queryByText("✦ do it")).toBeNull();
  });

  test("✦ do it opens the dispatch sheet for that task", async () => {
    renderStream([taskCard("t1", "book the room")], true);
    fireEvent.click(screen.getByText("✦ do it"));

    expect(screen.getByRole("dialog", { name: "send to the agent" })).toBeTruthy();
    expect(
      screen.getByPlaceholderText("anything the agent should know or do?"),
    ).toBeTruthy();
  });

  test("a task already with the agent shows its ai_state badge", () => {
    renderStream(
      [taskCard("t1", "book the room", { ai_state: "building" } as Partial<Task>)],
      true,
    );
    expect(screen.getByText("✦ working…")).toBeTruthy();
  });

  test("a done task gets no ✦ do it", () => {
    renderStream(
      [taskCard("t1", "book the room", { status: "done" } as Partial<Task>)],
      true,
    );
    expect(screen.queryByText("✦ do it")).toBeNull();
  });
});
