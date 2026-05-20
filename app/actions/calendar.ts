"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import { updateEvent } from "@/utils/google/calendar";

export type RescheduleInput = {
  calendarId: string;
  eventId: string;
  allDay: boolean;
  start: string;
  end: string;
  startTimeZone: string | null;
  endTimeZone: string | null;
};

function isValidDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00`));
}

function isValidIso(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

export async function rescheduleEvent(input: RescheduleInput) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  if (!input.calendarId || !input.eventId) {
    return { error: "missing event reference" };
  }

  if (input.allDay) {
    if (!isValidDate(input.start) || !isValidDate(input.end)) {
      return { error: "invalid date" };
    }
  } else {
    if (!isValidIso(input.start) || !isValidIso(input.end)) {
      return { error: "invalid datetime" };
    }
    if (Date.parse(input.end) <= Date.parse(input.start)) {
      return { error: "end must be after start" };
    }
  }

  try {
    await updateEvent(user.id, input.calendarId, input.eventId, {
      start: input.allDay
        ? { date: input.start }
        : {
            dateTime: input.start,
            ...(input.startTimeZone ? { timeZone: input.startTimeZone } : {}),
          },
      end: input.allDay
        ? { date: input.end }
        : {
            dateTime: input.end,
            ...(input.endTimeZone ? { timeZone: input.endTimeZone } : {}),
          },
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "update failed",
    };
  }

  revalidatePath("/", "layout");
  return { error: null };
}
