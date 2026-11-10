// One invented day, as a real PlanInput.
//
// This is what the Today screen runs on until Task 7 wires live data in. It is
// NOT a hand-written plan: the screen calls planDay(sampleDay().input), so what
// a reviewer looks at is the real planner's output, and pressing Start, Done or
// Not today re-runs the real planner in the browser.
//
// EVERYTHING HERE IS FICTIONAL. No title, place, name, amount or time describes
// anybody. The zone is not the owner's, and the clock is a fixed invented
// instant rather than `now`, so the page renders identically every time and a
// screenshot taken tomorrow matches one taken today.
//
// The day is shaped to exercise the screen: something already behind you, a
// block to press, an all day notice, a fixed event with travel time, a deadline
// session jammed against its closing time, and more work than the day can take
// so "Not today" has something in it. Low, OK and Good give visibly different
// days (low drops the income block, good adds a lane step and the gym).

import { energyAsk } from "@/app/lib/v2/asks/builders";
import { openAsk } from "@/app/lib/v2/asks/lifecycle";
import { parseRules } from "@/app/lib/v2/rules";
import type {
  Ask,
  Candidate,
  FeedStatus,
  FixedEvent,
  LaneKey,
  PlanInput,
  PlannerRules,
} from "@/app/lib/v2/types";

/** A Wednesday, invented. The zone has no daylight saving, so offsets are stable. */
const DATE = "2026-04-15";
const ZONE = "America/Phoenix";
const OFFSET = "-07:00";
/** Mid morning: the seminar is behind you and the day still has most of itself left. */
const NOW = `${DATE}T10:20:00${OFFSET}`;

const SAMPLE_USER = "sample-day";
const CAMPUS = "campus-sample";

const at = (clock: string, date: string = DATE) => `${date}T${clock}:00${OFFSET}`;

export interface SampleLane {
  key: LaneKey;
  label: string;
  color: string;
}

/**
 * The six lanes. Lane names and colours are DATA, never engine code, so they
 * live here with the rest of the sample. The colours are the six lane colours
 * from the approved prototype's tokens.
 */
const LANES: SampleLane[] = [
  { key: "study", label: "Study", color: "#7C9BFF" },
  { key: "work", label: "Work", color: "#2FD6A3" },
  { key: "money", label: "Money", color: "#FFB84D" },
  { key: "people", label: "People", color: "#FF7A8A" },
  { key: "craft", label: "Craft", color: "#C58BFF" },
  { key: "body", label: "Body", color: "#B8F15A" },
];

function rules(): PlannerRules {
  return parseRules({
    timeZone: ZONE,
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

function fixed(): FixedEvent[] {
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

function candidates(): Candidate[] {
  return [
    {
      id: "t-grant",
      title: "Grant form: the last three answers",
      lane: "money",
      kind: "step",
      due: at("23:00"),
      hard: true,
      minutes: 180,
      energyCost: 4,
      expiresAt: null,
      pinned: false,
      earlyTouchDone: false,
    },
    {
      id: "t-essay",
      title: "Ethics essay: second draft",
      lane: "study",
      kind: "step",
      due: at("23:59", "2026-04-16"),
      hard: true,
      minutes: 120,
      energyCost: 4,
      expiresAt: null,
      pinned: false,
      earlyTouchDone: false,
    },
    {
      id: "t-ledger",
      title: "Reconcile last week's ledger",
      lane: "money",
      kind: "step",
      due: at("23:59", "2026-04-18"),
      hard: false,
      minutes: 50,
      energyCost: 2,
      expiresAt: null,
      pinned: false,
      earlyTouchDone: false,
    },
    {
      id: "t-glaze",
      title: "Glaze the test tiles",
      lane: "craft",
      kind: "step",
      due: null,
      hard: false,
      minutes: 50,
      energyCost: 3,
      expiresAt: null,
      pinned: false,
      earlyTouchDone: false,
    },
    {
      id: "t-letters",
      title: "Reply to the two open letters",
      lane: "people",
      kind: "step",
      due: null,
      hard: false,
      minutes: 50,
      energyCost: 2,
      expiresAt: null,
      pinned: false,
      earlyTouchDone: false,
    },
    {
      id: "t-stretch",
      title: "Stretch for ten minutes",
      lane: "body",
      kind: "side",
      due: null,
      hard: false,
      minutes: 10,
      energyCost: 1,
      expiresAt: at("23:59", "2026-04-17"),
      pinned: false,
      earlyTouchDone: false,
    },
  ];
}

/** Five feeds answering and one that is not, so the strip says something real. */
function feeds(): FeedStatus[] {
  return [
    { feed: "fd-calendar", state: "alive", lastGoodAt: at("10:12"), cause: null },
    { feed: "fd-coursework", state: "alive", lastGoodAt: at("08:40"), cause: null },
    { feed: "fd-mail", state: "alive", lastGoodAt: at("10:05"), cause: null },
    {
      feed: "fd-bank",
      state: "failing",
      lastGoodAt: at("08:05", "2026-04-11"),
      cause: "auth-expired",
    },
    { feed: "fd-transit", state: "alive", lastGoodAt: at("10:18"), cause: null },
    { feed: "fd-weather", state: "alive", lastGoodAt: at("07:34"), cause: null },
  ];
}

const FEED_LABELS: Record<string, string> = {
  "fd-calendar": "Calendar",
  "fd-coursework": "Coursework",
  "fd-mail": "Mail",
  "fd-bank": "Bank balance",
  "fd-transit": "Transit times",
  "fd-weather": "Weather",
};

export interface SampleDay {
  input: PlanInput;
  lanes: SampleLane[];
  feeds: FeedStatus[];
  feedLabels: Record<string, string>;
  /**
   * Not in the task brief's return shape, added because the screen shows the
   * energy question's three options and the brief's TodayInput takes the asks.
   * Built with the real ask builder, so the options are the real ones.
   */
  openAsks: Ask[];
}

/** The sample day. A fresh object every call, so nothing can be mutated into. */
export function sampleDay(): SampleDay {
  const planner = rules();
  const input: PlanInput = {
    date: DATE,
    now: NOW,
    rules: planner,
    // Nobody has answered yet, so the planner uses "ok" and says it assumed it.
    energy: null,
    mode: "normal",
    fixed: fixed(),
    candidates: candidates(),
    week: { capHoursElsewhere: 16, incomeHoursElsewhere: 6, gymSessionsDone: 0 },
    existing: [],
  };

  const { ask } = openAsk(
    energyAsk(DATE, SAMPLE_USER, planner, at("08:05")),
    [],
    () => "ask-energy-sample",
  );

  return {
    input,
    lanes: LANES,
    feeds: feeds(),
    feedLabels: { ...FEED_LABELS },
    openAsks: [ask],
  };
}

/**
 * Whether the sample screen may render. Pure, so the gate itself is testable:
 * the flag has to be exactly "1", and production never opens whatever it says.
 */
export function fixturesEnabled(env: {
  V2_FIXTURES?: string;
  VERCEL_ENV?: string;
}): boolean {
  return env.V2_FIXTURES === "1" && env.VERCEL_ENV !== "production";
}
