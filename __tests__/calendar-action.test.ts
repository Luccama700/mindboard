import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authGetUser: vi.fn(),
  revalidatePath: vi.fn(),
  updateEvent: vi.fn(),
}));

vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: mocks.authGetUser,
    },
  })),
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));

vi.mock("@/utils/google/calendar", () => ({
  updateEvent: mocks.updateEvent,
}));

import { rescheduleEvent } from "@/app/actions/calendar";

const baseInput = {
  calendarId: "cal-1",
  eventId: "event-1",
  allDay: false,
  start: "2026-05-23T10:00:00.000Z",
  end: "2026-05-23T11:00:00.000Z",
  startTimeZone: "America/Vancouver",
  endTimeZone: "America/Vancouver",
};

describe("rescheduleEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authGetUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
    });
    mocks.updateEvent.mockResolvedValue(undefined);
  });

  test("requires an authenticated user", async () => {
    mocks.authGetUser.mockResolvedValue({ data: { user: null } });

    await expect(rescheduleEvent(baseInput)).resolves.toEqual({
      error: "not authenticated",
    });
    expect(mocks.updateEvent).not.toHaveBeenCalled();
  });

  test("rejects missing event references", async () => {
    await expect(
      rescheduleEvent({ ...baseInput, calendarId: "" }),
    ).resolves.toEqual({ error: "missing event reference" });

    expect(mocks.updateEvent).not.toHaveBeenCalled();
  });

  test("validates all-day dates before writing to Google", async () => {
    await expect(
      rescheduleEvent({
        ...baseInput,
        allDay: true,
        start: "2026-02-31",
        end: "2026-05-24",
      }),
    ).resolves.toEqual({ error: "invalid date" });

    expect(mocks.updateEvent).not.toHaveBeenCalled();
  });

  test("validates timed event ranges before writing to Google", async () => {
    await expect(
      rescheduleEvent({
        ...baseInput,
        start: "2026-05-23T11:00:00.000Z",
        end: "2026-05-23T10:00:00.000Z",
      }),
    ).resolves.toEqual({ error: "end must be after start" });

    expect(mocks.updateEvent).not.toHaveBeenCalled();
  });

  test("patches timed events with preserved time zones", async () => {
    await expect(rescheduleEvent(baseInput)).resolves.toEqual({ error: null });

    expect(mocks.updateEvent).toHaveBeenCalledWith(
      "user-1",
      "cal-1",
      "event-1",
      {
        start: {
          dateTime: "2026-05-23T10:00:00.000Z",
          timeZone: "America/Vancouver",
        },
        end: {
          dateTime: "2026-05-23T11:00:00.000Z",
          timeZone: "America/Vancouver",
        },
      },
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  test("patches all-day events with date fields", async () => {
    await expect(
      rescheduleEvent({
        ...baseInput,
        allDay: true,
        start: "2026-05-23",
        end: "2026-05-24",
      }),
    ).resolves.toEqual({ error: null });

    expect(mocks.updateEvent).toHaveBeenCalledWith(
      "user-1",
      "cal-1",
      "event-1",
      {
        start: { date: "2026-05-23" },
        end: { date: "2026-05-24" },
      },
    );
  });

  test("returns Google update errors without revalidating", async () => {
    mocks.updateEvent.mockRejectedValue(new Error("google said no"));

    await expect(rescheduleEvent(baseInput)).resolves.toEqual({
      error: "google said no",
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
