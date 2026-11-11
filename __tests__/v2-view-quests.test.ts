// PLAN-DESK Task 3, the Quests view model. buildQuestsView is the four Quests
// panes as data, and its one promise is that it reads exactly what Today reads:
// the same planner input, ordered by the planner's own ordering function,
// counted by Today's own lane summary. The first block below pins that promise
// on several inputs, a press on Today included; everything after it pins a rule
// of its own.
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
import type { Candidate, PlanOutput, PlannerRules } from "@/app/lib/v2/types";
import type { QuestDone, QuestsScreenData } from "@/app/lib/v2/view/desk-data";
import {
  QUESTS_COPY,
  QUEST_SPANS,
  buildQuestsView,
  doneDayOf,
  questDoneTotalLabel,
  questPastLabel,
  questPerWeekLabel,
  questThroughLabel,
  type QuestsView,
} from "@/app/lib/v2/view/quests";
import type { TaskTag, TodayScreenData } from "@/app/lib/v2/view/screen-data";
import {
  TODAY_COPY,
  buildTodayView,
  identityFor,
  splitTitle,
  workedTaskIds,
} from "@/app/lib/v2/view/today";

const at = sampleInstant;
const NONE: ReadonlySet<string> = new Set<string>();

/** Today's view of a day, built exactly the way the Today screen builds it. */
function todayViewOf(data: TodayScreenData, plan: PlanOutput = planDay(data.input)) {
  const { input } = data;
  return buildTodayView({
    date: input.date,
    now: input.now,
    reference: planReference(input.now, input.date, input.rules).instant,
    timeZone: input.rules.timeZone,
    plan,
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

/** The quests of a day: its own input, lanes and tags, plus a history up to the day. */
function questsOf(day: TodayScreenData, over: Partial<QuestsScreenData> = {}): QuestsScreenData {
  return {
    input: day.input,
    lanes: day.lanes,
    tags: day.tags,
    done: [],
    historyThrough: day.input.date,
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

function withCandidates(day: TodayScreenData, candidates: Candidate[]): TodayScreenData {
  return { ...day, input: { ...day.input, candidates } };
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
  return { ...withCandidates(day, [...day.input.candidates, ...extra]), tags };
}

/**
 * Two candidates the sample never has: one whose date cannot be read, and one
 * whose lane is not among the user's lanes. Both views treat the second as
 * belonging to no lane: it is a side quest on Quests and is counted in Today's
 * "No lane" row, because a lane nobody can see cannot hold it.
 */
function oddDay(): TodayScreenData {
  const day = sampleDay();
  return withCandidates(day, [
    ...day.input.candidates,
    candidate({ id: "t-x-someday", title: "Mend the fence", lane: "craft", due: "someday" }),
    candidate({ id: "t-x-ghost", title: "Label the spare keys", lane: "ghost", due: at("12:00", "2026-04-17") }),
  ]);
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

/** The plan of a day with the first block that carries a laned task marked done. */
function pressed(day: TodayScreenData): { plan: PlanOutput; taskId: string; lane: string } {
  const first = planDay(day.input);
  const block = first.blocks.find((entry) =>
    day.input.candidates.some((c) => c.id === entry.taskId && c.lane !== null),
  );
  if (block === undefined || block.taskId === null) throw new Error("the sample plans no task");
  const lane = day.input.candidates.find((c) => c.id === block.taskId)?.lane as string;
  return {
    taskId: block.taskId,
    lane,
    plan: {
      ...first,
      blocks: first.blocks.map((entry) =>
        entry.id === block.id ? { ...entry, state: "done" as const } : entry,
      ),
    },
  };
}

// --------------------------------------------------------------- behaviour 1

describe("the same input as Today", () => {
  const cases: Array<{ name: string; day: TodayScreenData; plan?: PlanOutput }> = [
    { name: "the sample day", day: sampleDay() },
    { name: "a busier day with loose items and groups", day: busierDay() },
    { name: "a day with an unreadable date and a lane nobody has", day: oddDay() },
    (() => {
      const day = sampleDay();
      return { name: "the sample day after a press on Today", day, plan: pressed(day).plan };
    })(),
  ];

  for (const { name, day, plan: shown } of cases) {
    describe(name, () => {
      const plan = shown ?? planDay(day.input);
      const today = todayViewOf(day, plan);
      // The ids Today's own rule calls worked on in the plan being shown.
      const quests = buildQuestsView(questsOf(day), workedTaskIds(plan), 7);
      const lineOf = (key: string) =>
        today.lanes.find((entry) => entry.color !== null && entry.key === key);

      test("every lane's open count is Today's lane line count", () => {
        for (const lane of quests.lanes) {
          expect(lane.open, lane.key).toBe(lineOf(lane.key)?.open ?? 0);
          expect(quests.steps.filter((item) => item.lane === lane.key).length, lane.key).toBe(
            lane.open,
          );
        }
      });

      test("every lane's nearest date is Today's lane line date", () => {
        for (const lane of quests.lanes) {
          expect(lane.due, lane.key).toBe(lineOf(lane.key)?.due ?? null);
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

      test("rank is the place in the list Quests shows, in the planner's ordering", () => {
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

      test("worked is exactly the tasks with a done block in the plan shown", () => {
        const worked = workedTaskIds(plan);
        for (const item of [...quests.steps, ...quests.side]) {
          expect(item.worked, item.id).toBe(worked.has(item.id));
        }
      });
    });
  }

  test("the cases are not vacuous: a no lane row, an odd date, a lane nobody has, a press", () => {
    expect(ids(buildQuestsView(questsOf(busierDay()), NONE, 7).side)).toEqual([
      "t-x-loose",
      "t-x-loose-late",
    ]);

    const odd = buildQuestsView(questsOf(oddDay()), NONE, 7);
    expect(ids(odd.side)).toEqual(["t-x-ghost"]);
    expect(odd.side[0]?.lane).toBeNull();
    expect(odd.steps.find((item) => item.id === "t-x-someday")?.when).toBe("none");
    const oddToday = todayViewOf(oddDay());
    expect(oddToday.lanes.find((entry) => entry.label === TODAY_COPY.noLane)?.open).toBe(1);

    // A press is work on the task, not its end: after it both views count the
    // same, unchanged number, and the pressed item reads worked on Quests.
    const day = sampleDay();
    const { plan, taskId, lane } = pressed(day);
    const todayBefore = todayViewOf(day).lanes.find((entry) => entry.key === lane)?.open;
    const todayAfter = todayViewOf(day, plan).lanes.find((entry) => entry.key === lane)?.open;
    const questsBefore = buildQuestsView(questsOf(day), NONE, 7);
    const questsAfter = buildQuestsView(questsOf(day), workedTaskIds(plan), 7);
    const laneOf = (view: QuestsView) => view.lanes.find((entry) => entry.key === lane);
    expect(todayBefore).toBeGreaterThan(0);
    expect(todayAfter).toBe(todayBefore);
    expect(laneOf(questsAfter)?.open).toBe(todayBefore);
    expect(laneOf(questsAfter)?.open).toBe(laneOf(questsBefore)?.open);
    expect(workedTaskIds(plan).has(taskId)).toBe(true);
    expect(questsAfter.steps.find((item) => item.id === taskId)?.worked).toBe(true);
    expect(questsBefore.steps.find((item) => item.id === taskId)?.worked).toBe(false);
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
  // its date for the planner and for Today; ordering it from the clock would put
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

    test("the item due before the reference comes after the live one and reads past", () => {
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

// A press on Today is work on a task, not its end: a touch, a session or a block
// of focus served the task for the day. So the task stays exactly where it was
// and only reads as worked on today.
describe("a press on Today is seen here, as work and not as a finish", () => {
  const day = sampleDay();
  const before = buildQuestsView(questsOf(day), NONE, 7);
  const after = buildQuestsView(questsOf(day), new Set(["t-glaze"]), 7);
  const without = (view: QuestsView) => ({
    ...view,
    steps: view.steps.map((item) => ({ ...item, worked: false })),
    side: view.side.map((item) => ({ ...item, worked: false })),
    lanes: view.lanes.map((lane) =>
      lane.next === null ? lane : { ...lane, next: { ...lane.next, worked: false } },
    ),
  });

  test("the worked step stays in the steps, its lane's count and its lane's next", () => {
    const glaze = after.steps.find((item) => item.id === "t-glaze");
    expect(glaze?.worked).toBe(true);
    const craft = after.lanes.find((lane) => lane.key === "craft");
    expect(craft?.open).toBe(1);
    expect(craft?.next?.id).toBe("t-glaze");
    expect(craft?.next?.worked).toBe(true);
    expect(craft?.quiet).toBe(false);
  });

  test("everything else reads as before: same places, same counts, nothing in done", () => {
    expect(without(after)).toEqual(before);
    expect(after.done).toEqual(before.done);
    for (const item of [...after.steps, ...after.side]) {
      if (item.id !== "t-glaze") expect(item.worked, item.id).toBe(false);
    }
  });

  test("a side quest worked on stays a side quest", () => {
    const view = buildQuestsView(questsOf(busierDay()), new Set(["t-x-loose"]), 7);
    expect(ids(view.side)).toEqual(["t-x-loose", "t-x-loose-late"]);
    expect(view.side.map((item) => item.worked)).toEqual([true, false]);
    expect(view.done.total).toBe(0);
  });

  test("an id that is not a candidate changes nothing", () => {
    expect(buildQuestsView(questsOf(day), new Set(["not-a-task"]), 7)).toEqual(before);
  });

  test("done is the source's history and nothing else", () => {
    const data = questsOf(day, {
      done: [finished("d-earlier", at("08:00"), { lane: "craft", title: "Sand the frames" })],
    });
    const view = buildQuestsView(data, new Set(["t-glaze", "t-grant"]), 7);
    expect(view.done.total).toBe(1);
    expect(ids(view.done.days[0]?.items ?? [])).toEqual(["d-earlier"]);
  });
});

// --------------------------------------------------------------- behaviour 3

describe("lanes that nothing feeds stay quiet", () => {
  test("a lane with nothing open and nothing done says nothing, not even a zero", () => {
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
      done: null,
      quiet: true,
    });
  });

  test("every lane is there, in the user's order, quiet ones included", () => {
    const day = sampleDay();
    const view = buildQuestsView(questsOf(day), NONE, 7);
    expect(view.lanes.map((lane) => lane.key)).toEqual(day.lanes.map((lane) => lane.key));
  });

  test("a lane with only something finished is not quiet, and counts it when known", () => {
    const day = sampleDay();
    const done = [finished("d-shift", at("09:30"), { lane: "work" })];
    const known = buildQuestsView(questsOf(day, { done }), NONE, 7);
    expect(known.lanes.find((lane) => lane.key === "work")).toMatchObject({
      quiet: false,
      open: 0,
      done: 1,
    });

    const unknown = buildQuestsView(questsOf(day, { done, historyDays: 0 }), NONE, 7);
    expect(unknown.lanes.find((lane) => lane.key === "work")).toMatchObject({
      quiet: false,
      done: null,
    });
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
    const day = withCandidates(sampleDay(), [
      candidate({ id: "t-soft", lane: "craft", due: at("12:00", "2026-04-16") }),
    ]);
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
    const day = withCandidates(sampleDay(), [candidate({ id: "t-odd", lane: "craft", due: "someday" })]);
    const odd = buildQuestsView(questsOf(day), NONE, 7).steps[0];
    expect(odd?.due).toBeNull();
    expect(odd?.when).toBe("none");
  });

  // A due date is read on the CALENDAR day, as the planner's "closes today" and
  // Today's label read it; a finish is read on the PLANNING day. With lights out
  // after midnight the two differ, and each is pinned here as it is meant.
  test("a due date after midnight is the next calendar day, even before lights out", () => {
    const base = sampleDay();
    const late: PlannerRules = { ...sampleRules(), lightsOut: "01:30" };
    const day: TodayScreenData = {
      ...base,
      input: {
        ...base.input,
        rules: late,
        candidates: [candidate({ id: "t-small-hours", lane: "craft", hard: true, due: at("00:50", "2026-04-16") })],
      },
    };
    const view = buildQuestsView(questsOf(day), NONE, 7);
    expect(view.steps[0]?.due).toBe("16 April");
    expect(view.steps[0]?.when).toBe("soon");
    expect(doneDayOf(at("00:50", "2026-04-16"), late)).toBe(SAMPLE_DATE);
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
    expect(view.done.through).toBeNull();
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

  test("a known span with nothing finished has no rate: zero is never a rate", () => {
    const view = buildQuestsView(questsOf(day), NONE, 7);
    expect(view.done.known).toBe(true);
    expect(view.done.total).toBe(0);
    expect(view.done.perWeek).toBeNull();
  });

  test("a lane's done is what it finished inside the span", () => {
    const view = buildQuestsView(data, NONE, 7);
    const doneOf = (key: string) => view.lanes.find((lane) => lane.key === key)?.done;
    expect(doneOf("study")).toBe(1);
    expect(doneOf("money")).toBe(1);
    expect(doneOf("craft")).toBe(1);
    // Open, nothing finished, history known: a true zero.
    expect(doneOf("people")).toBe(0);
  });

  test("a span the history does not reach has no rate and no lane counts", () => {
    const view = buildQuestsView(questsOf(day, { done: history, historyDays: 7 }), NONE, 14);
    expect(view.done.known).toBe(false);
    expect(view.done.perWeek).toBeNull();
    for (const lane of view.lanes) expect(lane.done, lane.key).toBeNull();
    // What it does hold is still listed: the rate is what would be invented.
    expect(view.done.total).toBe(6);
  });

  test("a source with no history at all knows no span", () => {
    for (const span of QUEST_SPANS) {
      const view = buildQuestsView(
        questsOf(day, { historyThrough: null, historyDays: 0 }),
        NONE,
        span,
      );
      expect(view.done).toEqual({
        span,
        days: [],
        total: 0,
        perWeek: null,
        known: false,
        through: null,
      });
    }
  });

  test("history that ends nowhere is not known, whatever its length says", () => {
    const view = buildQuestsView(questsOf(day, { done: history, historyThrough: null }), NONE, 7);
    expect(view.done.known).toBe(false);
    expect(view.done.perWeek).toBeNull();
  });

  // A copy taken three days before the planned day cannot speak for the three
  // days since. Lately ends on the copy's day, and says so.
  describe("a copy older than the planned day", () => {
    const stale = questsOf(day, { done: history, historyThrough: "2026-04-12" });

    test("lately is the span ending on the day the copy was taken", () => {
      const view = buildQuestsView(stale, NONE, 7);
      expect(view.done.days.map((entry) => entry.date)).toEqual(["2026-04-09", "2026-04-08"]);
      expect(view.done.total).toBe(2);
      expect(view.done.known).toBe(true);
      expect(view.done.perWeek).toBe(2);
      expect(view.done.through).toBe("Sunday 12 April");
      expect(questThroughLabel(view.done.through as string)).toBe("Up to Sunday 12 April");
    });

    test("a history that runs past the planned day still ends on the planned day", () => {
      const view = buildQuestsView(questsOf(day, { done: history, historyThrough: "2026-04-20" }), NONE, 7);
      expect(view.done.through).toBeNull();
      expect(view.done.total).toBe(5);
    });
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
    const bare = withCandidates(day, []);
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
  test("ties in the planner's ordering break on the id", () => {
    const day = withCandidates(sampleDay(), [
      candidate({ id: "t-zeta", lane: "craft" }),
      candidate({ id: "t-alpha", lane: "craft" }),
    ]);
    expect(ids(buildQuestsView(questsOf(day), NONE, 7).steps)).toEqual(["t-alpha", "t-zeta"]);
  });

  test("the view and its sample are loadable by a browser and read no locale", () => {
    for (const file of ["app/lib/v2/view/quests.ts", "app/lib/v2/fixtures/sample-quests.ts"]) {
      const source = readFileSync(path.resolve(__dirname, "..", file), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
      expect(code, file).toMatch(/\bfrom\s+["']/);
      expect(code, file).not.toMatch(
        /from\s+["'](node:|next\/|@\/app\/lib\/v2\/local\/|\.\.\/local\/)/,
      );
      expect(code, file).not.toMatch(/localeCompare|toLocale|new Intl\./);
    }
  });
});

// --------------------------------------------------------------- behaviour 9

describe("the sample", () => {
  const day = sampleDay();
  const data = sampleQuests(day);
  const titles = new Set(day.input.candidates.map((entry) => entry.title));
  const laneKeys = new Set(day.lanes.map((lane) => lane.key));

  test("is the sample day's own input, lanes and tags, with history up to that day", () => {
    expect(data.input).toBe(day.input);
    expect(data.lanes).toBe(day.lanes);
    expect(data.tags).toBe(day.tags);
    expect(data.historyThrough).toBe(SAMPLE_DATE);
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

  test("gives a rate for every span, ending on the sample day", () => {
    for (const span of QUEST_SPANS) {
      const view = buildQuestsView(data, NONE, span);
      expect(view.done.known, String(span)).toBe(true);
      expect(view.done.total, String(span)).toBeGreaterThan(0);
      expect(view.done.through, String(span)).toBeNull();
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
    ...strings(buildQuestsView(questsOf(day, { historyThrough: "2026-04-12" }), NONE, 7)),
    questPastLabel(1),
    questPastLabel(3),
    questDoneTotalLabel(4),
    questPerWeekLabel(2.5),
    questThroughLabel("Sunday 12 April"),
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
    expect(questThroughLabel("Sunday 12 April")).toBe("Up to Sunday 12 April");
    for (const text of [
      questPastLabel(2),
      questDoneTotalLabel(2),
      questPerWeekLabel(2),
      questThroughLabel("Monday 13 April"),
    ]) {
      expect(text).not.toMatch(/[{}]/);
    }
  });

  test("has a sentence for each way there is no rate", () => {
    expect(QUESTS_COPY.doneNone.length).toBeGreaterThan(0);
    expect(QUESTS_COPY.noHistory.length).toBeGreaterThan(0);
    expect(QUESTS_COPY.shortHistory.length).toBeGreaterThan(0);
  });

  // Worked on, never "done": the press served the task for the day.
  test("names a step worked on today without calling it finished", () => {
    expect(QUESTS_COPY.worked).toBe("Worked on today");
    expect(QUESTS_COPY.worked).not.toMatch(/\b(done|finished|complete)/i);
  });
});
