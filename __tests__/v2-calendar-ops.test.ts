// @vitest-environment node
// Task 12, the write side: what an edit does to the list in front of the user
// (applyOp), how it is taken back (invertOp), what one commit's outcome does to
// the list as it stands now (settle), what the fake Google does with an etag,
// and what commit reports when the two disagree.
//
// EVERYTHING HERE IS INVENTED. Phoenix has no daylight saving, so every instant
// below is stable. The random sequence is driven by a seeded generator written
// in this file, so a failure can be reproduced exactly.

import { describe, expect, test } from "vitest";

import {
  CalendarConflictError,
  CalendarMissingError,
  CalendarReadOnlyError,
} from "@/app/lib/v2/calendar/port";
import type { CalendarPort, CalendarRange } from "@/app/lib/v2/calendar/port";
import { FakeCalendar } from "@/app/lib/v2/calendar/fake-port";
import type { FakeCalendarOptions } from "@/app/lib/v2/calendar/fake-port";
import { applyOp, canonicalEvents, commit, invertOp, settle } from "@/app/lib/v2/calendar/ops";
import type { CalendarOp } from "@/app/lib/v2/calendar/ops";
import { DRAFT_ID_PREFIX, draftAt } from "@/app/lib/v2/calendar/edit";
import type { CalEvent } from "@/app/lib/v2/calendar/types";

const ZONE = "America/Phoenix";
const OFF = "-07:00";
const DAY = "2026-04-15";
const DRAFT = `${DRAFT_ID_PREFIX}2026-04-15:660:720:cal-a`;

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
    etag: `${id}-etag`,
    editable: true,
    recurring: false,
    ...extra,
  };
}

function span(id: string, start: string, end: string, extra: Partial<CalEvent> = {}): CalEvent {
  return { ...timed(id, start, end, extra), allDay: true };
}

/** Deterministic ids and etags, so every assertion below is exact. */
function sources() {
  let ids = 0;
  let etags = 0;
  return {
    nextId: () => `made-${(ids += 1)}`,
    nextEtag: () => `tag-${(etags += 1)}`,
  };
}

function fake(options: Partial<FakeCalendarOptions> = {}): FakeCalendar {
  return new FakeCalendar({ timeZone: ZONE, ...sources(), ...options });
}

const WHOLE_WEEK: CalendarRange = {
  timeMin: at("00:00", "2026-04-13"),
  timeMax: at("00:00", "2026-04-20"),
};

const find = (events: readonly CalEvent[], id: string): CalEvent => {
  const found = events.find((event) => event.id === id);
  if (found === undefined) throw new Error(`not in the list: ${id}`);
  return found;
};

describe("applyOp", () => {
  const one = timed("a", at("09:00"), at("10:00"));
  const two = timed("b", at("14:00"), at("15:00"));
  const events = [one, two];

  test("create adds the event in start order", () => {
    const next = applyOp(events, { kind: "create", event: timed("c", at("11:00"), at("12:00")) });
    expect(next.map((event) => event.id)).toEqual(["a", "c", "b"]);
    expect(next).not.toBe(events);
  });

  test("restore puts an event back the same way a create adds one", () => {
    const next = applyOp(events, { kind: "restore", event: timed("c", at("11:00"), at("12:00")) });
    expect(next.map((event) => event.id)).toEqual(["a", "c", "b"]);
  });

  test("create of an id that is already there changes nothing", () => {
    expect(applyOp(events, { kind: "create", event: timed("a", at("20:00"), at("21:00")) })).toBe(
      events,
    );
  });

  test("create of an event nobody may edit changes nothing", () => {
    const op: CalendarOp = {
      kind: "create",
      event: timed("c", at("11:00"), at("12:00"), { editable: false }),
    };
    expect(applyOp(events, op)).toBe(events);
  });

  test("move rewrites the two instants and re-sorts", () => {
    const next = applyOp(events, {
      kind: "move",
      id: "a",
      start: at("16:00"),
      end: at("17:00"),
      expectEtag: "a-etag",
    });
    expect(next.map((event) => event.id)).toEqual(["b", "a"]);
    expect(next[1].start).toBe(at("16:00"));
    expect(next[1].etag).toBe("a-etag");
  });

  test("rename rewrites the title and nothing else", () => {
    const next = applyOp(events, { kind: "rename", id: "b", title: "new name", expectEtag: null });
    expect(next[1]).toEqual({ ...two, title: "new name" });
  });

  test("remove drops it and leaves the rest alone", () => {
    const next = applyOp(events, { kind: "remove", id: "a", expectEtag: null });
    expect(next.map((event) => event.id)).toEqual(["b"]);
  });

  test("a move or rename to the value it already has changes nothing", () => {
    const sameMove: CalendarOp = {
      kind: "move",
      id: "a",
      start: at("09:00"),
      end: at("10:00"),
      expectEtag: null,
    };
    expect(applyOp(events, sameMove)).toBe(events);
    expect(applyOp(events, { kind: "rename", id: "a", title: "a", expectEtag: null })).toBe(events);
  });

  test("an instant carrying a fraction of a second is floored", () => {
    const next = applyOp(events, {
      kind: "move",
      id: "a",
      start: "2026-04-15T16:00:00.750-07:00",
      end: "2026-04-15T17:00:00.250-07:00",
      expectEtag: null,
    });
    expect(find(next, "a").start).toBe(at("16:00"));
    expect(find(next, "a").end).toBe(at("17:00"));
  });

  test("an op on an event that is not there changes nothing", () => {
    expect(applyOp(events, { kind: "remove", id: "nope", expectEtag: null })).toBe(events);
    expect(
      applyOp(events, {
        kind: "move",
        id: "nope",
        start: at("01:00"),
        end: at("02:00"),
        expectEtag: null,
      }),
    ).toBe(events);
    expect(applyOp(events, { kind: "rename", id: "nope", title: "x", expectEtag: null })).toBe(
      events,
    );
  });

  test("an op on an event nobody may edit changes nothing", () => {
    const locked = [timed("r", at("09:00"), at("10:00"), { editable: false })];
    expect(
      applyOp(locked, {
        kind: "move",
        id: "r",
        start: at("11:00"),
        end: at("12:00"),
        expectEtag: null,
      }),
    ).toBe(locked);
    expect(applyOp(locked, { kind: "rename", id: "r", title: "x", expectEtag: null })).toBe(locked);
    expect(applyOp(locked, { kind: "remove", id: "r", expectEtag: null })).toBe(locked);
  });

  test("it never writes into the list it was given", () => {
    const original = [...events];
    applyOp(events, {
      kind: "move",
      id: "a",
      start: at("20:00"),
      end: at("21:00"),
      expectEtag: null,
    });
    expect(events).toEqual(original);
    expect(events[0]).toEqual(one);
  });

  test("the expected etag is not checked here, only by the port", () => {
    const next = applyOp(events, { kind: "rename", id: "a", title: "x", expectEtag: "stale" });
    expect(find(next, "a").title).toBe("x");
  });
});

describe("invertOp", () => {
  const one = timed("a", at("09:00"), at("10:00"));
  const events = [one];

  test("a create is undone by removing it", () => {
    const made = timed("c", at("11:00"), at("12:00"));
    expect(invertOp(events, { kind: "create", event: made })).toEqual({
      kind: "remove",
      id: "c",
      expectEtag: "c-etag",
    });
  });

  test("a move is undone by moving it back", () => {
    const op: CalendarOp = {
      kind: "move",
      id: "a",
      start: at("16:00"),
      end: at("17:00"),
      expectEtag: "a-etag",
    };
    expect(invertOp(events, op)).toEqual({
      kind: "move",
      id: "a",
      start: at("09:00"),
      end: at("10:00"),
      expectEtag: "a-etag",
    });
  });

  test("a rename is undone by the old title", () => {
    expect(invertOp(events, { kind: "rename", id: "a", title: "x", expectEtag: null })).toEqual({
      kind: "rename",
      id: "a",
      title: "a",
      expectEtag: "a-etag",
    });
  });

  test("a remove is undone by restoring it, never by creating a copy", () => {
    const inverse = invertOp(events, { kind: "remove", id: "a", expectEtag: null });
    expect(inverse).toEqual({ kind: "restore", event: one });
  });

  test("a restore is undone by removing it again", () => {
    expect(invertOp([], { kind: "restore", event: one })).toEqual({
      kind: "remove",
      id: "a",
      expectEtag: "a-etag",
    });
  });

  test("there is nothing to undo when the op did nothing", () => {
    expect(invertOp(events, { kind: "remove", id: "nope", expectEtag: null })).toBe(null);
    expect(invertOp(events, { kind: "create", event: one })).toBe(null);
    expect(
      invertOp(events, {
        kind: "move",
        id: "a",
        start: at("09:00"),
        end: at("10:00"),
        expectEtag: null,
      }),
    ).toBe(null);
    expect(invertOp(events, { kind: "rename", id: "a", title: "a", expectEtag: null })).toBe(null);
    const locked = [timed("r", at("09:00"), at("10:00"), { editable: false })];
    expect(invertOp(locked, { kind: "rename", id: "r", title: "x", expectEtag: null })).toBe(null);
  });

  test("the inverse undoes the op it was built from", () => {
    const op: CalendarOp = { kind: "remove", id: "a", expectEtag: null };
    const after = applyOp(events, op);
    const inverse = invertOp(events, op);
    if (inverse === null) throw new Error("expected an inverse");
    expect(applyOp(after, inverse)).toEqual(events);
  });

  test("undoing a removal puts the event back where it was, not at the end", () => {
    const three = canonicalEvents([
      timed("first", at("09:00"), at("10:00")),
      timed("middle", at("12:00"), at("13:00")),
      timed("last", at("15:00"), at("16:00")),
    ]);
    const op: CalendarOp = { kind: "remove", id: "middle", expectEtag: null };
    const inverse = invertOp(three, op);
    if (inverse === null) throw new Error("expected an inverse");
    const undone = applyOp(applyOp(three, op), inverse);
    expect(undone.map((event) => event.id)).toEqual(["first", "middle", "last"]);
    expect(undone).toEqual(three);
  });

  test("an unsorted list comes back sorted, which is the engine's order", () => {
    // The round trip is only an identity up to canonical order, and canonical
    // order is the contract: a list in any other order is already wrong.
    const unsorted = [timed("b", at("14:00"), at("15:00")), timed("a", at("09:00"), at("10:00"))];
    const op: CalendarOp = { kind: "remove", id: "a", expectEtag: null };
    const inverse = invertOp(unsorted, op);
    if (inverse === null) throw new Error("expected an inverse");
    const undone = applyOp(applyOp(unsorted, op), inverse);
    expect(undone.map((event) => event.id)).toEqual(["a", "b"]);
    expect(undone).toEqual(canonicalEvents(unsorted));
  });
});

describe("settle", () => {
  const one = timed("a", at("09:00"), at("10:00"));
  const two = timed("b", at("14:00"), at("15:00"));

  test("nothing to do returns the same list", () => {
    const events = [one, two];
    expect(settle(events, { kind: "none" })).toBe(events);
    expect(settle(events, { kind: "remove", id: "ghost" })).toBe(events);
  });

  test("a replacement under a new id takes the old one's place", () => {
    const draft = timed(DRAFT, at("11:00"), at("12:00"), { etag: null });
    const server = timed("made-1", at("11:00"), at("12:00"), { etag: "tag-1" });
    const settled = settle([one, draft, two], { kind: "replace", id: DRAFT, event: server });
    expect(settled.map((event) => event.id)).toEqual(["a", "made-1", "b"]);
    expect(find(settled, "made-1").etag).toBe("tag-1");
  });

  test("a replacement lands even when the old id has gone already", () => {
    const server = timed("made-1", at("11:00"), at("12:00"));
    const settled = settle([one], { kind: "replace", id: DRAFT, event: server });
    expect(settled.map((event) => event.id)).toEqual(["a", "made-1"]);
  });

  test("a replacement of an event that is still there does not duplicate it", () => {
    const moved = { ...one, start: at("16:00"), end: at("17:00"), etag: "tag-9" };
    const settled = settle([one, two], { kind: "replace", id: "a", event: moved });
    expect(settled.map((event) => event.id)).toEqual(["b", "a"]);
    expect(find(settled, "a").etag).toBe("tag-9");
  });

  test("a removal takes it out and keeps the order", () => {
    expect(settle([one, two], { kind: "remove", id: "a" }).map((event) => event.id)).toEqual(["b"]);
  });
});

/** An ordinary linear congruential generator, so a seed reproduces a run. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

describe("a random sequence of ops and their inverses", () => {
  test("undoing in reverse order returns the list it started from", () => {
    for (const seed of [1, 7, 42, 1_234, 99_991]) {
      const random = makeRandom(seed);
      const pick = (n: number) => Math.floor(random() * n);
      // Deliberately NOT in canonical order, and with an all day event and a
      // draft in it, because a real list holds both.
      const shuffled = [
        timed("d", at("20:00"), at("21:00")),
        span("holiday", "2026-04-15", "2026-04-17"),
        timed("a", at("09:00"), at("10:00")),
        timed("locked", at("16:00"), at("17:00"), { editable: false }),
        timed(DRAFT, at("11:00"), at("12:00"), { etag: null }),
        timed("b", at("11:00"), at("12:00")),
      ];
      const start = canonicalEvents(shuffled);

      let events = start;
      const inverses: CalendarOp[] = [];
      let effective = 0;
      let made = 0;
      for (let step = 0; step < 60; step += 1) {
        // Includes ids that are not there, one nobody may edit, and a create of
        // an id the list already holds, so a no-op has to invert to nothing.
        const ids = [...events.map((event) => event.id), "ghost", "locked", "a"];
        const id = ids[pick(ids.length)];
        const hour = 6 + pick(16);
        const clock = `${String(hour).padStart(2, "0")}:00`;
        const kind = pick(5);
        // Every third create or restore reuses an id the list may already
        // hold, so the no-op path is exercised from both sides.
        const fresh = pick(3) !== 0;
        const op: CalendarOp =
          kind === 0
            ? {
                kind: "create",
                event: timed(
                  fresh ? `made-${(made += 1)}` : id,
                  at(clock),
                  at(`${String(hour).padStart(2, "0")}:30`),
                ),
              }
            : kind === 1
              ? {
                  kind: "move",
                  id,
                  start: at(clock),
                  end: at(`${String(hour).padStart(2, "0")}:45`),
                  expectEtag: null,
                }
              : kind === 2
                ? { kind: "rename", id, title: `title ${step}`, expectEtag: null }
                : kind === 3
                  ? { kind: "remove", id, expectEtag: null }
                  : {
                      kind: "restore",
                      event: timed(
                        fresh ? `back-${step}` : id,
                        at(clock),
                        at(`${String(hour).padStart(2, "0")}:30`),
                      ),
                    };

        const inverse = invertOp(events, op);
        const next = applyOp(events, op);
        if (inverse === null) {
          expect(next).toBe(events);
        } else {
          expect(next).not.toBe(events);
          effective += 1;
          inverses.push(inverse);
        }
        events = next;
      }
      expect(effective).toBeGreaterThan(0);

      for (const inverse of [...inverses].reverse()) {
        events = applyOp(events, inverse);
      }
      expect(events).toEqual(start);
    }
  });
});

describe("FakeCalendar", () => {
  test("it lists what overlaps the range, in start order", async () => {
    const calendar = fake({
      events: [
        timed("inside", at("09:00"), at("10:00")),
        timed("early", at("09:00", "2026-04-06"), at("10:00", "2026-04-06")),
        timed("edge", at("23:00", "2026-04-12"), at("01:00", "2026-04-13")),
        timed("first", at("08:00"), at("08:30")),
      ],
    });
    expect((await calendar.list(WHOLE_WEEK)).map((event) => event.id)).toEqual([
      "edge",
      "first",
      "inside",
    ]);
  });

  test("an all day event is listed by the days it covers", async () => {
    const calendar = fake({
      events: [
        span("in", "2026-04-15", "2026-04-16"),
        span("before", "2026-04-01", "2026-04-13"),
        span("after", "2026-04-20", "2026-04-21"),
      ],
    });
    expect((await calendar.list(WHOLE_WEEK)).map((event) => event.id)).toEqual(["in"]);
  });

  test("a range that ends mid day still covers that day", async () => {
    const calendar = fake({ events: [span("in", "2026-04-20", "2026-04-21")] });
    const untilNoon: CalendarRange = {
      timeMin: at("00:00", "2026-04-20"),
      timeMax: at("12:00", "2026-04-20"),
    };
    expect((await calendar.list(untilNoon)).map((event) => event.id)).toEqual(["in"]);
  });

  test("an all day event east of UTC is listed by the zone the range was built in", async () => {
    const events = [
      span("sunday", "2026-04-19", "2026-04-20"),
      span("sunday-before", "2026-04-12", "2026-04-13"),
    ];
    // Tokyo's own week: its midnights are 15:00 the day before in UTC, so a
    // calendar that read those instants as UTC days would answer a day early.
    const tokyoWeek: CalendarRange = {
      timeMin: "2026-04-13T00:00:00+09:00",
      timeMax: "2026-04-20T00:00:00+09:00",
    };
    const tokyo = fake({ events, timeZone: "Asia/Tokyo" });
    expect((await tokyo.list(tokyoWeek)).map((event) => event.id)).toEqual(["sunday"]);
  });

  test("a range spelled in UTC works in UTC", async () => {
    const calendar = fake({
      timeZone: "UTC",
      events: [
        timed("inside", "2026-04-15T09:00:00Z", "2026-04-15T10:00:00Z"),
        timed("outside", "2026-04-25T09:00:00Z", "2026-04-25T10:00:00Z"),
        span("whole-day", "2026-04-15", "2026-04-16"),
      ],
    });
    const utcWeek: CalendarRange = {
      timeMin: "2026-04-13T00:00:00Z",
      timeMax: "2026-04-20T00:00:00Z",
    };
    expect((await calendar.list(utcWeek)).map((event) => event.id)).toEqual([
      "whole-day",
      "inside",
    ]);
  });

  test("what it hands out cannot be changed from outside", async () => {
    const calendar = fake({ events: [timed("a", at("09:00"), at("10:00"))] });
    const listed = await calendar.list(WHOLE_WEEK);
    listed[0].title = "changed";
    expect((await calendar.list(WHOLE_WEEK))[0].title).toBe("a");
  });

  test("a row on a read only calendar is handed out as not editable", async () => {
    const calendar = fake({
      events: [timed("a", at("09:00"), at("10:00"), { calendarId: "cal-holidays" })],
      readOnlyCalendarIds: ["cal-holidays"],
    });
    expect((await calendar.list(WHOLE_WEEK))[0].editable).toBe(false);
  });

  test("insert gives the event the calendar's own id and etag", async () => {
    const calendar = fake();
    const made = await calendar.insert(timed(DRAFT, at("09:00"), at("10:00")));
    expect(made.id).toBe("made-1");
    expect(made.etag).toBe("tag-1");
    expect(made.start).toBe(at("09:00"));
    expect((await calendar.list(WHOLE_WEEK)).map((event) => event.id)).toEqual(["made-1"]);
  });

  test("it refuses an event that ends before it starts", async () => {
    const calendar = fake({ events: [timed("a", at("09:00"), at("10:00"))] });
    await expect(calendar.insert(timed("x", at("10:00"), at("09:00")))).rejects.toThrow(
      "an event cannot end before it starts",
    );
    await expect(calendar.insert(timed("x", at("10:00"), at("10:00")))).rejects.toThrow(
      "an event cannot end before it starts",
    );
    await expect(calendar.patch("a", { end: at("08:00") }, "a-etag")).rejects.toThrow(
      "an event cannot end before it starts",
    );
    expect((await calendar.list(WHOLE_WEEK))[0].end).toBe(at("10:00"));
  });

  test("a read only calendar refuses every write", async () => {
    const calendar = fake({
      events: [timed("a", at("09:00"), at("10:00"), { calendarId: "cal-holidays" })],
      readOnlyCalendarIds: ["cal-holidays"],
    });
    await expect(
      calendar.insert(timed(DRAFT, at("09:00"), at("10:00"), { calendarId: "cal-holidays" })),
    ).rejects.toThrow(CalendarReadOnlyError);
    await expect(calendar.patch("a", { title: "x" }, "a-etag")).rejects.toThrow(
      CalendarReadOnlyError,
    );
    await expect(calendar.remove("a", "a-etag")).rejects.toThrow(CalendarReadOnlyError);
  });

  test("an event nobody may edit refuses a write even on a writable calendar", async () => {
    const calendar = fake({ events: [timed("a", at("09:00"), at("10:00"), { editable: false })] });
    await expect(calendar.patch("a", { title: "x" }, "a-etag")).rejects.toThrow(
      CalendarReadOnlyError,
    );
  });

  test("a stale etag is a conflict and changes nothing", async () => {
    const calendar = fake({ events: [timed("a", at("09:00"), at("10:00"))] });
    await expect(calendar.patch("a", { title: "x" }, "old")).rejects.toThrow(CalendarConflictError);
    expect((await calendar.list(WHOLE_WEEK))[0].title).toBe("a");
  });

  test("the right etag goes through and a new one is issued", async () => {
    const calendar = fake({ events: [timed("a", at("09:00"), at("10:00"))] });
    const patched = await calendar.patch("a", { start: at("11:00"), end: at("12:00") }, "a-etag");
    expect(patched.start).toBe(at("11:00"));
    expect(patched.etag).toBe("tag-1");
    await expect(calendar.patch("a", { title: "x" }, "a-etag")).rejects.toThrow(
      CalendarConflictError,
    );
    expect((await calendar.patch("a", { title: "x" }, "tag-1")).etag).toBe("tag-2");
  });

  test("no expected etag writes unconditionally", async () => {
    const calendar = fake({ events: [timed("a", at("09:00"), at("10:00"))] });
    calendar.changeBehindBack("a", { title: "theirs" });
    expect((await calendar.patch("a", { title: "mine" }, null)).title).toBe("mine");
  });

  test("a change behind the engine's back issues a new etag", async () => {
    const calendar = fake({ events: [timed("a", at("09:00"), at("10:00"))] });
    calendar.changeBehindBack("a", { start: at("13:00"), end: at("14:00") });
    expect((await calendar.list(WHOLE_WEEK))[0].etag).toBe("tag-1");
    await expect(calendar.patch("a", { title: "x" }, "a-etag")).rejects.toThrow(
      CalendarConflictError,
    );
  });

  test("an id it has never seen is missing", async () => {
    const calendar = fake();
    await expect(calendar.patch("ghost", { title: "x" }, null)).rejects.toThrow(
      CalendarMissingError,
    );
    await expect(calendar.remove("ghost", null)).rejects.toThrow(CalendarMissingError);
    await expect(calendar.restore(timed("ghost", at("09:00"), at("10:00")))).rejects.toThrow(
      CalendarMissingError,
    );
    expect(() => calendar.changeBehindBack("ghost", { title: "x" })).toThrow(CalendarMissingError);
  });

  test("remove takes it out of the list", async () => {
    const calendar = fake({ events: [timed("a", at("09:00"), at("10:00"))] });
    await calendar.remove("a", "a-etag");
    expect(await calendar.list(WHOLE_WEEK)).toEqual([]);
  });

  test("restore brings back its own row, not the copy it was handed", async () => {
    const one = timed("a", at("09:00"), at("10:00"), { location: "the old place" });
    const calendar = fake({ events: [one] });
    await calendar.remove("a", "a-etag");
    const stripped = { ...one, title: "a stripped copy", location: null, id: "a" };
    const back = await calendar.restore(stripped);
    expect(back.id).toBe("a");
    expect(back.title).toBe("a");
    expect(back.location).toBe("the old place");
    expect(back.etag).toBe("tag-1");
    expect((await calendar.list(WHOLE_WEEK)).map((event) => event.id)).toEqual(["a"]);
  });

  test("restoring something that was never removed leaves it alone", async () => {
    const calendar = fake({ events: [timed("a", at("09:00"), at("10:00"))] });
    const back = await calendar.restore(timed("a", at("20:00"), at("21:00")));
    expect(back.start).toBe(at("09:00"));
    expect(back.etag).toBe("a-etag");
  });
});

describe("commit", () => {
  const one = timed("a", at("09:00"), at("10:00"));

  test("a create comes back with the calendar's id in place of the draft's", async () => {
    const calendar = fake({ events: [one] });
    const draft = timed(DRAFT, at("11:00"), at("12:00"), { etag: null });
    const optimistic = applyOp([one], { kind: "create", event: draft });

    const result = await commit(calendar, [one], { kind: "create", event: draft });
    if (!result.ok) throw new Error("expected a success");
    expect(result.change).toEqual({
      kind: "replace",
      id: DRAFT,
      event: { ...draft, id: "made-1", etag: "tag-1" },
    });
    const settled = settle(optimistic, result.change);
    expect(settled.map((event) => event.id)).toEqual(["a", "made-1"]);
    expect(settled).toEqual(await calendar.list(WHOLE_WEEK));
  });

  test("a refused create takes the draft back off the list", async () => {
    const calendar = fake({ readOnlyCalendarIds: ["cal-holidays"] });
    const draft = timed(DRAFT, at("11:00"), at("12:00"), {
      etag: null,
      calendarId: "cal-holidays",
    });
    const optimistic = applyOp([], { kind: "create", event: draft });
    expect(optimistic.map((event) => event.id)).toEqual([DRAFT]);

    const result = await commit(calendar, optimistic, { kind: "create", event: draft });
    if (result.ok) throw new Error("expected a failure");
    expect(result.reason).toBe("read-only");
    expect(settle(optimistic, result.revert)).toEqual([]);
  });

  test("a move comes back with the new etag", async () => {
    const calendar = fake({ events: [one] });
    const op: CalendarOp = {
      kind: "move",
      id: "a",
      start: at("13:00"),
      end: at("14:00"),
      expectEtag: "a-etag",
    };
    const result = await commit(calendar, [one], op);
    if (!result.ok) throw new Error("expected a success");
    const settled = settle(applyOp([one], op), result.change);
    expect(settled[0]).toMatchObject({ start: at("13:00"), end: at("14:00"), etag: "tag-1" });
    expect(settled).toEqual(await calendar.list(WHOLE_WEEK));
  });

  test("a rename and a remove go through", async () => {
    const calendar = fake({ events: [one] });
    const renamed = await commit(calendar, [one], {
      kind: "rename",
      id: "a",
      title: "other",
      expectEtag: "a-etag",
    });
    if (!renamed.ok) throw new Error("expected a success");
    const afterRename = settle([one], renamed.change);
    expect(afterRename[0].title).toBe("other");

    const removed = await commit(calendar, afterRename, {
      kind: "remove",
      id: "a",
      expectEtag: "tag-1",
    });
    if (!removed.ok) throw new Error("expected a success");
    expect(settle(afterRename, removed.change)).toEqual([]);
    expect(await calendar.list(WHOLE_WEEK)).toEqual([]);
  });

  test("a move is sent even when the list it was given already shows it", async () => {
    // The wrong list to pass, but it must not make the write vanish: an edit
    // that looks unchanged against THIS list is still an edit to the calendar.
    const calendar = fake({ events: [one] });
    const op: CalendarOp = {
      kind: "move",
      id: "a",
      start: at("13:00"),
      end: at("14:00"),
      expectEtag: "a-etag",
    };
    const optimistic = applyOp([one], op);
    expect(optimistic[0].start).toBe(at("13:00"));
    const result = await commit(calendar, optimistic, op);
    if (!result.ok) throw new Error("expected a success");
    expect((await calendar.list(WHOLE_WEEK))[0].start).toBe(at("13:00"));
    expect(settle(optimistic, result.change)).toEqual(await calendar.list(WHOLE_WEEK));
  });

  test("an edit to a draft that changes nothing is reported as nothing", async () => {
    let asked = 0;
    const draft = draftAt(DAY, 11 * 60, 12 * 60, ZONE, "cal-a");
    const port = counting(fake(), () => (asked += 1));
    const result = await commit(port, [draft], {
      kind: "rename",
      id: draft.id,
      title: draft.title,
      expectEtag: null,
    });
    if (!result.ok) throw new Error("expected a success");
    expect(result.change).toEqual({ kind: "none" });
    expect(asked).toBe(0);
  });

  test("a conflict puts the old values back and leaves the calendar alone", async () => {
    const calendar = fake({ events: [one] });
    calendar.changeBehindBack("a", { title: "theirs" });
    const op: CalendarOp = {
      kind: "move",
      id: "a",
      start: at("13:00"),
      end: at("14:00"),
      expectEtag: "a-etag",
    };
    const result = await commit(calendar, [one], op);
    if (result.ok) throw new Error("expected a failure");
    expect(result.reason).toBe("conflict");
    expect(settle(applyOp([one], op), result.revert)).toEqual([one]);
    expect((await calendar.list(WHOLE_WEEK))[0].start).toBe(at("09:00"));
  });

  test("moving an event someone deleted takes it off the list", async () => {
    const calendar = fake({ events: [one] });
    calendar.removeBehindBack("a");
    const op: CalendarOp = {
      kind: "move",
      id: "a",
      start: at("13:00"),
      end: at("14:00"),
      expectEtag: "a-etag",
    };
    const result = await commit(calendar, [one], op);
    if (result.ok) throw new Error("expected a failure");
    expect(result.reason).toBe("missing");
    expect(settle(applyOp([one], op), result.revert)).toEqual([]);
  });

  test("removing an event someone already deleted is a success", async () => {
    const calendar = fake({ events: [one] });
    calendar.removeBehindBack("a");
    const result = await commit(calendar, [one], { kind: "remove", id: "a", expectEtag: "a-etag" });
    if (!result.ok) throw new Error("expected a success");
    expect(result.change).toEqual({ kind: "remove", id: "a" });
    expect(settle([one], result.change)).toEqual([]);
  });

  test("it takes the list from before the op, and a removal shows why", async () => {
    let asked = 0;
    const calendar = fake({ events: [one] });
    const port = counting(calendar, () => (asked += 1));
    const op: CalendarOp = { kind: "remove", id: "a", expectEtag: "a-etag" };
    const optimistic = applyOp([one], op);
    expect(optimistic).toEqual([]);

    // Handing it the optimistic list is the trap: the event is already gone
    // from it, so nothing reaches the calendar and the event would live on in
    // Google forever.
    const wrong = await commit(port, optimistic, op);
    if (wrong.ok) throw new Error("expected a failure");
    expect(wrong.reason).toBe("missing");
    expect(asked).toBe(0);
    expect((await calendar.list(WHOLE_WEEK)).map((event) => event.id)).toEqual(["a"]);

    const right = await commit(port, [one], op);
    if (!right.ok) throw new Error("expected a success");
    expect(asked).toBe(1);
    expect(await calendar.list(WHOLE_WEEK)).toEqual([]);
  });

  test("a draft is edited and discarded without the calendar hearing of it", async () => {
    let asked = 0;
    const draft = draftAt(DAY, 11 * 60, 12 * 60, ZONE, "cal-a");
    const port = counting(fake(), () => (asked += 1));
    const list = applyOp([one], { kind: "create", event: draft });

    const renamed = await commit(port, list, {
      kind: "rename",
      id: draft.id,
      title: "a name",
      expectEtag: null,
    });
    if (!renamed.ok) throw new Error("expected a success");
    const afterRename = settle(list, renamed.change);
    expect(find(afterRename, draft.id).title).toBe("a name");

    const dropped = await commit(port, afterRename, {
      kind: "remove",
      id: draft.id,
      expectEtag: null,
    });
    if (!dropped.ok) throw new Error("expected a success");
    expect(settle(afterRename, dropped.change).map((event) => event.id)).toEqual(["a"]);
    expect(asked).toBe(0);
  });

  test("a restored draft never reaches the calendar either", async () => {
    let asked = 0;
    const draft = draftAt(DAY, 11 * 60, 12 * 60, ZONE, "cal-a");
    const port = counting(fake(), () => (asked += 1));
    const result = await commit(port, [], { kind: "restore", event: draft });
    if (!result.ok) throw new Error("expected a success");
    expect(settle([], result.change).map((event) => event.id)).toEqual([draft.id]);
    expect(asked).toBe(0);
  });

  test("an undo still aimed at a draft whose create has landed is missing", async () => {
    const calendar = fake();
    const draft = draftAt(DAY, 11 * 60, 12 * 60, ZONE, "cal-a");
    const created = await commit(calendar, [], { kind: "create", event: draft });
    if (!created.ok) throw new Error("expected a success");
    const list = settle([], created.change);
    expect(list.map((event) => event.id)).toEqual(["made-1"]);

    const stale = await commit(calendar, list, {
      kind: "remove",
      id: draft.id,
      expectEtag: null,
    });
    if (stale.ok) throw new Error("expected a failure");
    expect(stale.reason).toBe("missing");
    expect(settle(list, stale.revert)).toBe(list);
  });

  test("an undo of a real deletion restores it under its own id", async () => {
    const calendar = fake({ events: [one] });
    const removal: CalendarOp = { kind: "remove", id: "a", expectEtag: "a-etag" };
    const gone = await commit(calendar, [one], removal);
    if (!gone.ok) throw new Error("expected a success");
    const emptied = settle([one], gone.change);

    const undo = invertOp([one], removal);
    if (undo === null) throw new Error("expected an inverse");
    const back = await commit(calendar, emptied, undo);
    if (!back.ok) throw new Error("expected a success");
    const settled = settle(emptied, back.change);
    expect(settled.map((event) => event.id)).toEqual(["a"]);
    expect(settled[0].etag).toBe("tag-1");
    expect(settled).toEqual(await calendar.list(WHOLE_WEEK));
  });

  test("a read only event is reported, and the port is not asked", async () => {
    let asked = 0;
    const locked = timed("r", at("09:00"), at("10:00"), { editable: false });
    const port = counting(fake({ events: [locked] }), () => (asked += 1));
    const result = await commit(port, [locked], {
      kind: "rename",
      id: "r",
      title: "x",
      expectEtag: null,
    });
    expect(asked).toBe(0);
    if (result.ok) throw new Error("expected a failure");
    expect(result.reason).toBe("read-only");
    expect(result.revert).toEqual({ kind: "none" });
  });

  test("an id the list does not hold is missing without asking the port", async () => {
    let asked = 0;
    const port = counting(fake(), () => (asked += 1));
    const result = await commit(port, [], { kind: "remove", id: "ghost", expectEtag: null });
    expect(asked).toBe(0);
    if (result.ok) throw new Error("expected a failure");
    expect(result.reason).toBe("missing");
  });

  test("the read only calendar's own refusal is reported too", async () => {
    const calendar = fake({
      events: [timed("a", at("09:00"), at("10:00"), { calendarId: "cal-holidays" })],
      readOnlyCalendarIds: ["cal-holidays"],
    });
    // Editable as far as the list in front of the user knows, so the refusal
    // can only come from the calendar itself.
    const local = [timed("a", at("09:00"), at("10:00"), { calendarId: "cal-holidays" })];
    const result = await commit(calendar, local, {
      kind: "rename",
      id: "a",
      title: "x",
      expectEtag: "a-etag",
    });
    if (result.ok) throw new Error("expected a failure");
    expect(result.reason).toBe("read-only");
    expect(settle(local, result.revert)).toEqual(local);
  });

  test("any other failure is not swallowed", async () => {
    const port: CalendarPort = {
      list: async () => [],
      insert: async () => {
        throw new Error("the network went away");
      },
      restore: async () => {
        throw new Error("the network went away");
      },
      patch: async () => {
        throw new Error("the network went away");
      },
      remove: async () => {
        throw new Error("the network went away");
      },
    };
    await expect(
      commit(port, [one], { kind: "rename", id: "a", title: "x", expectEtag: null }),
    ).rejects.toThrow("the network went away");
  });
});

/** The same calendar, counting how many writes actually reached it. */
function counting(calendar: FakeCalendar, tick: () => void): CalendarPort {
  return {
    list: (range) => calendar.list(range),
    insert: (event) => {
      tick();
      return calendar.insert(event);
    },
    restore: (event) => {
      tick();
      return calendar.restore(event);
    },
    patch: (id, changes, expectEtag) => {
      tick();
      return calendar.patch(id, changes, expectEtag);
    },
    remove: (id, expectEtag) => {
      tick();
      return calendar.remove(id, expectEtag);
    },
  };
}

function deferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** The calendar, with each event's write held until its gate is opened. */
function gated(calendar: FakeCalendar, gates: Map<string, Promise<void>>): CalendarPort {
  const wait = async (id: string) => {
    await gates.get(id);
  };
  return {
    list: (range) => calendar.list(range),
    insert: (event) => calendar.insert(event),
    restore: (event) => calendar.restore(event),
    patch: async (id, changes, expectEtag) => {
      await wait(id);
      return calendar.patch(id, changes, expectEtag);
    },
    remove: async (id, expectEtag) => {
      await wait(id);
      return calendar.remove(id, expectEtag);
    },
  };
}

describe("two commits in flight", () => {
  const one = timed("a", at("09:00"), at("10:00"));
  const two = timed("b", at("11:00"), at("12:00"));
  const moveA: CalendarOp = {
    kind: "move",
    id: "a",
    start: at("13:00"),
    end: at("14:00"),
    expectEtag: "a-etag",
  };
  const renameB: CalendarOp = { kind: "rename", id: "b", title: "other", expectEtag: "b-etag" };

  /**
   * Both edits are made optimistically, both are sent, and each one's outcome
   * is settled on the list as it stands when it arrives. Whichever order they
   * finish in, the list has to end up as the calendar itself holds it.
   */
  const bothWays = async (first: "a" | "b") => {
    const calendar = fake({ events: [one, two] });
    const gateA = deferred();
    const gateB = deferred();
    const port = gated(
      calendar,
      new Map([
        ["a", gateA.promise],
        ["b", gateB.promise],
      ]),
    );
    const before = canonicalEvents([one, two]);
    const onScreen = applyOp(applyOp(before, moveA), renameB);

    const sentA = commit(port, before, moveA);
    const sentB = commit(port, applyOp(before, moveA), renameB);
    if (first === "a") {
      gateA.open();
      gateB.open();
    } else {
      gateB.open();
      gateA.open();
    }
    const [resultA, resultB] = await Promise.all([sentA, sentB]);

    let events = onScreen;
    for (const result of first === "a" ? [resultA, resultB] : [resultB, resultA]) {
      events = settle(events, result.ok ? result.change : result.revert);
    }
    return { events, held: await calendar.list(WHOLE_WEEK) };
  };

  test("the list ends as the calendar holds it, whichever finishes first", async () => {
    for (const first of ["a", "b"] as const) {
      const { events, held } = await bothWays(first);
      expect(events).toEqual(held);
      // Not just the positions: every etag is the one the calendar issued, so
      // the next conditional edit of either event is not a false conflict.
      expect(events.map((event) => event.etag)).toEqual(held.map((event) => event.etag));
      expect(find(events, "a").start).toBe(at("13:00"));
      expect(find(events, "b").title).toBe("other");
    }
  });

  test("one refused and one accepted do not disturb each other", async () => {
    const calendar = fake({ events: [one, two] });
    calendar.changeBehindBack("a", { title: "theirs" });
    const gateA = deferred();
    const gateB = deferred();
    const port = gated(
      calendar,
      new Map([
        ["a", gateA.promise],
        ["b", gateB.promise],
      ]),
    );
    const before = canonicalEvents([one, two]);
    const onScreen = applyOp(applyOp(before, moveA), renameB);

    const sentA = commit(port, before, moveA);
    const sentB = commit(port, applyOp(before, moveA), renameB);
    gateB.open();
    gateA.open();
    const [resultA, resultB] = await Promise.all([sentA, sentB]);
    expect(resultA.ok).toBe(false);
    expect(resultB.ok).toBe(true);

    let events = onScreen;
    for (const result of [resultB, resultA]) {
      events = settle(events, result.ok ? result.change : result.revert);
    }
    const held = await calendar.list(WHOLE_WEEK);
    // The refused event is back where the calendar has it, and the accepted
    // one carries the etag the calendar issued rather than the one it had
    // before this pair of commits.
    expect(find(events, "a").start).toBe(find(held, "a").start);
    expect(find(events, "b").etag).toBe(find(held, "b").etag);
    // Its etag is stale, though: a refusal cannot know what the other side
    // holds, so the list is only right again once it is re-read.
    expect(find(events, "a").etag).not.toBe(find(held, "a").etag);
  });
});
