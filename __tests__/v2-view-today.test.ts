// Task 8, the Today view model. buildTodayView is the whole screen as data: the
// component tree renders it and decides nothing. So every rule about what is
// lit, what is past and what is named is pinned here rather than by eye.
//
// The plans below are hand built. The fixture test drives the real planner.

import { describe, expect, test } from "vitest";

import { parseRules } from "@/app/lib/v2/rules";
import {
  SKIPPED_REASON,
  STOP_STATUS_COPY,
  TODAY_COPY,
  actionLine,
  buildTodayView,
  droppedTitles,
  splitTitle,
  type TodayInput,
} from "@/app/lib/v2/view/today";
// The tick's own reasons, imported so the view's copy for them cannot drift.
import { REASON as TICK_REASON } from "@/app/lib/v2/engine/tick";
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
    candidates: [],
    feeds: [],
    feedLabels: {},
    openAsks: [],
    tags: {},
    notice: null,
    energy: "ok",
    ...over,
  };
}

/** The two-level name shape, for a title that has no parenthetical. */
function titled(title: string) {
  return { title, detail: null, full: title };
}

function candidate(
  over: Partial<Candidate> & { id: string; title: string },
): Candidate {
  return {
    lane: null,
    kind: "step",
    due: null,
    hard: false,
    minutes: 50,
    energyCost: null,
    expiresAt: null,
    pinned: false,
    earlyTouchDone: false,
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
    expect(view.stops[0].identity).toEqual({
      label: "Study",
      color: "#7C9BFF",
      source: "lane",
    });
    expect(view.stops[1].identity).toBeNull();
    expect(view.stops[2].identity).toBeNull();
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

// ------------------------------------------------------------ two level names

// Round 2, from the first render on real data: titles are long and keep their
// detail in a trailing parenthetical, which as one run of display type was five
// lines on a phone and fifteen wrapped lines in a 340px side column. The split
// is the user's own punctuation, never a truncation.
describe("splitTitle", () => {
  test("splits a title that ends in a parenthetical at the first bracket", () => {
    expect(
      splitTitle(
        "PHIL 101 Short paper 2 (posted on the course site 26 Oct; one passage; 600 words)",
      ),
    ).toEqual({
      title: "PHIL 101 Short paper 2",
      detail: "posted on the course site 26 Oct; one passage; 600 words",
      full: "PHIL 101 Short paper 2 (posted on the course site 26 Oct; one passage; 600 words)",
    });
  });

  // The OUTER pair is the one that was closed, so a nested bracket stays in the
  // detail rather than cutting it short.
  test("keeps a nested bracket inside the detail", () => {
    expect(splitTitle("Read chapter 4 (the long one (pages 90 to 140) first)")).toEqual({
      title: "Read chapter 4",
      detail: "the long one (pages 90 to 140) first",
      full: "Read chapter 4 (the long one (pages 90 to 140) first)",
    });
  });

  test.each([
    ["no bracket at all", "Glaze the test tiles"],
    ["a bracket that is not at the end", "Call (urgent) the studio back"],
    ["a bracket with no space before it", "Invoice(final)"],
    ["nothing before the bracket", "(no idea what this is)"],
    ["nothing inside the bracket", "Send the form ()"],
  ])("leaves %s as one whole title", (_name, raw) => {
    expect(splitTitle(raw)).toEqual({ title: raw, detail: null, full: raw });
  });

  test("trims, so the two halves are never padded", () => {
    expect(splitTitle("  Send it back  ( by Friday )  ")).toEqual({
      title: "Send it back",
      detail: "by Friday",
      full: "Send it back  ( by Friday )",
    });
  });
});

describe("the two levels reach every list", () => {
  const raw = "Grant form (the last three answers, due Friday)";

  test("a stop carries both halves and the whole string", () => {
    const view = buildTodayView(
      input({
        plan: plan({
          blocks: [block({ id: "b", title: raw, start: at("10:35"), end: at("11:25") })],
        }),
      }),
    );
    expect(view.stops[0].title).toBe("Grant form");
    expect(view.stops[0].detail).toBe("the last three answers, due Friday");
    expect(view.stops[0].full).toBe(raw);
  });

  test("a fixed event does too", () => {
    const view = buildTodayView(
      input({ fixed: [event({ id: "fx", title: raw, start: at("13:00"), end: at("15:00") })] }),
    );
    expect(view.stops[0]).toMatchObject({ title: "Grant form", full: raw });
  });

  test("so does a drop, and an item past its date", () => {
    const view = buildTodayView(
      input({
        candidates: [
          candidate({ id: "t-drop", title: raw }),
          candidate({ id: "t-old", title: raw, due: at("09:00", "2026-04-08") }),
        ],
        plan: plan({ dropped: [{ candidateId: "t-drop", reason: "no-room" }] }),
      }),
    );
    expect(view.notToday[0]).toMatchObject({ title: "Grant form", full: raw });
    expect(view.pastDue[0]).toMatchObject({ title: "Grant form", full: raw });
  });

  // The status line names what was pressed, so it takes the short half: the
  // whole parenthetical read out after "marked done" is not a sentence.
  test("leaves the status line naming the short half", () => {
    expect(actionLine("done", "Grant form", null)).toBe(
      "Grant form marked done. Nothing left on the line.",
    );
  });
});

// --------------------------------------------------------- identity and notice

// Task 11. A task's own group is the name and the colour the user chose for
// THAT task; a lane is the planner's grouping. The group wins, and only the
// group is named on screen.
describe("a stop's identity", () => {
  const tags = {
    "t-essay": { label: "Coursework", color: "#4A0E3A" },
    "t-blank": { label: "   ", color: "#123456" },
  };

  test("is the task's own group when it has one, and says so", () => {
    const view = buildTodayView(
      input({
        tags,
        plan: plan({
          blocks: [
            block({
              id: "b-essay",
              taskId: "t-essay",
              lane: "study",
              start: at("10:35"),
              end: at("11:25"),
            }),
          ],
        }),
      }),
    );
    expect(view.stops[0].identity).toEqual({
      label: "Coursework",
      color: "#4A0E3A",
      source: "tag",
    });
  });

  test("falls back to the lane when the task has no group", () => {
    const view = buildTodayView(
      input({
        tags,
        plan: plan({
          blocks: [
            block({
              id: "b-other",
              taskId: "t-other",
              lane: "study",
              start: at("10:35"),
              end: at("11:25"),
            }),
          ],
        }),
      }),
    );
    expect(view.stops[0].identity).toEqual({
      label: "Study",
      color: "#7C9BFF",
      source: "lane",
    });
  });

  // A group with no name would print an empty line and tint a card with a
  // colour the user cannot name, which is worse than the lane.
  test("ignores a group with a blank name", () => {
    const view = buildTodayView(
      input({
        tags,
        plan: plan({
          blocks: [
            block({
              id: "b-blank",
              taskId: "t-blank",
              lane: "work",
              start: at("10:35"),
              end: at("11:25"),
            }),
          ],
        }),
      }),
    );
    expect(view.stops[0].identity?.source).toBe("lane");
  });

  test("is nothing at all for a fixed event, which belongs to a calendar", () => {
    const view = buildTodayView(
      input({
        tags,
        fixed: [event({ id: "fx", start: at("13:00"), end: at("15:00") })],
      }),
    );
    expect(view.stops[0].identity).toBeNull();
  });
});

describe("the notice", () => {
  test("passes through, whatever the source said", () => {
    expect(buildTodayView(input({ notice: "Sample day." })).notice).toBe("Sample day.");
    expect(buildTodayView(input()).notice).toBeNull();
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

  // F9. The tick stores its own reason on a stop it closed off, and the view
  // looked reasons up by planner token only, so a skipped stop said nothing but
  // "Not today" and the user could not tell a day that ended from a question
  // they ignored twice.
  describe("a stop the tick closed off", () => {
    const skipped = (reason: string) =>
      buildTodayView(
        input({
          plan: plan({
            blocks: [
              block({
                id: "b",
                state: "skipped",
                reason,
                start: at("10:35"),
                end: at("11:00"),
              }),
            ],
          }),
        }),
      ).stops[0];

    test.each(Object.values(TICK_REASON))("shows its own reason: %s", (reason) => {
      const stop = skipped(reason);
      expect(stop.state).toBe("skipped");
      expect(stop.reason.startsWith("25 minutes. ")).toBe(true);
      expect(stop.reason.length).toBeGreaterThan("25 minutes. ".length);
    });

    test("names every reason the tick can write", () => {
      // The view keeps its own copy of these strings so the screen does not
      // import the engine. This is what stops the two lists drifting.
      expect(Object.values(TICK_REASON).filter((reason) => !(reason in SKIPPED_REASON)))
        .toEqual([]);
      expect(
        Object.keys(SKIPPED_REASON).filter(
          (key) => !(Object.values(TICK_REASON) as string[]).includes(key),
        ),
      ).toEqual([]);
    });

    test("reads as words, with no machine token and no dash", () => {
      for (const reason of Object.values(SKIPPED_REASON)) {
        expect(reason).not.toMatch(/[a-z]-[a-z]/);
        expect(reason).not.toMatch(/[—–]/);
        // Sentence case: it is joined after "25 minutes. ".
        expect(reason[0]).toBe(reason[0].toUpperCase());
      }
    });

    test("an unknown reason on a skipped stop still stays silent", () => {
      expect(skipped("some-new-reason").reason).toBe("25 minutes");
    });

    test("a block that is still planned keeps the planner's own reason", () => {
      const view = buildTodayView(
        input({
          plan: plan({
            blocks: [
              block({ id: "b", reason: "lane-next", start: at("10:35"), end: at("11:00") }),
            ],
          }),
        }),
      );
      expect(view.stops[0].reason).toBe("25 minutes. Next step in this lane");
    });
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
    candidate({ id: "t-ledger", title: "Reconcile last week's ledger", lane: "work" }),
    candidate({ id: "t-letters", title: "Reply to the two open letters" }),
  ];

  test("names each dropped candidate and says why in plain words", () => {
    const view = buildTodayView(
      input({
        candidates,
        plan: plan({
          dropped: [
            { candidateId: "t-ledger", reason: "capacity" },
            { candidateId: "t-letters", reason: "no-room" },
          ],
        }),
      }),
    );
    expect(view.notToday).toEqual([
      { ...titled("Reconcile last week's ledger"), reason: "Past today's capacity" },
      { ...titled("Reply to the two open letters"), reason: "No room today" },
    ]);
  });

  test("spells out the three reasons the brief names", () => {
    const view = buildTodayView(
      input({
        candidates,
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
        candidates,
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

  // The ids are the planner's, not a task's, so the view names them whether or
  // not the candidates cover them.
  test("names them even when there are no candidates at all", () => {
    const view = buildTodayView(
      input({
        candidates: [],
        plan: plan({
          dropped: [
            { candidateId: "income", reason: "cap" },
            { candidateId: "gym", reason: "no-room" },
          ],
        }),
      }),
    );
    expect(view.notToday).toEqual([
      { ...titled("Work block"), reason: "Would go over your weekly hours" },
      { ...titled("Gym"), reason: "No room today" },
    ]);
  });

  test("gives every reason the planner writes plain words", () => {
    const view = buildTodayView(
      input({
        candidates: [...candidates, candidate({ id: "t-x", title: "Something" })],
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
        candidates,
        plan: plan({
          dropped: [
            { candidateId: "t-unknown", reason: "capacity" },
            { candidateId: "t-ledger", reason: "capacity" },
          ],
        }),
      }),
    );
    expect(view.notToday).toEqual([
      { ...titled("Another task"), reason: "Past today's capacity" },
      { ...titled("Reconcile last week's ledger"), reason: "Past today's capacity" },
    ]);
  });

  // `candidates` is a required argument on purpose: the titles used to come in
  // a map of their own, and a caller who forgot it got a list that was silently
  // short. The compiler is the guard, so this only has to prove that an unnamed
  // id still gets a row.
  test("never drops a row, whatever the candidates hold", () => {
    const view = buildTodayView(
      input({
        candidates: [],
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

// ------------------------------------------------------------- the lane lines

describe("the lane summary", () => {
  const candidates: Candidate[] = [
    candidate({ id: "t-a", title: "A", lane: "study", due: at("23:00", "2026-04-18") }),
    candidate({ id: "t-b", title: "B", lane: "study", due: at("23:00", "2026-04-16") }),
    candidate({ id: "t-c", title: "C", lane: "study", due: null }),
    candidate({ id: "t-d", title: "D", lane: "work" }),
    candidate({ id: "t-e", title: "E", lane: null }),
  ];

  test("counts what is waiting in each lane and names the nearest date", () => {
    const view = buildTodayView(input({ candidates }));
    expect(view.lanes).toEqual([
      { key: "study", label: "Study", color: "#7C9BFF", open: 3, due: "16 April" },
      { key: "work", label: "Work", color: "#2FD6A3", open: 1, due: null },
      { key: "", label: "No lane", color: null, open: 1, due: null },
    ]);
  });

  test("leaves out a lane with nothing waiting", () => {
    const view = buildTodayView(
      input({ candidates: [candidate({ id: "t", title: "T", lane: "work" })] }),
    );
    expect(view.lanes.map((lane) => lane.key)).toEqual(["work"]);
  });

  // In a real account half the open tasks belong to no lane. Before this row
  // they appeared nowhere on the screen: not on the line, not in the summary.
  test("counts what belongs to no lane at all, last, and only when there is any", () => {
    const loose = buildTodayView(
      input({ candidates: [candidate({ id: "t", title: "T" })] }),
    );
    expect(loose.lanes).toEqual([
      { key: "", label: "No lane", color: null, open: 1, due: null },
    ]);
    expect(buildTodayView(input({ candidates: [] })).lanes).toEqual([]);
    expect(
      buildTodayView(input({ candidates: [candidate({ id: "t", title: "T", lane: "study" })] }))
        .lanes.map((lane) => lane.label),
    ).toEqual(["Study"]);
  });

  // The line reads "next 16 April". A date already gone by is not next, and it
  // has a section of its own.
  test("does not report a date that has already gone by as the next one", () => {
    const view = buildTodayView(
      input({
        candidates: [
          candidate({ id: "t-old", title: "Old", lane: "study", due: at("09:00", "2026-04-02") }),
          candidate({ id: "t-new", title: "New", lane: "study", due: at("23:00", "2026-04-20") }),
        ],
      }),
    );
    expect(view.lanes[0]).toMatchObject({ open: 2, due: "20 April" });
  });

  test("reads the date in the user's zone, not the process clock's", () => {
    // 18:00 on the 16th in Phoenix (UTC-7) is already the 17th in UTC.
    const over = { candidates: [candidate({ id: "t", title: "T", lane: "study", due: at("18:00", "2026-04-16") })] };
    expect(buildTodayView(input(over)).lanes[0].due).toBe("16 April");
    expect(buildTodayView(input({ ...over, timeZone: "UTC" })).lanes[0].due).toBe("17 April");
  });
});

// --------------------------------------------------------------- past the date

// Task 11, folded in after the engine met the owner's real data: an account that
// has been running a while has open items from days or weeks ago. Some are dead
// and some are still alive, and nothing on this screen can tell which, so they
// go in one place instead of among fifty rows of what did not fit.
describe("past their date", () => {
  const overdue: Candidate[] = [
    candidate({ id: "t-old", title: "Oldest", lane: "study", due: at("17:00", "2026-04-02") }),
    candidate({ id: "t-mid", title: "Middle", lane: "work", due: at("09:00", "2026-04-09") }),
    candidate({ id: "t-new", title: "Newest", due: at("08:00", "2026-04-15") }),
  ];

  test("lists the most recently overdue first, with the date it was for", () => {
    const view = buildTodayView(input({ candidates: overdue }));
    expect(view.pastDue).toEqual([
      { id: "t-new", ...titled("Newest"), identity: null, date: "15 April" },
      {
        id: "t-mid",
        ...titled("Middle"),
        identity: { label: "Work", color: "#2FD6A3", source: "lane" },
        date: "9 April",
      },
      {
        id: "t-old",
        ...titled("Oldest"),
        identity: { label: "Study", color: "#7C9BFF", source: "lane" },
        date: "2 April",
      },
    ]);
  });

  test("resolves a group over a lane, exactly as a stop does", () => {
    const view = buildTodayView(
      input({
        candidates: [overdue[1]],
        tags: { "t-mid": { label: "Print shop", color: "#0B1026" } },
      }),
    );
    expect(view.pastDue[0].identity).toEqual({
      label: "Print shop",
      color: "#0B1026",
      source: "tag",
    });
  });

  test("leaves out an item due later today, which is not past anything", () => {
    const view = buildTodayView(
      input({
        candidates: [
          candidate({ id: "t-tonight", title: "Tonight", due: at("23:00") }),
          candidate({ id: "t-earlier", title: "Earlier", due: at("08:00") }),
          candidate({ id: "t-none", title: "No date", due: null }),
        ],
      }),
    );
    expect(view.pastDue.map((entry) => entry.id)).toEqual(["t-earlier"]);
  });

  // The section says these are not planned, so one that IS planned must not be
  // in it: it is on the line, where it can be pressed.
  test("leaves out an item the planner did place today", () => {
    const view = buildTodayView(
      input({
        candidates: overdue,
        plan: plan({
          blocks: [
            block({ id: "b", taskId: "t-mid", start: at("10:35"), end: at("11:25") }),
          ],
        }),
      }),
    );
    expect(view.pastDue.map((entry) => entry.id)).toEqual(["t-new", "t-old"]);
  });

  test("keeps them out of what did not fit, so nothing is listed twice", () => {
    const view = buildTodayView(
      input({
        candidates: [...overdue, candidate({ id: "t-live", title: "Live one" })],
        plan: plan({
          dropped: [
            { candidateId: "t-old", reason: "no-room" },
            { candidateId: "t-live", reason: "capacity" },
            { candidateId: "income", reason: "cap" },
          ],
        }),
      }),
    );
    expect(view.notToday.map((entry) => entry.title)).toEqual(["Live one", "Work block"]);
    expect(view.pastDue.map((entry) => entry.title)).toEqual(["Newest", "Middle", "Oldest"]);
  });

  test("ties break on the title in code point order, not the locale's", () => {
    const view = buildTodayView(
      input({
        candidates: [
          candidate({ id: "t-b", title: "beta", due: at("09:00", "2026-04-09") }),
          candidate({ id: "t-a", title: "Alpha", due: at("09:00", "2026-04-09") }),
        ],
      }),
    );
    expect(view.pastDue.map((entry) => entry.title)).toEqual(["Alpha", "beta"]);
  });

  test("says nothing when nothing is overdue", () => {
    expect(buildTodayView(input()).pastDue).toEqual([]);
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
    expect(actionLine("skipped", "Glaze the test tiles", "Work block")).toBe(
      "Glaze the test tiles moved off today. Next: Work block.",
    );
  });

  test("says the day is over when nothing is left", () => {
    expect(actionLine("done", "Grant form", null)).toBe(
      "Grant form marked done. Nothing left on the line.",
    );
  });

  // Starting something leaves it lit, so the caller's "next" IS the block that
  // was pressed. Saying it would read "Ethics essay started. Next: Ethics
  // essay." The tail is dropped whatever the caller passes, so the rule cannot
  // be got wrong at a call site.
  test("says nothing about next after a start, because nothing moved on", () => {
    expect(actionLine("started", "Ethics essay", "Ethics essay")).toBe(
      "Ethics essay started.",
    );
    expect(actionLine("started", "Ethics essay", "Ceramics workshop")).toBe(
      "Ethics essay started.",
    );
    expect(actionLine("started", "Ethics essay", null)).toBe("Ethics essay started.");
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
