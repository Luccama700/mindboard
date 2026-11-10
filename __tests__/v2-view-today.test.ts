// Task 8, the Today view model. buildTodayView is the whole screen as data: the
// component tree renders it and decides nothing. So every rule about what is
// lit, what is past and what is named is pinned here rather than by eye.
//
// The plans below are hand built. The fixture test drives the real planner.

import { describe, expect, test } from "vitest";

import { parseRules } from "@/app/lib/v2/rules";
import {
  STOP_STATUS_COPY,
  TODAY_COPY,
  actionLine,
  buildTodayView,
  droppedTitles,
  type TodayInput,
} from "@/app/lib/v2/view/today";
import type {
  Ask,
  Block,
  Candidate,
  FeedStatus,
  FixedEvent,
  PlanOutput,
} from "@/app/lib/v2/types";

const DATE = "2026-04-15";
const ZONE = "America/Phoenix";
const NOW = "2026-04-15T10:20:00-07:00";

const at = (clock: string, date = DATE) => `${date}T${clock}:00-07:00`;

const LANES: TodayInput["lanes"] = [
  { key: "study", label: "Study", color: "#7C9BFF" },
  { key: "work", label: "Work", color: "#2FD6A3" },
];

function block(over: Partial<Block> & { id: string; start: string; end: string }): Block {
  return {
    date: DATE,
    kind: "focus",
    lane: null,
    taskId: null,
    title: `Block ${over.id}`,
    state: "planned",
    reason: "lane-next",
    ...over,
  };
}

function event(
  over: Partial<FixedEvent> & { id: string; start: string; end: string },
): FixedEvent {
  return {
    title: `Event ${over.id}`,
    allDay: false,
    calendarId: null,
    location: null,
    countsTowardCap: false,
    source: "google",
    ...over,
  };
}

function plan(over: Partial<PlanOutput> = {}): PlanOutput {
  return {
    date: DATE,
    blocks: [],
    dropped: [],
    moved: [],
    removed: [],
    leaveBy: [],
    energyUsed: "ok",
    energyAssumed: false,
    mode: "normal",
    ...over,
  };
}

function input(over: Partial<TodayInput> = {}): TodayInput {
  return {
    date: DATE,
    now: NOW,
    timeZone: ZONE,
    plan: plan(),
    fixed: [],
    lanes: LANES,
    feeds: [],
    feedLabels: {},
    openAsks: [],
    energy: "ok",
    titles: {},
    ...over,
  };
}

function feed(over: Partial<FeedStatus> & { feed: string }): FeedStatus {
  return { state: "alive", lastGoodAt: at("10:05"), cause: null, ...over };
}

// ------------------------------------------------------------------- the line

describe("the stops", () => {
  test("are the timed fixed events and the blocks, in start order", () => {
    const view = buildTodayView(
      input({
        fixed: [
          event({ id: "fx-late", start: at("18:30"), end: at("21:00") }),
          event({ id: "fx-early", start: at("09:00"), end: at("10:15") }),
        ],
        plan: plan({
          blocks: [
            block({ id: "b-evening", start: at("21:10"), end: at("22:50") }),
            block({ id: "b-morning", start: at("10:35"), end: at("11:00") }),
          ],
        }),
      }),
    );

    expect(view.stops.map((stop) => stop.id)).toEqual([
      "fx-early",
      "b-morning",
      "fx-late",
      "b-evening",
    ]);
    expect(view.stops.map((stop) => stop.source)).toEqual([
      "fixed",
      "block",
      "fixed",
      "block",
    ]);
  });

  test("carry the clock of their own start and end", () => {
    const view = buildTodayView(
      input({ plan: plan({ blocks: [block({ id: "b", start: at("10:35"), end: at("11:00") })] }) }),
    );
    expect(view.stops[0].start).toBe("10:35");
    expect(view.stops[0].end).toBe("11:00");
  });

  test("put all day events in allDay and not on the line", () => {
    const view = buildTodayView(
      input({
        fixed: [
          event({ id: "fx-notice", start: at("00:00"), end: at("23:59"), allDay: true, title: "Library closed for repairs" }),
          event({ id: "fx-class", start: at("09:00"), end: at("10:15") }),
        ],
      }),
    );
    expect(view.allDay).toEqual(["Library closed for repairs"]);
    expect(view.stops.map((stop) => stop.id)).toEqual(["fx-class"]);
  });

  test("resolve the lane label and colour from the lanes data", () => {
    const view = buildTodayView(
      input({
        plan: plan({
          blocks: [
            block({ id: "b-study", lane: "study", start: at("10:35"), end: at("11:00") }),
            block({ id: "b-none", lane: null, start: at("11:10"), end: at("11:20") }),
            block({ id: "b-unknown", lane: "nope", start: at("11:30"), end: at("11:40") }),
          ],
        }),
      }),
    );
    expect(view.stops[0].lane).toEqual({ label: "Study", color: "#7C9BFF" });
    expect(view.stops[1].lane).toBeNull();
    expect(view.stops[2].lane).toBeNull();
  });

  // A skipped block's minutes go back to the planner, so the next plan can put
  // something on top of them. The leftover has to read as the thing that was
  // dropped, which means sitting above the live row rather than under it.
  test("put a settled stop above a live one that starts at the same minute", () => {
    const view = buildTodayView(
      input({
        plan: plan({
          blocks: [
            block({ id: "b-live", start: at("10:35"), end: at("11:25") }),
            block({ id: "b-gone", state: "skipped", start: at("10:35"), end: at("11:00") }),
            block({ id: "a-done", state: "done", start: at("10:35"), end: at("11:00") }),
          ],
        }),
      }),
    );
    expect(view.stops.map((stop) => stop.id)).toEqual(["a-done", "b-gone", "b-live"]);
    expect(view.litStopId).toBe("b-live");
  });

  test("tie-break two live stops by id, in code point order", () => {
    const view = buildTodayView(
      input({
        fixed: [event({ id: "a-fixed", start: at("10:35"), end: at("11:00") })],
        plan: plan({
          blocks: [block({ id: "b-block", start: at("10:35"), end: at("11:00") })],
        }),
      }),
    );
    expect(view.stops.map((stop) => stop.id)).toEqual(["a-fixed", "b-block"]);
  });

  test("keep the block kind, and call a fixed event fixed", () => {
    const view = buildTodayView(
      input({
        fixed: [event({ id: "fx", start: at("13:00"), end: at("15:00") })],
        plan: plan({ blocks: [block({ id: "b", kind: "session", start: at("21:10"), end: at("22:50") })] }),
      }),
    );
    expect(view.stops.map((stop) => stop.kind)).toEqual(["fixed", "session"]);
  });
});

// ---------------------------------------------------------------- the lit stop

describe("the lit stop", () => {
  test("is the one in progress at now", () => {
    const view = buildTodayView(
      input({
        plan: plan({
          blocks: [
            block({ id: "b-past", start: at("09:00"), end: at("09:50") }),
            block({ id: "b-running", start: at("10:00"), end: at("10:50") }),
            block({ id: "b-later", start: at("11:00"), end: at("11:50") }),
          ],
        }),
      }),
    );
    expect(view.litStopId).toBe("b-running");
    expect(view.stops.map((stop) => stop.state)).toEqual(["past", "now", "later"]);
  });

  test("is otherwise the next one that has not ended", () => {
    const view = buildTodayView(
      input({
        plan: plan({
          blocks: [
            block({ id: "b-past", start: at("09:00"), end: at("09:50") }),
            block({ id: "b-next", start: at("10:35"), end: at("11:00") }),
            block({ id: "b-later", start: at("11:10"), end: at("11:20") }),
          ],
        }),
      }),
    );
    expect(view.litStopId).toBe("b-next");
    expect(view.stops.map((stop) => stop.state)).toEqual(["past", "next", "later"]);
  });

  test("can be a fixed event", () => {
    const view = buildTodayView(
      input({ fixed: [event({ id: "fx", start: at("13:00"), end: at("15:00") })] }),
    );
    expect(view.litStopId).toBe("fx");
    expect(view.stops[0].state).toBe("next");
  });

  test("is never a done block, which keeps its own state", () => {
    const view = buildTodayView(
      input({
        plan: plan({
          blocks: [
            block({ id: "b-done", state: "done", start: at("10:35"), end: at("11:00") }),
            block({ id: "b-next", start: at("11:10"), end: at("11:20") }),
          ],
        }),
      }),
    );
    expect(view.litStopId).toBe("b-next");
    expect(view.stops.map((stop) => stop.state)).toEqual(["done", "next"]);
  });

  test("is never a skipped block, which keeps its own state", () => {
    const view = buildTodayView(
      input({
        plan: plan({
          blocks: [
            block({ id: "b-skipped", state: "skipped", start: at("10:35"), end: at("11:00") }),
            block({ id: "b-next", start: at("11:10"), end: at("11:20") }),
          ],
        }),
      }),
    );
    expect(view.litStopId).toBe("b-next");
    expect(view.stops.map((stop) => stop.state)).toEqual(["skipped", "next"]);
  });

  // The clock is fixed on the sample screen, so pressing Start cannot make time
  // pass. A started block is the one in hand whatever its times say, or the
  // screen would offer Start on a block that is already running.
  test("is a started block, which reads as now even before its start", () => {
    const view = buildTodayView(
      input({
        plan: plan({
          blocks: [
            block({ id: "b-started", state: "started", start: at("10:35"), end: at("11:00") }),
            block({ id: "b-later", start: at("11:10"), end: at("11:20") }),
          ],
        }),
      }),
    );
    expect(view.litStopId).toBe("b-started");
    expect(view.stops.map((stop) => stop.state)).toEqual(["now", "later"]);
  });

  test("is a started block even after its end, because nobody resolved it", () => {
    const view = buildTodayView(
      input({
        plan: plan({
          blocks: [
            block({ id: "b-started", state: "started", start: at("09:00"), end: at("09:50") }),
            block({ id: "b-next", start: at("10:35"), end: at("11:00") }),
          ],
        }),
      }),
    );
    expect(view.litStopId).toBe("b-started");
  });

  // The block's own state beats the clock: a block finished early is finished,
  // and a block finished for a slot that has not arrived yet is still finished.
  test("is never a done block whose time is still ahead", () => {
    const view = buildTodayView(
      input({
        plan: plan({
          blocks: [
            block({ id: "b-done-later", state: "done", start: at("15:20"), end: at("17:20") }),
            block({ id: "b-next", start: at("10:35"), end: at("11:00") }),
          ],
        }),
      }),
    );
    expect(view.litStopId).toBe("b-next");
    const byId = new Map(view.stops.map((stop) => [stop.id, stop.state]));
    expect(byId.get("b-done-later")).toBe("done");
    expect(byId.get("b-next")).toBe("next");
  });

  test("is nothing when every stop is settled, even ones still ahead", () => {
    const view = buildTodayView(
      input({
        plan: plan({
          blocks: [
            block({ id: "b-done", state: "done", start: at("15:20"), end: at("17:20") }),
            block({ id: "b-skipped", state: "skipped", start: at("21:10"), end: at("22:50") }),
          ],
        }),
      }),
    );
    expect(view.litStopId).toBeNull();
  });

  test("is nothing when the day is over", () => {
    const view = buildTodayView(
      input({
        fixed: [event({ id: "fx", start: at("09:00"), end: at("10:15") })],
        plan: plan({
          blocks: [
            block({ id: "b-done", state: "done", start: at("08:00"), end: at("08:50") }),
            block({ id: "b-past", start: at("09:00"), end: at("09:50") }),
          ],
        }),
      }),
    );
    expect(view.litStopId).toBeNull();
    expect(view.stops.map((stop) => stop.state)).toEqual(["done", "past", "past"]);
  });

  test("is nothing on an empty day", () => {
    expect(buildTodayView(input()).litStopId).toBeNull();
  });
});

// ------------------------------------------------------------------- leave by

describe("leave by", () => {
  test("reads as a sentence on the fixed event it belongs to", () => {
    const view = buildTodayView(
      input({
        fixed: [
          event({ id: "fx-a", start: at("13:00"), end: at("15:00") }),
          event({ id: "fx-b", start: at("18:30"), end: at("21:00") }),
        ],
        plan: plan({ leaveBy: [{ fixedId: "fx-a", at: at("12:35") }] }),
      }),
    );
    expect(view.stops[0].leaveBy).toBe("Leave by 12:35");
    expect(view.stops[1].leaveBy).toBeNull();
  });

  // It is advice about a journey. Once the thing has started the advice is
  // either taken or moot, and leaving it on screen reads as an instruction.
  test("goes away once the event has started", () => {
    const view = buildTodayView(
      input({
        fixed: [
          event({ id: "fx-running", start: at("10:00"), end: at("11:30") }),
          event({ id: "fx-over", start: at("09:00"), end: at("09:45") }),
          event({ id: "fx-ahead", start: at("13:00"), end: at("15:00") }),
        ],
        plan: plan({
          leaveBy: [
            { fixedId: "fx-running", at: at("09:35") },
            { fixedId: "fx-over", at: at("08:35") },
            { fixedId: "fx-ahead", at: at("12:35") },
          ],
        }),
      }),
    );
    const byId = new Map(view.stops.map((stop) => [stop.id, stop.leaveBy]));
    expect(byId.get("fx-over")).toBeNull();
    expect(byId.get("fx-running")).toBeNull();
    expect(byId.get("fx-ahead")).toBe("Leave by 12:35");
  });

  test("never lands on a block", () => {
    const view = buildTodayView(
      input({
        plan: plan({
          blocks: [block({ id: "b", start: at("10:35"), end: at("11:00") })],
          leaveBy: [{ fixedId: "b", at: at("10:10") }],
        }),
      }),
    );
    expect(view.stops[0].leaveBy).toBeNull();
  });
});

// --------------------------------------------------------------------- reasons

describe("the reason line", () => {
  test("says how long a block is and why it is there", () => {
    const view = buildTodayView(
      input({
        plan: plan({
          blocks: [
            block({ id: "b-session", kind: "session", reason: "closes-today", start: at("21:10"), end: at("22:50") }),
            block({ id: "b-touch", kind: "touch", reason: "early-touch", start: at("10:35"), end: at("11:00") }),
          ],
        }),
      }),
    );
    const byId = new Map(view.stops.map((stop) => [stop.id, stop.reason]));
    expect(byId.get("b-touch")).toBe("25 minutes. Open it and read it");
    expect(byId.get("b-session")).toBe("1 hour 40 minutes. Closes today");
  });

  test("gives every reason the planner writes plain words", () => {
    const reasons = [
      "closes-today",
      "hard-window",
      "early-touch",
      "income-target",
      "lane-next",
      "side-quest",
      "gym",
      "floor",
    ];
    const view = buildTodayView(
      input({
        plan: plan({
          blocks: reasons.map((reason, index) =>
            block({
              id: `b-${index}`,
              reason,
              start: at(`1${index}:00`.slice(-5)),
              end: at(`1${index}:25`.slice(-5)),
            }),
          ),
        }),
      }),
    );
    for (const stop of view.stops) {
      // A machine token would reach the screen as "early-touch", hyphen and all.
      expect(stop.reason).not.toMatch(/[a-z]-[a-z]/);
      expect(stop.reason.length).toBeGreaterThan(0);
    }
  });

  test("tells a touch block what it is for, whichever step asked for it", () => {
    const view = buildTodayView(
      input({
        plan: plan({
          blocks: [
            block({ id: "b-window", kind: "touch", reason: "hard-window", start: at("10:35"), end: at("11:00") }),
            block({ id: "b-early", kind: "touch", reason: "early-touch", start: at("11:10"), end: at("11:35") }),
          ],
        }),
      }),
    );
    expect(view.stops.map((stop) => stop.reason)).toEqual([
      "25 minutes. Open it and read it",
      "25 minutes. Open it and read it",
    ]);
  });

  test("leaves an unknown reason silent rather than printing the token", () => {
    const view = buildTodayView(
      input({
        plan: plan({
          blocks: [block({ id: "b", reason: "some-new-reason", start: at("10:35"), end: at("11:00") })],
        }),
      }),
    );
    expect(view.stops[0].reason).toBe("25 minutes");
  });

  test("tells a fixed event by where it is, and says when it is paid work", () => {
    const view = buildTodayView(
      input({
        fixed: [
          event({ id: "fx-a", start: at("13:00"), end: at("15:00"), location: "Studio 4" }),
          event({ id: "fx-b", start: at("18:30"), end: at("21:00"), location: "Front counter", countsTowardCap: true }),
          event({ id: "fx-c", start: at("21:30"), end: at("22:00") }),
        ],
      }),
    );
    expect(view.stops.map((stop) => stop.reason)).toEqual([
      "Studio 4",
      "Front counter. Paid work",
      "",
    ]);
  });
});

// ---------------------------------------------------------------------- energy

describe("energy", () => {
  test("reads Low, OK or Good", () => {
    for (const [energy, label] of [
      ["low", "Low"],
      ["ok", "OK"],
      ["good", "Good"],
    ] as const) {
      const view = buildTodayView(
        input({ energy, plan: plan({ energyUsed: energy }) }),
      );
      expect(view.energy.label).toBe(label);
      expect(view.energy.assumed).toBe(false);
    }
  });

  test("says so when the plan assumed it", () => {
    const view = buildTodayView(
      input({ energy: null, plan: plan({ energyUsed: "ok", energyAssumed: true }) }),
    );
    expect(view.energy.label).toBe("OK, assumed");
    expect(view.energy.assumed).toBe(true);
  });

  test("passes an open energy ask through with its three options", () => {
    const ask: Ask = {
      id: "ask-1",
      userId: "sample",
      kind: "energy",
      topic: "energy",
      text: "Energy today?",
      options: [
        { id: "low", label: "Low", effect: { type: "energy.set", date: DATE, energy: "low" } },
        { id: "ok", label: "OK", effect: { type: "energy.set", date: DATE, energy: "ok" } },
        { id: "good", label: "Good", effect: { type: "energy.set", date: DATE, energy: "good" } },
      ],
      defaultOptionId: "ok",
      timeCritical: true,
      openedAt: at("08:00"),
      remindAt: null,
      remindedAt: null,
      expiresAt: at("12:00"),
      status: "open",
      answeredOptionId: null,
      answeredAt: null,
      assumed: false,
      dedupeKey: `energy:${DATE}`,
    };
    const view = buildTodayView(input({ openAsks: [ask] }));
    expect(view.energy.ask?.id).toBe("ask-1");
    expect(view.energy.ask?.options.map((option) => option.label)).toEqual([
      "Low",
      "OK",
      "Good",
    ]);
  });

  test("ignores an ask that is not an open energy ask", () => {
    const base: Ask = {
      id: "ask-slip",
      userId: "sample",
      kind: "slip",
      topic: "task:t-1",
      text: "Still doing it?",
      options: [{ id: "did", label: "Did it", effect: { type: "none" } }],
      defaultOptionId: "did",
      timeCritical: true,
      openedAt: at("08:00"),
      remindAt: null,
      remindedAt: null,
      expiresAt: at("12:00"),
      status: "open",
      answeredOptionId: null,
      answeredAt: null,
      assumed: false,
      dedupeKey: "slip:1",
    };
    expect(buildTodayView(input({ openAsks: [base] })).energy.ask).toBeNull();
    expect(
      buildTodayView(
        input({ openAsks: [{ ...base, kind: "energy", status: "answered" }] }),
      ).energy.ask,
    ).toBeNull();
  });
});

// ------------------------------------------------------------------- not today

describe("not today", () => {
  const candidates: Candidate[] = [
    { id: "t-ledger", title: "Reconcile last week's ledger", lane: "work", kind: "step", due: null, hard: false, minutes: 50, energyCost: null, expiresAt: null, pinned: false, earlyTouchDone: false },
    { id: "t-letters", title: "Reply to the two open letters", lane: null, kind: "step", due: null, hard: false, minutes: 50, energyCost: null, expiresAt: null, pinned: false, earlyTouchDone: false },
  ];
  const titles = droppedTitles(candidates);

  test("names each dropped candidate and says why in plain words", () => {
    const view = buildTodayView(
      input({
        titles,
        plan: plan({
          dropped: [
            { candidateId: "t-ledger", reason: "capacity" },
            { candidateId: "t-letters", reason: "no-room" },
          ],
        }),
      }),
    );
    expect(view.notToday).toEqual([
      { title: "Reconcile last week's ledger", reason: "Past today's capacity" },
      { title: "Reply to the two open letters", reason: "No room today" },
    ]);
  });

  test("spells out the three reasons the brief names", () => {
    const view = buildTodayView(
      input({
        titles,
        plan: plan({
          dropped: [
            { candidateId: "t-ledger", reason: "no-room" },
            { candidateId: "t-letters", reason: "capacity" },
            { candidateId: "income", reason: "cap" },
          ],
        }),
      }),
    );
    expect(view.notToday.map((entry) => entry.reason)).toEqual([
      "No room today",
      "Past today's capacity",
      "Would go over your weekly hours",
    ]);
  });

  test("names the income and gym blocks the planner owns itself", () => {
    const view = buildTodayView(
      input({
        titles,
        plan: plan({
          dropped: [
            { candidateId: "income", reason: "cap" },
            { candidateId: "gym", reason: "no-room" },
          ],
        }),
      }),
    );
    expect(view.notToday.map((entry) => entry.title)).toEqual(["Work block", "Gym"]);
  });

  // The ids are the planner's, not a caller's, so the view names them whether or
  // not the caller's map covers them.
  test("names them even when the titles map is empty", () => {
    const view = buildTodayView(
      input({
        titles: {},
        plan: plan({
          dropped: [
            { candidateId: "income", reason: "cap" },
            { candidateId: "gym", reason: "no-room" },
          ],
        }),
      }),
    );
    expect(view.notToday).toEqual([
      { title: "Work block", reason: "Would go over your weekly hours" },
      { title: "Gym", reason: "No room today" },
    ]);
  });

  test("gives every reason the planner writes plain words", () => {
    const view = buildTodayView(
      input({
        titles: { ...titles, "t-x": "Something" },
        plan: plan({
          dropped: ["no-room", "capacity", "cap", "lane-limit", "mode"].map((reason) => ({
            candidateId: "t-x",
            reason,
          })),
        }),
      }),
    );
    for (const entry of view.notToday) {
      expect(entry.reason).not.toMatch(/[a-z]-[a-z]/);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  // A raw task id is not copy, but a drop that disappears is worse: the user can
  // act on "something did not fit, and here is why" without knowing which thing.
  test("shows a drop it cannot name under a generic name", () => {
    const view = buildTodayView(
      input({
        titles,
        plan: plan({
          dropped: [
            { candidateId: "t-unknown", reason: "capacity" },
            { candidateId: "t-ledger", reason: "capacity" },
          ],
        }),
      }),
    );
    expect(view.notToday).toEqual([
      { title: "Another task", reason: "Past today's capacity" },
      { title: "Reconcile last week's ledger", reason: "Past today's capacity" },
    ]);
  });

  // `titles` is a required argument on purpose: an omitted map used to make this
  // list silently short. The compiler is the guard, so this only has to prove
  // that an empty map still lists everything.
  test("never drops a row, whatever the titles map holds", () => {
    const view = buildTodayView(
      input({
        titles: {},
        plan: plan({
          dropped: [
            { candidateId: "a", reason: "capacity" },
            { candidateId: "b", reason: "no-room" },
            { candidateId: "c", reason: "cap" },
          ],
        }),
      }),
    );
    expect(view.notToday).toHaveLength(3);
  });
});

// One block, one name. The planner titles its own income block "Income work"
// and reports a dropped one under the token `income`, so without this the same
// thing would be called two different things on one screen.
describe("the work block", () => {
  test("is called the same whether it lands or is dropped", () => {
    const landed = buildTodayView(
      input({
        plan: plan({
          blocks: [
            block({
              id: "b-income",
              kind: "income",
              title: "Income work",
              reason: "income-target",
              start: at("15:20"),
              end: at("17:20"),
            }),
          ],
        }),
      }),
    );
    const dropped = buildTodayView(
      input({ plan: plan({ dropped: [{ candidateId: "income", reason: "cap" }] }) }),
    );
    expect(landed.stops[0].title).toBe("Work block");
    expect(dropped.notToday[0].title).toBe("Work block");
  });

  test("leaves every other block's title alone", () => {
    const view = buildTodayView(
      input({
        plan: plan({
          blocks: [block({ id: "b", title: "Glaze the test tiles", start: at("11:10"), end: at("12:00") })],
        }),
      }),
    );
    expect(view.stops[0].title).toBe("Glaze the test tiles");
  });
});

describe("the status line", () => {
  test("says what the press did and what is next", () => {
    expect(actionLine("done", "Ethics essay", "Stretch for ten minutes")).toBe(
      "Ethics essay marked done. Next: Stretch for ten minutes.",
    );
    expect(actionLine("started", "Ethics essay", "Ceramics workshop")).toBe(
      "Ethics essay started. Next: Ceramics workshop.",
    );
    expect(actionLine("skipped", "Glaze the test tiles", "Work block")).toBe(
      "Glaze the test tiles moved off today. Next: Work block.",
    );
  });

  test("says the day is over when nothing is left", () => {
    expect(actionLine("done", "Grant form", null)).toBe(
      "Grant form marked done. Nothing left on the line.",
    );
  });
});

describe("droppedTitles", () => {
  test("maps every candidate id to its title", () => {
    const titles = droppedTitles([
      { id: "t-1", title: "First", lane: null, kind: "step", due: null, hard: false, minutes: null, energyCost: null, expiresAt: null, pinned: false, earlyTouchDone: false },
    ]);
    expect(titles["t-1"]).toBe("First");
  });

  test("covers the two ids the planner drops under its own name", () => {
    const titles = droppedTitles([]);
    expect(titles.income).toBe("Work block");
    expect(titles.gym).toBe("Gym");
  });

  test("lets a candidate win over a planner token of the same id", () => {
    const titles = droppedTitles([
      { id: "income", title: "My own income task", lane: null, kind: "step", due: null, hard: false, minutes: null, energyCost: null, expiresAt: null, pinned: false, earlyTouchDone: false },
    ]);
    expect(titles.income).toBe("My own income task");
  });
});

// ----------------------------------------------------------------------- feeds

describe("the feed strip", () => {
  test("says all is well when every feed is alive", () => {
    const view = buildTodayView(
      input({
        feeds: [feed({ feed: "fd-calendar" }), feed({ feed: "fd-mail" })],
        feedLabels: { "fd-calendar": "Calendar", "fd-mail": "Mail" },
      }),
    );
    expect(view.feed.line).toBe("All feeds alive.");
  });

  test("names the worst feed and when it was last seen", () => {
    const view = buildTodayView(
      input({
        feeds: [
          feed({ feed: "fd-calendar" }),
          feed({ feed: "fd-bank", state: "failing", lastGoodAt: "2026-04-11T08:05:00-07:00", cause: "auth-expired" }),
        ],
        feedLabels: { "fd-calendar": "Calendar", "fd-bank": "Bank balance" },
      }),
    );
    expect(view.feed.line).toBe("I can't see Bank balance since 11 April.");
  });

  test("still reads as a sentence for a feed that never ran", () => {
    const view = buildTodayView(
      input({
        feeds: [feed({ feed: "fd-bank", state: "blind", lastGoodAt: null })],
        feedLabels: { "fd-bank": "Bank balance" },
      }),
    );
    expect(view.feed.line).toBe("I can't see Bank balance since the start.");
  });

  test("gives one dot per feed, labelled and in the order it was given", () => {
    const view = buildTodayView(
      input({
        feeds: [
          feed({ feed: "fd-calendar" }),
          feed({ feed: "fd-bank", state: "failing" }),
          feed({ feed: "fd-other" }),
        ],
        feedLabels: { "fd-calendar": "Calendar", "fd-bank": "Bank balance" },
      }),
    );
    expect(view.feed.dots).toEqual([
      { label: "Calendar", state: "alive" },
      { label: "Bank balance", state: "failing" },
      { label: "fd-other", state: "alive" },
    ]);
  });
});

// ----------------------------------------------------------------- the day label

describe("the day label", () => {
  test("is the date key read as a weekday and a month", () => {
    expect(buildTodayView(input()).dateLabel).toBe("Wednesday 15 April");
  });
});

// ------------------------------------------------------------------ empty day

describe("an empty day", () => {
  test("is empty with no stops and no all day events", () => {
    const view = buildTodayView(input());
    expect(view.empty).toBe(true);
    expect(TODAY_COPY.empty).toBe("Nothing planned. Add a task and it lands here.");
  });

  test("is not empty when only an all day event is there", () => {
    const view = buildTodayView(
      input({
        fixed: [event({ id: "fx", start: at("00:00"), end: at("23:59"), allDay: true })],
      }),
    );
    expect(view.empty).toBe(false);
  });

  test("is not empty when only a skipped block is there", () => {
    const view = buildTodayView(
      input({
        plan: plan({
          blocks: [block({ id: "b", state: "skipped", start: at("10:35"), end: at("11:00") })],
        }),
      }),
    );
    expect(view.empty).toBe(false);
  });
});

// ------------------------------------------------------------------ the rules

describe("the view model is honest about the time zone", () => {
  test("reads every clock in the zone it was given, not in the process zone", () => {
    const tokyo = buildTodayView(
      input({
        timeZone: "Asia/Tokyo",
        plan: plan({ blocks: [block({ id: "b", start: at("10:35"), end: at("11:00") })] }),
      }),
    );
    expect(tokyo.stops[0].start).toBe("02:35");
  });

  test("works against rules parsed from a stored row", () => {
    // parseRules is the only door a zone comes through; the view takes the
    // string, so this is here to prove the two agree.
    const rules = parseRules({ timeZone: ZONE });
    const view = buildTodayView(
      input({
        timeZone: rules.timeZone,
        plan: plan({ blocks: [block({ id: "b", start: at("10:35"), end: at("11:00") })] }),
      }),
    );
    expect(view.stops[0].start).toBe("10:35");
  });
});

describe("the status words", () => {
  test("cover every state a stop can be in", () => {
    const states: Array<keyof typeof STOP_STATUS_COPY> = [
      "done",
      "skipped",
      "past",
      "now",
      "next",
      "later",
    ];
    for (const state of states) {
      expect(typeof STOP_STATUS_COPY[state]).toBe("string");
    }
    expect(STOP_STATUS_COPY.skipped).toBe("Not today");
    expect(STOP_STATUS_COPY.done).toBe("Done");
  });
});
