// PLAN-DESK Task 3, the Quests view model. buildQuestsView is the four Quests
// panes as data, and its one promise is that it reads exactly what Today reads:
// the same planner input, ranked by the planner's own order, counted the way
// Today's lane lines count it. The first block below pins that promise on one
// input; everything after it pins a rule of its own.
//
// EVERYTHING HERE IS INVENTED: the sample day, the extra candidates, the groups
// and the history of finished things. The zone has no daylight saving.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { SAMPLE_DATE, sampleInstant, sampleRules } from "@/app/lib/v2/fixtures/sample-base";
import { sampleDay } from "@/app/lib/v2/fixtures/sample-day";
import { sampleQuests } from "@/app/lib/v2/fixtures/sample-quests";
import { dayDiff, planReference } from "@/app/lib/v2/plan/day";
import { planDay } from "@/app/lib/v2/plan/planner";
import { rankCandidates } from "@/app/lib/v2/plan/rank";
import type { Candidate, PlannerRules } from "@/app/lib/v2/types";
import type { QuestDone, QuestsScreenData } from "@/app/lib/v2/view/desk-data";
import {
  QUESTS_COPY,
  QUEST_SPANS,
  buildQuestsView,
  doneDayOf,
  questDoneTotalLabel,
  questPastLabel,
  questPerWeekLabel,
  type QuestsView,
} from "@/app/lib/v2/view/quests";
import type { TaskTag, TodayScreenData } from "@/app/lib/v2/view/screen-data";
import { TODAY_COPY, buildTodayView, identityFor, splitTitle } from "@/app/lib/v2/view/today";

const at = sampleInstant;
const NONE: ReadonlySet<string> = new Set<string>();

/** Today's view of a day, built exactly the way the Today screen builds it. */
function todayViewOf(data: TodayScreenData) {
  const { input } = data;
  return buildTodayView({
    date: input.date,
    now: input.now,
    reference: planReference(input.now, input.date, input.rules).instant,
    timeZone: input.rules.timeZone,
    plan: planDay(input),
    fixed: input.fixed,
    lanes: data.lanes,
    candidates: input.candidates,
    feeds: data.feeds,
    feedLabels: data.feedLabels,
    openAsks: data.openAsks,
    tags: data.tags,
    notice: data.notice,
    energy: input.energy,
  });
}

/** The quests of a day: its own input, lanes and tags, plus a history. */
function questsOf(day: TodayScreenData, over: Partial<QuestsScreenData> = {}): QuestsScreenData {
  return {
    input: day.input,
    lanes: day.lanes,
    tags: day.tags,
    done: [],
    historyDays: 28,
    ...over,
  };
}

function candidate(over: Partial<Candidate> & { id: string }): Candidate {
  return {
    title: `Invented ${over.id}`,
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

function finished(
  id: string,
  doneAt: string,
  over: Partial<Omit<QuestDone, "id" | "doneAt">> = {},
): QuestDone {
  return { id, title: `Finished ${id}`, lane: null, tag: null, doneAt, ...over };
}

/**
 * The sample day with more in it than the sample has: two things with no lane
 * (one past its date), one in the lane nothing else feeds, and a group on two of
 * them, so the "No lane" row and the tags are both under test.
 */
function busierDay(): TodayScreenData {
  const day = sampleDay();
  const extra: Candidate[] = [
    candidate({ id: "t-x-loose-late", title: "Return the folding chairs", due: at("12:00", "2026-04-11") }),
    candidate({ id: "t-x-loose", title: "Water the window boxes", kind: "side", expiresAt: at("20:00", "2026-04-17") }),
    candidate({ id: "t-x-work", title: "Count the till float (both drawers)", lane: "work", due: at("18:00", "2026-04-17") }),
  ];
  const tags: Record<string, TaskTag> = {
    "t-x-loose": { label: "Balcony", color: "#4A9B6E" },
    "t-glaze": { label: "Kiln club", color: "#9B6EC5" },
  };
  return {
    ...day,
    input: { ...day.input, candidates: [...day.input.candidates, ...extra] },
    tags,
  };
}

/** Every string anywhere in a value, so the copy rules can be walked. */
function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) strings(item, into);
  }
  return into;
}

const ids = (items: Array<{ id: string }>) => items.map((item) => item.id);

// --------------------------------------------------------------- behaviour 1

describe("the same input as Today", () => {
  for (const [name, build] of [
    ["the sample day", sampleDay],
    ["a busier day with loose items and groups", busierDay],
  ] as const) {
    describe(name, () => {
      const day = build();
      const today = todayViewOf(day);
      const quests = buildQuestsView(questsOf(day), NONE, 7);

      test("every lane's open count is Today's lane line count", () => {
        for (const lane of quests.lanes) {
          const line = today.lanes.find((entry) => entry.key === lane.key);
          expect(lane.open, lane.key).toBe(line?.open ?? 0);
        }
      });

      test("every lane's nearest date is Today's lane line date", () => {
        for (const lane of quests.lanes) {
          const line = today.lanes.find((entry) => entry.key === lane.key);
          expect(lane.due, lane.key).toBe(line?.due ?? null);
        }
      });

      test("the no lane count is the side quests", () => {
        const loose = today.lanes.find((entry) => entry.label === TODAY_COPY.noLane);
        expect(quests.side.length).toBe(loose?.open ?? 0);
      });

      test("every candidate appears exactly once across steps and side", () => {
        const seen = [...ids(quests.steps), ...ids(quests.side)].sort();
        expect(seen).toEqual(ids(day.input.candidates).sort());
      });

      test("the ranks are the planner's own order", () => {
        const reference = planReference(day.input.now, day.input.date, day.input.rules).instant;
        const order = rankCandidates(
          day.input.candidates,
          reference,
          day.input.rules,
          day.input.date,
        ).map((entry) => entry.candidate.id);
        const byRank = [...quests.steps, ...quests.side].sort((a, b) => a.rank - b.rank);
        expect(ids(byRank)).toEqual(order);
        expect(byRank.map((item) => item.rank)).toEqual(order.map((_, index) => index + 1));
      });
    });
  }

  test("the busier day really has a no lane row, so the test above is not vacuous", () => {
    const quests = buildQuestsView(questsOf(busierDay()), NONE, 7);
    expect(ids(quests.side)).toEqual(["t-x-loose", "t-x-loose-late"]);
  });

  test("a step with a side quest's kind still belongs to its lane, as Today counts it", () => {
    // The sample's stretch is kind "side" with lane "body": Today counts it under
    // Body, so it is a step here and never a side quest.
    const quests = buildQuestsView(questsOf(sampleDay()), NONE, 7);
    expect(ids(quests.side)).toEqual([]);
    expect(quests.lanes.find((lane) => lane.key === "body")?.next?.id).toBe("t-stretch");
  });

  // Before wake the planner reads every date against the start of the day's
  // window, not against the clock. An item due between the two is already past
  // its date for the planner and for Today; ranking it from the clock would put
  // it first while calling it past.
  describe("before wake, dates are read from the planner's reference, not the clock", () => {
    const base = sampleDay();
    const day: TodayScreenData = {
      ...base,
      input: {
        ...base.input,
        now: at("05:00"),
        candidates: [
          candidate({ id: "t-early", lane: "study", hard: true, due: at("07:00") }),
          candidate({ id: "t-undated", lane: "study" }),
          // 74 hours from the clock, 70.5 from the window's start at 08:30.
          candidate({ id: "t-edge", lane: "craft", hard: true, due: at("07:00", "2026-04-18") }),
        ],
      },
    };
    const quests = buildQuestsView(questsOf(day), NONE, 7);
    const item = (id: string) => quests.steps.find((entry) => entry.id === id);

    test("the item due before the reference ranks after the live one and reads past", () => {
      expect(item("t-undated")?.rank).toBeLessThan(item("t-early")?.rank ?? 0);
      expect(item("t-early")?.when).toBe("past");
      expect(quests.lanes.find((lane) => lane.key === "study")?.past).toBe(1);
    });

    test("the lane agrees with Today's line on the same input", () => {
      const line = todayViewOf(day).lanes.find((entry) => entry.key === "study");
      const lane = quests.lanes.find((entry) => entry.key === "study");
      expect(lane?.open).toBe(line?.open);
      expect(lane?.due).toBe(line?.due);
      expect(lane?.due).toBeNull();
    });

    test("soon is the planner's hard window, measured from the same instant", () => {
      const reference = planReference(day.input.now, day.input.date, day.input.rules).instant;
      const tier = rankCandidates(day.input.candidates, reference, day.input.rules, day.input.date)
        .find((entry) => entry.candidate.id === "t-edge")?.tier;
      expect(tier).toBe("hard-window");
      expect(item("t-edge")?.when).toBe("soon");
    });
  });
});

// --------------------------------------------------------------- behaviour 2

describe("a press on Today is seen here", () => {
  const day = sampleDay();
  const before = buildQuestsView(questsOf(day), NONE, 7);
  const after = buildQuestsView(questsOf(day), new Set(["t-glaze"]), 7);

  test("the finished step leaves the steps and its lane's count and next", () => {
    expect(ids(after.steps)).not.toContain("t-glaze");
    const craft = after.lanes.find((lane) => lane.key === "craft");
    expect(craft?.open).toBe(0);
    expect(craft?.next).toBeNull();
    expect(craft?.due).toBeNull();
    expect(craft?.quiet).toBe(false);
  });

  test("it joins the planned day in done", () => {
    expect(after.done.days[0]?.date).toBe(SAMPLE_DATE);
    expect(ids(after.done.days[0]?.items ?? [])).toContain("t-glaze");
    expect(after.done.total).toBe(before.done.total + 1);
    expect(after.lanes.find((lane) => lane.key === "craft")?.done).toBe(1);
  });

  test("nothing is replanned: every other step keeps its rank", () => {
    const rankOf = (view: QuestsView) =>
      Object.fromEntries([...view.steps, ...view.side].map((item) => [item.id, item.rank]));
    const was = rankOf(before);
    for (const [id, rank] of Object.entries(rankOf(after))) expect(rank, id).toBe(was[id]);
  });

  test("a side quest pressed done leaves the side list too", () => {
    const busy = busierDay();
    const view = buildQuestsView(questsOf(busy), new Set(["t-x-loose"]), 7);
    expect(ids(view.side)).toEqual(["t-x-loose-late"]);
    expect(ids(view.done.days[0]?.items ?? [])).toEqual(["t-x-loose"]);
  });

  test("an id that is not a candidate changes nothing", () => {
    expect(buildQuestsView(questsOf(day), new Set(["not-a-task"]), 7)).toEqual(before);
  });

  test("a step already in the history is counted once", () => {
    const data = questsOf(day, {
      done: [finished("t-glaze", at("08:00"), { lane: "craft", title: "Glaze the test tiles" })],
    });
    const view = buildQuestsView(data, new Set(["t-glaze"]), 7);
    expect(view.done.total).toBe(1);
  });
});

// --------------------------------------------------------------- behaviour 3

describe("lanes that nothing feeds stay quiet", () => {
  test("a lane with nothing open and nothing done says nothing", () => {
    const view = buildQuestsView(questsOf(sampleDay()), NONE, 7);
    const work = view.lanes.find((lane) => lane.key === "work");
    expect(work).toEqual({
      key: "work",
      label: "Work",
      color: "#2FD6A3",
      open: 0,
      next: null,
      due: null,
      past: 0,
      done: 0,
      quiet: true,
    });
  });

  test("every lane is there, in the user's order, quiet ones included", () => {
    const day = sampleDay();
    const view = buildQuestsView(questsOf(day), NONE, 7);
    expect(view.lanes.map((lane) => lane.key)).toEqual(day.lanes.map((lane) => lane.key));
  });

  test("with no history a quiet lane has no count at all, not a zero", () => {
    const view = buildQuestsView(questsOf(sampleDay(), { historyDays: 0 }), NONE, 7);
    const work = view.lanes.find((lane) => lane.key === "work");
    expect(work?.quiet).toBe(true);
    expect(work?.done).toBeNull();
  });

  test("a lane with only something finished is not quiet, even with no history", () => {
    const day = sampleDay();
    const view = buildQuestsView(
      questsOf(day, { historyDays: 0, done: [finished("d-shift", at("09:30"), { lane: "work" })] }),
      NONE,
      7,
    );
    const work = view.lanes.find((lane) => lane.key === "work");
    expect(work?.quiet).toBe(false);
    expect(work?.done).toBeNull();
    expect(work?.open).toBe(0);
  });
});

// --------------------------------------------------------------- behaviour 4

describe("a lane's next, date and past", () => {
  const view = buildQuestsView(questsOf(sampleDay()), NONE, 7);
  const money = view.lanes.find((lane) => lane.key === "money");

  test("next is the lane's first step by rank", () => {
    expect(money?.next?.id).toBe("t-grant");
    const first = view.steps.find((item) => item.lane === "money");
    expect(money?.next).toEqual(first);
  });

  test("due is the nearest date still ahead, worded as Today words it", () => {
    expect(money?.due).toBe("15 April");
    expect(view.lanes.find((lane) => lane.key === "study")?.due).toBe("16 April");
    expect(view.lanes.find((lane) => lane.key === "craft")?.due).toBeNull();
  });

  test("past counts the open steps whose date has gone by", () => {
    expect(money?.past).toBe(1);
    expect(money?.open).toBe(3);
  });
});

// --------------------------------------------------------------- behaviour 5

describe("where an item's date stands", () => {
  const view = buildQuestsView(questsOf(sampleDay()), NONE, 7);
  const item = (id: string) => view.steps.find((entry) => entry.id === id);

  test("past, today, soon, later and none", () => {
    expect(item("t-studio")?.when).toBe("past");
    expect(item("t-grant")?.when).toBe("today");
    // Thirty seven hours ahead, inside the 72 hour window.
    expect(item("t-essay")?.when).toBe("soon");
    // Eighty five hours ahead.
    expect(item("t-ledger")?.when).toBe("later");
    expect(item("t-glaze")?.when).toBe("none");
  });

  test("soon does not need a hard date", () => {
    const base = sampleDay();
    const day: TodayScreenData = {
      ...base,
      input: {
        ...base.input,
        candidates: [candidate({ id: "t-soft", lane: "craft", due: at("12:00", "2026-04-16") })],
      },
    };
    const soft = buildQuestsView(questsOf(day), NONE, 7).steps[0];
    expect(soft?.hard).toBe(false);
    expect(soft?.when).toBe("soon");
  });

  test("each item carries its date as a day and a month, and its hardness", () => {
    expect(item("t-studio")?.due).toBe("9 April");
    expect(item("t-grant")?.due).toBe("15 April");
    expect(item("t-grant")?.hard).toBe(true);
    expect(item("t-glaze")?.due).toBeNull();
    expect(item("t-ledger")?.hard).toBe(false);
  });

  test("a date that cannot be read is no date", () => {
    const base = sampleDay();
    const day: TodayScreenData = {
      ...base,
      input: { ...base.input, candidates: [candidate({ id: "t-odd", lane: "craft", due: "someday" })] },
    };
    const odd = buildQuestsView(questsOf(day), NONE, 7).steps[0];
    expect(odd?.due).toBeNull();
    expect(odd?.when).toBe("none");
  });
});

// --------------------------------------------------------------- behaviour 6

describe("done lately", () => {
  const day = sampleDay();
  const history: QuestDone[] = [
    finished("d-planned-day", at("09:00"), { lane: "study" }),
    finished("d-evening", at("20:00", "2026-04-14"), { lane: "money" }),
    // Two at the same instant, out of id order on purpose.
    finished("q-b", at("08:00", "2026-04-14"), { lane: "craft" }),
    finished("q-a", at("08:00", "2026-04-14")),
    finished("d-six-back", at("12:00", "2026-04-09")),
    finished("d-seven-back", at("23:00", "2026-04-08")),
    finished("d-twenty-seven-back", at("10:00", "2026-03-19")),
    finished("d-twenty-eight-back", at("10:00", "2026-03-18")),
    finished("d-after", at("09:00", "2026-04-16")),
    finished("d-unreadable", "not a time"),
  ];
  const data = questsOf(day, { done: history });

  test("the days of the span with something, newest first, items newest first", () => {
    const view = buildQuestsView(data, NONE, 7);
    expect(view.done.span).toBe(7);
    expect(view.done.days.map((entry) => entry.date)).toEqual([
      "2026-04-15",
      "2026-04-14",
      "2026-04-09",
    ]);
    expect(ids(view.done.days[1]?.items ?? [])).toEqual(["d-evening", "q-a", "q-b"]);
    expect(view.done.days[0]?.label).toBe("Wednesday 15 April");
  });

  test("the total, and the rate per week over exactly the span", () => {
    const seven = buildQuestsView(data, NONE, 7).done;
    expect(seven.total).toBe(5);
    expect(seven.known).toBe(true);
    expect(seven.perWeek).toBe(5);

    const fourteen = buildQuestsView(data, NONE, 14).done;
    expect(fourteen.total).toBe(6);
    expect(fourteen.perWeek).toBe(3);

    const twentyEight = buildQuestsView(data, NONE, 28).done;
    expect(twentyEight.total).toBe(7);
    // 7 in 4 weeks is 1.75, rounded to one decimal.
    expect(twentyEight.perWeek).toBe(1.8);
  });

  test("a lane's done is what it finished inside the span", () => {
    const view = buildQuestsView(data, NONE, 7);
    const doneOf = (key: string) => view.lanes.find((lane) => lane.key === key)?.done;
    expect(doneOf("study")).toBe(1);
    expect(doneOf("money")).toBe(1);
    expect(doneOf("craft")).toBe(1);
    expect(doneOf("people")).toBe(0);
  });

  test("a span the source cannot see has no rate and no lane counts", () => {
    const view = buildQuestsView(questsOf(day, { done: history, historyDays: 7 }), NONE, 14);
    expect(view.done.known).toBe(false);
    expect(view.done.perWeek).toBeNull();
    for (const lane of view.lanes) expect(lane.done, lane.key).toBeNull();
    // What it does hold is still listed: the rate is what would be invented.
    expect(view.done.total).toBe(6);
  });

  test("a source with no history at all knows no span", () => {
    for (const span of QUEST_SPANS) {
      const view = buildQuestsView(questsOf(day, { historyDays: 0 }), NONE, span);
      expect(view.done).toEqual({ span, days: [], total: 0, perWeek: null, known: false });
    }
  });

  test("a finish after midnight belongs to the day still being lived", () => {
    const late: PlannerRules = { ...sampleRules(), lightsOut: "01:30" };
    const row = finished("d-small-hours", at("00:20", "2026-04-16"));
    expect(doneDayOf(row.doneAt, late)).toBe("2026-04-15");
    expect(doneDayOf(row.doneAt, sampleRules())).toBe("2026-04-16");

    const lateDay: TodayScreenData = { ...day, input: { ...day.input, rules: late } };
    expect(buildQuestsView(questsOf(lateDay, { done: [row] }), NONE, 7).done.total).toBe(1);
    expect(buildQuestsView(questsOf(day, { done: [row] }), NONE, 7).done.total).toBe(0);
  });

  test("empty only when nothing is open anywhere and nothing is done", () => {
    const bare: TodayScreenData = { ...day, input: { ...day.input, candidates: [] } };
    expect(buildQuestsView(questsOf(bare), NONE, 7).empty).toBe(true);
    expect(
      buildQuestsView(questsOf(bare, { done: [finished("d-one", at("09:00"))] }), NONE, 7).empty,
    ).toBe(false);
    expect(buildQuestsView(questsOf(day), NONE, 7).empty).toBe(false);
  });
});

// --------------------------------------------------------------- behaviour 7

describe("titles and identities, as Today has them", () => {
  const day = busierDay();
  const view = buildQuestsView(questsOf(day), NONE, 7);
  const all = [...view.steps, ...view.side];

  test("titles are split with Today's splitTitle", () => {
    for (const item of all) {
      const source = day.input.candidates.find((entry) => entry.id === item.id);
      const split = splitTitle(source?.title ?? "");
      expect([item.title, item.detail], item.id).toEqual([split.title, split.detail]);
    }
    expect(all.find((item) => item.id === "t-x-work")?.detail).toBe("both drawers");
  });

  test("an identity is the group's tag, else the lane, else nothing", () => {
    for (const item of all) {
      const source = day.input.candidates.find((entry) => entry.id === item.id);
      expect(item.identity, item.id).toEqual(
        identityFor(item.id, source?.lane ?? null, day.tags, day.lanes),
      );
    }
    expect(all.find((item) => item.id === "t-glaze")?.identity?.source).toBe("tag");
    expect(all.find((item) => item.id === "t-essay")?.identity?.source).toBe("lane");
    expect(all.find((item) => item.id === "t-x-loose")?.identity?.label).toBe("Balcony");
    expect(all.find((item) => item.id === "t-x-loose-late")?.identity).toBeNull();
  });

  test("a finished thing is named and coloured by the same rule", () => {
    const tag: TaskTag = { label: "Kiln club", color: "#9B6EC5" };
    const data = questsOf(sampleDay(), {
      done: [
        finished("d-tagged", at("09:10"), { lane: "craft", tag, title: "Sand the frames (both sides)" }),
        finished("d-laned", at("09:05"), { lane: "study" }),
        finished("d-loose", at("09:00")),
      ],
    });
    const items = buildQuestsView(data, NONE, 7).done.days[0]?.items ?? [];
    expect(items.map((entry) => entry.title)).toEqual([
      "Sand the frames",
      "Finished d-laned",
      "Finished d-loose",
    ]);
    expect(items[0]?.identity).toEqual({ label: "Kiln club", color: "#9B6EC5", source: "tag" });
    expect(items[1]?.identity).toEqual({ label: "Study", color: "#7C9BFF", source: "lane" });
    expect(items[2]?.identity).toBeNull();
  });
});

// --------------------------------------------------------------- behaviour 8

describe("ordering never depends on the locale", () => {
  test("ties in the planner's order break on the id", () => {
    const base = sampleDay();
    const day: TodayScreenData = {
      ...base,
      input: {
        ...base.input,
        candidates: [
          candidate({ id: "t-zeta", lane: "craft" }),
          candidate({ id: "t-alpha", lane: "craft" }),
        ],
      },
    };
    expect(ids(buildQuestsView(questsOf(day), NONE, 7).steps)).toEqual(["t-alpha", "t-zeta"]);
  });

  test("the view is loadable by a browser and reads no locale", () => {
    const source = readFileSync(
      path.resolve(__dirname, "..", "app/lib/v2/view/quests.ts"),
      "utf8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
    expect(code).not.toMatch(/from\s+["'](node:|next\/|@\/app\/lib\/v2\/local\/|\.\.\/local\/)/);
    expect(code).not.toMatch(/localeCompare|toLocale|new Intl\./);
  });
});

// --------------------------------------------------------------- behaviour 9

describe("the sample", () => {
  const day = sampleDay();
  const data = sampleQuests(day);
  const titles = new Set(day.input.candidates.map((entry) => entry.title));
  const laneKeys = new Set(day.lanes.map((lane) => lane.key));

  test("is the sample day's own input, lanes and tags", () => {
    expect(data.input).toBe(day.input);
    expect(data.lanes).toBe(day.lanes);
    expect(data.tags).toBe(day.tags);
    expect(data.historyDays).toBe(28);
  });

  test("holds about twenty finished things over the last 21 days, some days empty", () => {
    expect(data.done.length).toBeGreaterThanOrEqual(18);
    expect(data.done.length).toBeLessThanOrEqual(22);
    const days = new Set<string>();
    for (const entry of data.done) {
      const doneDay = doneDayOf(entry.doneAt, day.input.rules);
      expect(doneDay, entry.id).not.toBeNull();
      const back = dayDiff(doneDay as string, SAMPLE_DATE);
      expect(back, entry.id).toBeGreaterThanOrEqual(0);
      expect(back, entry.id).toBeLessThan(21);
      expect(Date.parse(entry.doneAt), entry.id).toBeLessThanOrEqual(Date.parse(day.input.now));
      days.add(doneDay as string);
    }
    expect(days.size).toBeLessThan(21);
  });

  test("spreads across the sample's lanes, and only those", () => {
    for (const entry of data.done) {
      if (entry.lane !== null) expect(laneKeys.has(entry.lane), entry.id).toBe(true);
    }
    expect(new Set(data.done.map((entry) => entry.lane)).size).toBeGreaterThanOrEqual(4);
  });

  test("is newest first, with unique ids and invented titles", () => {
    const times = data.done.map((entry) => Date.parse(entry.doneAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(new Set(ids(data.done)).size).toBe(data.done.length);
    for (const entry of data.done) {
      expect(titles.has(entry.title), entry.title).toBe(false);
      expect(entry.title.trim().length).toBeGreaterThan(0);
    }
  });

  test("is deterministic", () => {
    expect(sampleQuests(sampleDay())).toEqual(sampleQuests(sampleDay()));
  });

  test("gives a rate for every span", () => {
    for (const span of QUEST_SPANS) {
      const view = buildQuestsView(data, NONE, span);
      expect(view.done.known, String(span)).toBe(true);
      expect(view.done.total, String(span)).toBeGreaterThan(0);
    }
  });
});

// -------------------------------------------------------------- behaviour 11

describe("the copy rules", () => {
  const day = busierDay();
  const everything = [
    ...strings(QUESTS_COPY),
    ...strings(buildQuestsView(sampleQuests(sampleDay()), NONE, 28)),
    ...strings(buildQuestsView(questsOf(day), new Set(["t-glaze"]), 7)),
    questPastLabel(1),
    questPastLabel(3),
    questDoneTotalLabel(4),
    questPerWeekLabel(2.5),
  ];

  test("has something to walk", () => {
    expect(strings(QUESTS_COPY).length).toBeGreaterThan(8);
    expect(everything.length).toBeGreaterThan(60);
  });

  // Built from code points, so this file stays pure ASCII.
  const EM_DASH = String.fromCodePoint(0x2014);
  const EN_DASH = String.fromCodePoint(0x2013);

  test("uses no em dash and no en dash", () => {
    for (const text of everything) {
      expect(text).not.toContain(EM_DASH);
      expect(text).not.toContain(EN_DASH);
    }
  });

  test("never speaks of streaks, points, levels or penalties", () => {
    for (const text of everything) {
      expect(text).not.toMatch(/\b(streaks?|points?|levels?|penalt(y|ies)|xp)\b/i);
    }
  });

  test("fills its templates", () => {
    expect(questPastLabel(1)).toBe("1 past its date");
    expect(questPastLabel(3)).toBe("3 past their date");
    expect(questDoneTotalLabel(4)).toBe("4 finished");
    expect(questPerWeekLabel(2.5)).toBe("2.5 a week");
    for (const text of [questPastLabel(2), questDoneTotalLabel(2), questPerWeekLabel(2)]) {
      expect(text).not.toMatch(/[{}]/);
    }
  });
});
