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
import {
  SAMPLE_DATE,
  SAMPLE_NOW,
  sampleFixed,
  sampleInstant,
  sampleRules,
} from "@/app/lib/v2/fixtures/sample-base";
import { sampleWeek } from "@/app/lib/v2/fixtures/sample-week";
import type { ScreenLane, TodayScreenData } from "@/app/lib/v2/view/screen-data";
import type { Candidate, FeedStatus, PlanInput } from "@/app/lib/v2/types";

const SAMPLE_USER = "sample-day";

// The day it is, the clock it runs on, its rules and what is already on it all
// live in ./sample-base.ts, which the week of calendar beside this day is built
// from as well: one set of invented constants, so the two halves of the screen
// cannot disagree about which Wednesday this is.
const DATE = SAMPLE_DATE;
const NOW = SAMPLE_NOW;
const at = sampleInstant;

/**
 * The six lanes. Lane names and colours are DATA, never engine code, so they
 * live here with the rest of the sample. The colours are the six lane colours
 * from the approved prototype's tokens, and they stay exactly these: the screen
 * derives a readable variant per scheme rather than changing the data.
 */
const LANES: ScreenLane[] = [
  { key: "study", label: "Study", color: "#7C9BFF" },
  { key: "work", label: "Work", color: "#2FD6A3" },
  { key: "money", label: "Money", color: "#FFB84D" },
  { key: "people", label: "People", color: "#FF7A8A" },
  { key: "craft", label: "Craft", color: "#C58BFF" },
  { key: "body", label: "Body", color: "#B8F15A" },
];

function candidates(): Candidate[] {
  return [
    {
      id: "t-grant",
      title: "Grant form (the last three answers, and the budget page signed)",
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
    // An item whose date went by last week, so the screen's "Past their date"
    // section has something in it. Its lane already holds the grant form, which
    // is this day's one money block, so the planner has nowhere to put it: it
    // reads as what it is, something waiting for a decision rather than for a
    // slot. Invented, like everything else here.
    {
      id: "t-studio",
      title: "Studio deposit: send the form back",
      lane: "money",
      kind: "step",
      due: at("17:00", "2026-04-09"),
      hard: false,
      minutes: 25,
      energyCost: 2,
      expiresAt: null,
      pinned: false,
      earlyTouchDone: false,
    },
    {
      id: "t-essay",
      title: "Field notes writeup (second draft, one more pass on the middle section)",
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

/**
 * What this day is, in one sentence, shown once near the top of the screen.
 *
 * It replaces the old fixed footer line. The screen no longer knows it is
 * looking at a sample: every source says what it is, so a real account is never
 * told its own day is invented. The Week page shows the same sentence, from here.
 */
export const SAMPLE_NOTICE =
  "Sample day. Nothing here is connected and nothing you press is saved.";

/**
 * The sample day, as the one shape the Today screen takes from any source. A
 * fresh object every call, so nothing can be mutated into it.
 *
 * `tags` is empty: the sample has lanes and no groups, which is exactly the case
 * the screen has to handle by keeping the lane's name and colour.
 */
export function sampleDay(): TodayScreenData {
  const planner = sampleRules();
  const input: PlanInput = {
    date: DATE,
    now: NOW,
    rules: planner,
    // Nobody has answered yet, so the planner uses "ok" and says it assumed it.
    energy: null,
    mode: "normal",
    fixed: sampleFixed(),
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
    lanes: LANES.map((lane) => ({ ...lane })),
    feeds: feeds(),
    feedLabels: { ...FEED_LABELS },
    openAsks: [ask],
    tags: {},
    notice: SAMPLE_NOTICE,
    // The week beside the day, built from the same fixed events and the same
    // rules (./sample-week.ts), so the two halves of the screen agree.
    calendar: sampleWeek(null),
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
