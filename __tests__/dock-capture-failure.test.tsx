import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  createRecurringTask: vi.fn(),
  recordBalanceChange: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/actions/tasks", () => ({ createTask: mocks.createTask }));
vi.mock("@/app/actions/recurring-tasks", () => ({ createRecurringTask: mocks.createRecurringTask }));
vi.mock("@/app/actions/finance", () => ({ recordBalanceChange: mocks.recordBalanceChange }));
vi.mock("@/app/actions/groups", () => ({ loadCalendarOptions: vi.fn(async () => []) }));
vi.mock("@/app/actions/people-groups", () => ({ loadPeopleGroups: vi.fn(async () => []) }));
vi.mock("@/app/tasks/groups-client", () => ({ GroupsClient: () => null }));
vi.mock("@/app/_components/categories-sheet", () => ({ CategoriesSheet: () => null }));
vi.mock("@/app/_components/people-groups-manager", () => ({ PeopleGroupsManager: () => null }));

import { Dock } from "@/app/_components/dock";

const events: string[] = [];
const record = (e: Event) => events.push(e.type);

function dock(today = "2026-11-17") {
  return (
    <Dock
      today={today}
      groups={[]}
      inboxCount={0}
      brainCount={0}
      accounts={[{ id: "a1", name: "chequing", balance: 100, currency: "CAD" } as never]}
      categories={[]}
    />
  );
}

const input = () => screen.getByPlaceholderText(/new task/) as HTMLInputElement;

async function add(text: string) {
  fireEvent.change(input(), { target: { value: text } });
  await act(async () => {
    fireEvent.submit(input().closest("form")!);
  });
}

beforeEach(() => {
  events.length = 0;
  for (const t of ["mindboard:task-optimistic", "mindboard:task-replace", "mindboard:task-remove"]) {
    window.addEventListener(t, record);
  }
  mocks.createTask.mockReset();
  mocks.createRecurringTask.mockReset();
  mocks.recordBalanceChange.mockReset();
});

afterEach(() => {
  cleanup();
  for (const t of ["mindboard:task-optimistic", "mindboard:task-replace", "mindboard:task-remove"]) {
    window.removeEventListener(t, record);
  }
});

describe("dock task capture failures", () => {
  test("an error result gives the title back, says so, and drops the stand-in card", async () => {
    mocks.createTask.mockResolvedValueOnce({ error: "not authenticated" });
    render(dock());
    await add("buy milk");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/not saved/));
    expect(input().value).toBe("buy milk");
    expect(events).toEqual(["mindboard:task-optimistic", "mindboard:task-remove"]);
  });

  test("a throwing action does not leave the dock stuck busy", async () => {
    mocks.createTask.mockRejectedValueOnce(new Error("offline"));
    render(dock());
    await add("buy milk");
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    mocks.createTask.mockResolvedValueOnce({ error: null, task: { id: "t1", title: "buy milk" } });
    await add("buy milk");
    await waitFor(() => expect(mocks.createTask).toHaveBeenCalledTimes(2));
    expect(input().value).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a routine that fails to save gives the words back too", async () => {
    mocks.createRecurringTask.mockResolvedValueOnce({ error: "invalid frequency" });
    render(dock());
    await add("gym daily");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/invalid frequency/));
    expect(input().value).toBe("gym daily");
  });
});

describe("dock due date across midnight", () => {
  test("a chip still on yesterday moves to the new today", async () => {
    mocks.createTask.mockResolvedValue({ error: null, task: { id: "t1" } });
    const { rerender } = render(dock("2026-11-16"));
    rerender(dock("2026-11-17"));
    await add("call landlord");
    expect(mocks.createTask.mock.calls[0][0].dueDate).toBe("2026-11-17");
  });

  test("a date the user picked is kept", async () => {
    mocks.createTask.mockResolvedValue({ error: null, task: { id: "t1" } });
    const { rerender, container } = render(dock("2026-11-16"));
    const picker = container.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(picker, { target: { value: "2026-11-20" } });
    rerender(dock("2026-11-17"));
    await add("call landlord");
    expect(mocks.createTask.mock.calls[0][0].dueDate).toBe("2026-11-20");
  });
});

describe("dock spend capture", () => {
  test("sends the amount spent, not a balance from its own copy", async () => {
    mocks.recordBalanceChange.mockResolvedValue({ error: null });
    render(dock());
    await add("$12 lunch");
    await act(async () => {
      fireEvent.submit(input().closest("form")!);
    });
    await waitFor(() => expect(mocks.recordBalanceChange).toHaveBeenCalled());
    const sent = mocks.recordBalanceChange.mock.calls[0][0];
    expect(sent).toMatchObject({ accountId: "a1", spent: 12 });
    expect(sent).not.toHaveProperty("newBalance");
  });
});
