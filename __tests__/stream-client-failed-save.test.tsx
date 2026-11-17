// A done / missed / snooze on the stream hides the card at once. When the save
// behind it fails, the card has to come back and the strip has to say so:
// before, it vanished while the task stayed open in the database.
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { StreamCard, StreamSnapshot } from "@/app/lib/snapshots/stream";
import type { Task } from "@/app/_components/types";

const mocks = vi.hoisted(() => ({
  toggleTaskStatus: vi.fn(),
  markTaskMissed: vi.fn(),
  completeRecurringOccurrence: vi.fn(),
}));

vi.mock("@/app/actions/tasks", () => ({
  createTask: vi.fn(async () => ({ error: null })),
  toggleTaskStatus: mocks.toggleTaskStatus,
  markTaskMissed: mocks.markTaskMissed,
  updateTask: vi.fn(async () => ({ error: null })),
}));
vi.mock("@/app/actions/inventory", () => ({ updateInventoryItem: vi.fn() }));
vi.mock("@/app/actions/recurring-tasks", () => ({
  completeRecurringOccurrence: mocks.completeRecurringOccurrence,
  updateRecurringTask: vi.fn(),
  archiveRecurringTask: vi.fn(),
}));
vi.mock("@/app/_components/stream-sheets", () => ({ DailyLogSheet: () => null, SpendSheet: () => null }));

import { StreamClient } from "@/app/_components/stream-client";

function taskCard(id: string, title: string, due = "2026-07-08"): StreamCard {
  return {
    id: `task:${id}`,
    domain: "task",
    glyph: "○",
    fact: title,
    meta: "today",
    entity: {
      kind: "task",
      task: {
        id, title, due_date: due, due_time: null, duration_min: null, estimated_minutes: null,
        gcal_event_id: null, gcal_calendar_id: null, status: "todo", priority: "med", notes: null,
        group_id: null, created_at: "2026-07-08T09:00:00Z", completed_at: null, missed_at: null,
        ai_state: null, group_name: null, group_color: null,
      } as Task,
    },
  } as StreamCard;
}

function rtaskCard(id: string, title: string): StreamCard {
  return {
    id: `rtask:${id}:2026-07-07`, domain: "task", glyph: "↻", fact: title, meta: "today · every day",
    entity: {
      kind: "rtask", ruleId: id, dateKey: "2026-07-07", title, dueTime: null, durationMin: 45,
      frequency: "daily", weekdays: null, day_of_month: null, interval_days: null, start_date: null,
      priority: "med", group_id: null, group_name: null, group_color: null, hasNotes: false,
      plannedStart: null, slotStart: null,
    },
  } as StreamCard;
}

function snap(over: Partial<StreamSnapshot>): StreamSnapshot {
  return {
    pulse: { todayDelta: 0, currency: "CAD", toClear: 0, freeHours: 4, mood: null },
    people: { suggestion: null },
    now: [], nowOverflow: 0, next: [], nextOverflow: 0, later: [], laterOverflow: 0,
    loose: [], routines: [], routinesOverflow: 0, nextUp: null,
    ...over,
  } as StreamSnapshot;
}

function renderStream(s: StreamSnapshot) {
  return render(
    <StreamClient
      snapshot={s} accounts={[]} categories={[]} gaps={[]} groups={[]}
      weekDone={0} weekMissed={0} mindshare={null}
      today="2026-07-08" todayLabel="tuesday, jul 8" clockLabel="9:41 am"
    />,
  );
}

async function press(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
  // Past the 300/450ms hide delay.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 600));
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("stream steps whose save fails", () => {
  test("done on a task that fails to save brings the card back with a message", async () => {
    mocks.toggleTaskStatus.mockResolvedValueOnce({ error: "not authenticated" });
    renderStream(snap({ next: [taskCard("t1", "pay rent")] }));
    await press("done");
    expect(screen.getByText("pay rent")).toBeTruthy();
    expect(screen.getByText(/couldn't save pay rent: not authenticated/)).toBeTruthy();
  });

  test("a throwing save is treated the same", async () => {
    mocks.toggleTaskStatus.mockRejectedValueOnce(new Error("offline"));
    renderStream(snap({ next: [taskCard("t1", "pay rent")] }));
    await press("done");
    expect(screen.getByText("pay rent")).toBeTruthy();
    expect(screen.getByText(/couldn't reach the server/)).toBeTruthy();
  });

  test("a routine card from yesterday, refused by the server, comes back", async () => {
    mocks.completeRecurringOccurrence.mockResolvedValueOnce({ error: "only today can be completed" });
    renderStream(snap({ routines: [rtaskCard("r1", "stretch")] }));
    await press("done");
    expect(screen.getByText("stretch")).toBeTruthy();
    expect(screen.getByText(/only today can be completed/)).toBeTruthy();
  });

  test("missed that fails comes back too", async () => {
    mocks.markTaskMissed.mockResolvedValueOnce({ error: "task not found" });
    renderStream(snap({ now: [taskCard("t0", "old thing", "2020-01-01")] }));
    await press("incomplete");
    expect(screen.getByText("old thing")).toBeTruthy();
    expect(screen.getByText(/task not found/)).toBeTruthy();
  });

  test("a save that works still hides the card", async () => {
    mocks.toggleTaskStatus.mockResolvedValueOnce({ error: null, nextStatus: "done" });
    renderStream(snap({ next: [taskCard("t1", "pay rent")] }));
    await press("done");
    expect(screen.queryByText("pay rent")).toBeNull();
  });
});
