// The invented day's own constants: which Wednesday it is, the zone and clock it
// runs on, the planner rules it is planned by, and what is already on it.
//
// A LEAF, AND THAT IS THE WHOLE POINT OF THE FILE. Two modules are built from
// these: the day itself (./sample-day.ts) and the week of calendar beside it
// (./sample-week.ts), which converts these very fixed events so the seminar sits
// at the same hour on both halves of the screen. The week used to read them from
// the day while the day read the week back, and that cycle was held up by a
// comment: one top-level const in the week that touched an imported binding
// would have crashed, depending on which of the two a caller loaded first.
// Nothing imports this file's siblings, so there is nothing left to cycle with.
//
// EVERYTHING HERE IS FICTIONAL. No title, place, name or time describes anybody.
// The zone is not the owner's, and the clock is a fixed invented instant rather
// than `now`, so the page renders identically every time and a screenshot taken
// tomorrow matches one taken today.

import { parseRules } from "@/app/lib/v2/rules";
import type { FixedEvent, PlannerRules } from "@/app/lib/v2/types";

/** A Wednesday, invented. The zone has no daylight saving, so offsets are stable. */
export const SAMPLE_DATE = "2026-04-15";
/** The sample's own zone, chosen for having no daylight saving. Not the owner's. */
export const SAMPLE_ZONE = "America/Phoenix";
const OFFSET = "-07:00";
/** Mid morning: the seminar is behind you and the day still has most of itself left. */
export const SAMPLE_NOW = `${SAMPLE_DATE}T10:20:00${OFFSET}`;

/** The campus calendar, which the travel rule and three of the events share. */
const CAMPUS = "campus-sample";

/** An invented instant on the sample day, or on any day of its week. */
export const sampleInstant = (clock: string, date: string = SAMPLE_DATE) =>
  `${date}T${clock}:00${OFFSET}`;

const at = sampleInstant;

export function sampleRules(): PlannerRules {
  return parseRules({
    timeZone: SAMPLE_ZONE,
    wakeByWeekday: ["07:30", "07:30", "07:30", "07:30", "07:30", "07:30", "07:30"],
    lightsOut: "23:30",
    noFocusBefore: "08:30",
    bufferMinutes: 10,
    capacity: {
      low: { blocks: 0, small: 1, gym: false, social: false },
      ok: { blocks: 3, small: 1, gym: false, social: false },
      good: { blocks: 4, small: 2, gym: true, social: true },
    },
    maxBlocksPerLanePerDay: 1,
    weeklyHourCap: 30,
    incomeTarget: { lane: "work", weeklyHours: 10, blockMinutes: 120 },
    travel: [
      {
        calendarId: CAMPUS,
        locationIncludes: null,
        minutesBefore: 25,
        minutesAfter: 10,
      },
    ],
    gym: { perWeek: 2, minutes: 45, notBefore: "16:00" },
    earlyTouch: { daysBefore: 3, minutes: 25 },
  });
}

export function sampleFixed(): FixedEvent[] {
  return [
    {
      id: "fx-notice",
      title: "Library closed for repairs",
      start: at("00:00"),
      end: at("00:00", "2026-04-16"),
      allDay: true,
      calendarId: CAMPUS,
      location: null,
      countsTowardCap: false,
      source: "google",
    },
    {
      id: "fx-seminar",
      title: "Morning seminar",
      start: at("09:00"),
      end: at("10:15"),
      allDay: false,
      calendarId: CAMPUS,
      location: "Hall B",
      countsTowardCap: false,
      source: "google",
    },
    {
      id: "fx-workshop",
      title: "Ceramics workshop",
      start: at("13:00"),
      end: at("15:00"),
      allDay: false,
      calendarId: CAMPUS,
      location: "Studio 4",
      countsTowardCap: false,
      source: "google",
    },
    {
      id: "fx-shift",
      title: "Print shop shift",
      start: at("18:30"),
      end: at("21:00"),
      allDay: false,
      calendarId: "shift-sample",
      location: "Front counter",
      countsTowardCap: true,
      source: "google",
    },
  ];
}
