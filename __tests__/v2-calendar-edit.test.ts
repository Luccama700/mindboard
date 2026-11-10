// @vitest-environment node
// Task 12, editing by hand: snapping a pointer to the grid, moving an event,
// resizing one from either edge, and dragging a new one out of empty space.
//
// EVERYTHING HERE IS INVENTED. The daylight-saving cases are built with the
// zone helpers rather than written out, and they assert elapsed time and wall
// minutes only, never an offset string: runtimes carry different zone
// databases and can disagree about an offset.

import { describe, expect, test } from "vitest";

import { zonedClockMinutes, zonedDateKey, zonedIso } from "@/app/lib/snapshots/zoned-time";
import { minutesToMs } from "@/app/lib/v2/plan/day";
import {
  DRAFT_ID_PREFIX,
  draftAt,
  isDraftId,
  moveAllDay,
  moveTimed,
  resizeTimed,
  snapMinute,
} from "@/app/lib/v2/calendar/edit";
import { MIN_EVENT_MINUTES, MINUTES_PER_DAY } from "@/app/lib/v2/calendar/types";
import type { CalEvent } from "@/app/lib/v2/calendar/types";

const PHOENIX = "America/Phoenix";
const OFF = "-07:00";
const NY = "America/New_York";
/** A Wednesday. */
const DAY = "2026-04-15";
const HOUR_MS = 3_600_000;

const at = (clock: string, date: string = DAY) => `${date}T${clock}:00${OFF}`;

function timed(id: string, start: string, end: string, extra: Partial<CalEvent> = {}): CalEvent {
  return {
    id,
    calendarId: "cal-a",
    title: id,
    allDay: false,
    start,
    end,
    location: null,
    etag: "e1",
    editable: true,
    recurring: false,
    ...extra,
  };
}

function allDay(id: string, start: string, end: string): CalEvent {
  return { ...timed(id, start, end), allDay: true };
}

/** An event built from wall minutes in New York, so no offset is written out. */
function nyEvent(date: string, startMinute: number, endMinute: number): CalEvent {
  return timed(
    "ny",
    zonedIso(minutesToMs(date, startMinute, NY), NY),
    zonedIso(minutesToMs(date, endMinute, NY), NY),
  );
}

const elapsed = (event: CalEvent) => Date.parse(event.end) - Date.parse(event.start);

describe("snapMinute", () => {
  test("it rounds to the nearest quarter hour", () => {
    expect(snapMinute(0)).toBe(0);
    expect(snapMinute(7)).toBe(0);
    expect(snapMinute(8)).toBe(15);
    expect(snapMinute(22)).toBe(15);
    expect(snapMinute(23)).toBe(30);
    expect(snapMinute(540)).toBe(540);
  });

  test("it clamps to the day at both ends", () => {
    expect(snapMinute(-1)).toBe(0);
    expect(snapMinute(-500)).toBe(0);
    expect(snapMinute(1439)).toBe(MINUTES_PER_DAY);
    expect(snapMinute(9_000)).toBe(MINUTES_PER_DAY);
  });

  test("another step is honoured", () => {
    expect(snapMinute(100, 30)).toBe(90);
    expect(snapMinute(105, 30)).toBe(120);
    expect(snapMinute(104, 60)).toBe(120);
    expect(snapMinute(7, 5)).toBe(5);
  });

  test("a step that cannot divide the day falls back to a whole minute", () => {
    expect(snapMinute(7, 0)).toBe(7);
    expect(snapMinute(7.4, -5)).toBe(7);
  });
});

describe("moveTimed", () => {
  test("it keeps the length and lands on the minute it was given", () => {
    const moved = moveTimed(timed("a", at("09:00"), at("10:30")), "2026-04-17", 14 * 60, PHOENIX);
    expect(moved.start).toBe(at("14:00", "2026-04-17"));
    expect(moved.end).toBe(at("15:30", "2026-04-17"));
    expect(moved.id).toBe("a");
    expect(moved.etag).toBe("e1");
  });

  test("a move that runs past midnight keeps running", () => {
    const moved = moveTimed(timed("a", at("09:00"), at("11:00")), DAY, 23 * 60, PHOENIX);
    expect(moved.start).toBe(at("23:00"));
    expect(moved.end).toBe(at("01:00", "2026-04-16"));
    expect(elapsed(moved)).toBe(2 * HOUR_MS);
  });

  test("the minute is clamped to the day it is dropped on", () => {
    const moved = moveTimed(timed("a", at("09:00"), at("10:00")), DAY, -120, PHOENIX);
    expect(moved.start).toBe(at("00:00"));
  });

  test("it does not touch an all day event", () => {
    const event = allDay("a", "2026-04-15", "2026-04-16");
    expect(moveTimed(event, "2026-04-17", 540, PHOENIX)).toBe(event);
  });

  test("an unreadable instant leaves the event alone", () => {
    const event = timed("a", "whenever", at("10:00"));
    expect(moveTimed(event, DAY, 540, PHOENIX)).toBe(event);
  });

  test("a move over the spring forward keeps the elapsed time, not the wall clock", () => {
    // 2026-03-08 is when New York loses an hour at 02:00.
    const event = nyEvent("2026-03-07", 90, 150);
    expect(elapsed(event)).toBe(HOUR_MS);
    const moved = moveTimed(event, "2026-03-08", 90, NY);
    expect(elapsed(moved)).toBe(HOUR_MS);
    expect(zonedClockMinutes(Date.parse(moved.start), NY)).toBe(90);
    // An hour after 01:30 that morning is 03:30, because 02:30 does not exist.
    expect(zonedClockMinutes(Date.parse(moved.end), NY)).toBe(210);
  });

  test("a move into summer time keeps the wall clock it was dropped at", () => {
    const event = nyEvent("2026-03-06", 9 * 60, 11 * 60);
    const moved = moveTimed(event, "2026-03-09", 9 * 60, NY);
    expect(elapsed(moved)).toBe(2 * HOUR_MS);
    expect(zonedClockMinutes(Date.parse(moved.start), NY)).toBe(9 * 60);
    expect(zonedClockMinutes(Date.parse(moved.end), NY)).toBe(11 * 60);
    expect(zonedDateKey(Date.parse(moved.start), NY)).toBe("2026-03-09");
  });

  test("a move over the fall back keeps the elapsed time", () => {
    // 2026-11-01 is when New York repeats an hour at 02:00, so the wall clock
    // an hour later is one of two answers and only the length is asserted.
    const event = nyEvent("2026-10-31", 90, 150);
    const moved = moveTimed(event, "2026-11-01", 90, NY);
    expect(elapsed(moved)).toBe(HOUR_MS);
    expect(zonedDateKey(Date.parse(moved.start), NY)).toBe("2026-11-01");
  });

  test("a drop on its own position is no move at all", () => {
    const event = timed("a", at("09:00"), at("10:00"));
    expect(moveTimed(event, DAY, 9 * 60, PHOENIX)).toBe(event);
    expect(moveTimed(event, DAY, 9 * 60 + 1, PHOENIX)).not.toBe(event);
  });

  test("a drop on its own position in the repeated hour does not move it", () => {
    // On 2026-11-01 the second 01:30 in New York is drawn at minute 90, like
    // the first. Resolving minute 90 again would quietly move it an hour back.
    const start = minutesToMs("2026-11-01", 90, NY) + HOUR_MS;
    expect(zonedClockMinutes(start, NY)).toBe(90);
    const event = timed("a", zonedIso(start, NY), zonedIso(start + HOUR_MS, NY));
    expect(moveTimed(event, "2026-11-01", 90, NY)).toBe(event);
  });

  test("a drop at the very end of a day keeps the event on that day", () => {
    const event = timed("a", at("09:00"), at("09:30"));
    const moved = moveTimed(event, DAY, MINUTES_PER_DAY, PHOENIX);
    expect(moved.start).toBe(at("23:45"));
    expect(moved.end).toBe(at("00:15", "2026-04-16"));
  });

  test("a move within a day east of UTC round-trips", () => {
    const tokyo = "Asia/Tokyo";
    const event = timed("a", "2026-04-15T09:00:00+09:00", "2026-04-15T10:00:00+09:00");
    const moved = moveTimed(event, DAY, 13 * 60, tokyo);
    expect(moved.start).toBe("2026-04-15T13:00:00+09:00");
    expect(moved.end).toBe("2026-04-15T14:00:00+09:00");
  });
});

describe("resizeTimed", () => {
  const event = timed("a", at("09:00"), at("10:00"));

  test("the end follows the pointer", () => {
    expect(resizeTimed(event, "end", DAY, 11 * 60, PHOENIX).end).toBe(at("11:00"));
    expect(resizeTimed(event, "end", DAY, 9 * 60 + 30, PHOENIX).end).toBe(at("09:30"));
  });

  test("the start follows the pointer", () => {
    expect(resizeTimed(event, "start", DAY, 8 * 60, PHOENIX).start).toBe(at("08:00"));
    expect(resizeTimed(event, "start", DAY, 9 * 60 + 30, PHOENIX).start).toBe(at("09:30"));
  });

  test("the end never comes within fifteen minutes of the start", () => {
    const resized = resizeTimed(event, "end", DAY, 9 * 60, PHOENIX);
    expect(resized.end).toBe(at("09:15"));
    expect(resized.start).toBe(at("09:00"));
  });

  test("dragging the end above the start stops fifteen minutes below it", () => {
    expect(resizeTimed(event, "end", DAY, 7 * 60, PHOENIX).end).toBe(at("09:15"));
    expect(resizeTimed(event, "end", "2026-04-14", 12 * 60, PHOENIX).end).toBe(at("09:15"));
  });

  test("the start never comes within fifteen minutes of the end", () => {
    expect(resizeTimed(event, "start", DAY, 10 * 60, PHOENIX).start).toBe(at("09:45"));
  });

  test("dragging the start past the end stops fifteen minutes before it", () => {
    expect(resizeTimed(event, "start", DAY, 23 * 60, PHOENIX).start).toBe(at("09:45"));
    expect(resizeTimed(event, "start", "2026-04-16", 12 * 60, PHOENIX).start).toBe(at("09:45"));
  });

  test("the fifteen minute floor is the one in the contract", () => {
    const resized = resizeTimed(event, "end", DAY, 9 * 60, PHOENIX);
    expect(elapsed(resized)).toBe(MIN_EVENT_MINUTES * 60_000);
  });

  test("it can grow across a day boundary", () => {
    const resized = resizeTimed(event, "end", "2026-04-16", 60, PHOENIX);
    expect(resized.end).toBe(at("01:00", "2026-04-16"));
    expect(elapsed(resized)).toBe(16 * HOUR_MS);
  });

  test("it does not touch an all day event", () => {
    const span = allDay("a", "2026-04-15", "2026-04-16");
    expect(resizeTimed(span, "end", DAY, 600, PHOENIX)).toBe(span);
  });

  test("an unreadable instant leaves the event alone", () => {
    const broken = timed("a", at("09:00"), "whenever");
    expect(resizeTimed(broken, "end", DAY, 600, PHOENIX)).toBe(broken);
  });

  test("dragging an edge onto its own position does nothing", () => {
    expect(resizeTimed(event, "end", DAY, 10 * 60, PHOENIX)).toBe(event);
    expect(resizeTimed(event, "start", DAY, 9 * 60, PHOENIX)).toBe(event);
  });
});

describe("moveAllDay", () => {
  test("both ends shift by the same number of days", () => {
    const moved = moveAllDay(allDay("a", "2026-04-14", "2026-04-17"), 2);
    expect(moved.start).toBe("2026-04-16");
    expect(moved.end).toBe("2026-04-19");
  });

  test("it goes backwards and over a month edge", () => {
    const moved = moveAllDay(allDay("a", "2026-05-01", "2026-05-02"), -1);
    expect(moved.start).toBe("2026-04-30");
    expect(moved.end).toBe("2026-05-01");
  });

  test("no days is no change", () => {
    const span = allDay("a", "2026-04-14", "2026-04-17");
    expect(moveAllDay(span, 0)).toBe(span);
  });

  test("part of a day rounds to the nearest whole day", () => {
    // Before this, half a day shifted the span by a whole one (shiftDateKey
    // adds half a day of slack to dodge rounding) while minus half a day
    // returned a new object sitting at the same two dates.
    const span = allDay("a", "2026-04-14", "2026-04-17");
    expect(moveAllDay(span, 0.4)).toBe(span);
    expect(moveAllDay(span, -0.5)).toBe(span);
    expect(moveAllDay(span, 0.5).start).toBe("2026-04-15");
    expect(moveAllDay(span, 1.4).start).toBe("2026-04-15");
    expect(moveAllDay(span, -1.6).start).toBe("2026-04-12");
  });

  test("it does not touch a timed event", () => {
    const event = timed("a", at("09:00"), at("10:00"));
    expect(moveAllDay(event, 1)).toBe(event);
  });

  test("an unreadable date key leaves the event alone", () => {
    const broken = allDay("a", "whenever", "2026-04-17");
    expect(moveAllDay(broken, 1)).toBe(broken);
  });
});

describe("draftAt", () => {
  test("a downward drag becomes the event it drew", () => {
    const draft = draftAt(DAY, 9 * 60, 10 * 60, PHOENIX, "cal-a");
    expect(draft.start).toBe(at("09:00"));
    expect(draft.end).toBe(at("10:00"));
    expect(draft.allDay).toBe(false);
    expect(draft.calendarId).toBe("cal-a");
    expect(draft.editable).toBe(true);
    expect(draft.etag).toBe(null);
    expect(draft.recurring).toBe(false);
  });

  test("an upward drag is the same event", () => {
    const up = draftAt(DAY, 10 * 60, 9 * 60, PHOENIX, "cal-a");
    const down = draftAt(DAY, 9 * 60, 10 * 60, PHOENIX, "cal-a");
    expect(up.start).toBe(down.start);
    expect(up.end).toBe(down.end);
  });

  test("both ends are snapped", () => {
    const draft = draftAt(DAY, 9 * 60 + 7, 10 * 60 + 8, PHOENIX, "cal-a");
    expect(draft.start).toBe(at("09:00"));
    expect(draft.end).toBe(at("10:15"));
  });

  test("a tap is fifteen minutes", () => {
    const draft = draftAt(DAY, 9 * 60, 9 * 60, PHOENIX, "cal-a");
    expect(draft.start).toBe(at("09:00"));
    expect(draft.end).toBe(at("09:15"));
  });

  test("a drag smaller than the floor is grown to it", () => {
    const draft = draftAt(DAY, 9 * 60 + 2, 9 * 60 + 4, PHOENIX, "cal-a");
    expect(draft.start).toBe(at("09:00"));
    expect(draft.end).toBe(at("09:15"));
  });

  test("a drag at the end of the day stays on the day it was drawn on", () => {
    // It used to snap up to 1440 and appear at midnight the NEXT day, which is
    // not the day the user was looking at.
    for (const minute of [MINUTES_PER_DAY, 1439, 1435, 1430]) {
      const draft = draftAt(DAY, minute, minute, PHOENIX, "cal-a");
      expect(draft.start).toBe(at("23:45"));
      expect(draft.end).toBe(at("00:00", "2026-04-16"));
    }
  });

  test("its id says it is a draft and is the same for the same drag", () => {
    const draft = draftAt(DAY, 9 * 60, 10 * 60, PHOENIX, "cal-a");
    expect(draft.id.startsWith(DRAFT_ID_PREFIX)).toBe(true);
    expect(isDraftId(draft.id)).toBe(true);
    expect(isDraftId("cal-a:ev-1")).toBe(false);
    expect(draftAt(DAY, 9 * 60, 10 * 60, PHOENIX, "cal-a").id).toBe(draft.id);
    expect(draftAt(DAY, 11 * 60, 12 * 60, PHOENIX, "cal-a").id).not.toBe(draft.id);
  });

  test("two drafts in the same slot are different drafts", () => {
    const hour = draftAt(DAY, 9 * 60, 10 * 60, PHOENIX, "cal-a");
    expect(draftAt(DAY, 9 * 60, 11 * 60, PHOENIX, "cal-a").id).not.toBe(hour.id);
    expect(draftAt(DAY, 9 * 60, 10 * 60, PHOENIX, "cal-b").id).not.toBe(hour.id);
    expect(draftAt("2026-04-16", 9 * 60, 10 * 60, PHOENIX, "cal-a").id).not.toBe(hour.id);
  });

  test("the title is left for whoever types it", () => {
    expect(draftAt(DAY, 9 * 60, 10 * 60, PHOENIX, "cal-a").title).toBe("");
  });
});

describe("the hour that does not exist", () => {
  // New York loses 02:00 to 02:59 on 2026-03-08. Every case below drags inside
  // that hour, where a wall time has no instant at all. Only elapsed time and
  // wall minutes are asserted: no offset is written out.
  const GAP_DAY = "2026-03-08";

  test("a draft drawn inside the gap is at least the floor long", () => {
    for (const [from, to] of [
      [105, 135],
      [90, 150],
      [90, 120],
      [120, 150],
      [120, 180],
      [135, 105],
    ]) {
      const draft = draftAt(GAP_DAY, from, to, NY, "cal-a");
      expect(elapsed(draft)).toBeGreaterThanOrEqual(MIN_EVENT_MINUTES * 60_000);
    }
  });

  test("a drop inside the gap lands at or after the hour it was dropped in", () => {
    const event = nyEvent("2026-03-07", 9 * 60, 10 * 60);
    const moved = moveTimed(event, GAP_DAY, 150, NY);
    expect(elapsed(moved)).toBe(HOUR_MS);
    // 02:30 does not exist, so the drop resolves forward to 03:30.
    expect(zonedClockMinutes(Date.parse(moved.start), NY)).toBe(210);
  });

  test("an edge resized into the gap resolves forward too", () => {
    const event = nyEvent(GAP_DAY, 60, 240);
    const resized = resizeTimed(event, "end", GAP_DAY, 150, NY);
    expect(zonedClockMinutes(Date.parse(resized.end), NY)).toBe(210);
    expect(elapsed(resized)).toBeGreaterThanOrEqual(MIN_EVENT_MINUTES * 60_000);
  });
});
