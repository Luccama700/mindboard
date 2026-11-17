// Task 6, the mappers: row to domain and back, with zod validating every read.
// The mappers are the only place that knows a column name, so a malformed row
// has to come back as a RowShapeError naming the table AND the column rather
// than as an undefined three frames later.
//
// Instants are normalised on read. PostgREST hands timestamptz back as
// "+00:00" and sometimes with microseconds, while a caller may write an instant
// carrying any offset, so the one thing the engine must never do is compare two
// instants as strings. Normalising on read is what makes that safe, and it is
// why the memory store reads through these same mappers.

import { describe, expect, test } from "vitest";

import {
  RowShapeError,
  assertChatMessageId,
  assertErrorClass,
  assertOptionId,
  assertPairingHash,
  assertWindow,
  fromAlertRow,
  fromAskRow,
  fromBlockRow,
  fromChannelRow,
  fromDayRow,
  fromExpectationRow,
  fromFeedRunRow,
  fromOutboxRow,
  fromRulesRow,
  parseRulesDocument,
  toAlertRow,
  toAskRow,
  toBlockRow,
  toChannelRow,
  toDayRow,
  toExpectationRow,
  toFeedRunRow,
  toOutboxRow,
  toRulesRow,
} from "@/app/lib/v2/store/mappers";
import type { StoredExpectation } from "@/app/lib/v2/store/types";
import type { Alert, Ask, Block, FeedRun } from "@/app/lib/v2/types";

const USER = "11111111-1111-4111-8111-111111111111";
const ASK_ID = "33333333-3333-4333-8333-333333333333";
const OUT_ID = "44444444-4444-4444-8444-444444444444";
const ALERT_ID = "55555555-5555-4555-8555-555555555555";
const TASK_ID = "66666666-6666-4666-8666-666666666666";

const ask: Ask = {
  id: ASK_ID,
  userId: USER,
  kind: "slip",
  topic: `task:${TASK_ID}`,
  text: "Did that block happen?",
  options: [
    { id: "done", label: "Done", effect: { type: "block.done", blockId: "b1", fraction: 1 } },
    { id: "half", label: "Half", effect: { type: "block.done", blockId: "b1", fraction: 0.5 } },
    { id: "later", label: "Later", effect: { type: "block.reschedule", blockId: "b1", to: "later-today" } },
    { id: "drop", label: "Drop", effect: { type: "block.drop", blockId: "b1" } },
    { id: "none", label: "Skip", effect: { type: "none" } },
  ],
  defaultOptionId: "none",
  timeCritical: true,
  openedAt: "2026-11-09T17:00:00.000Z",
  remindAt: "2026-11-09T17:30:00.000Z",
  remindedAt: null,
  expiresAt: "2026-11-09T18:00:00.000Z",
  status: "open",
  answeredOptionId: null,
  answeredAt: null,
  assumed: false,
  dedupeKey: "slip:b1",
};

const block: Block = {
  id: "2026-11-09:focus:abc",
  date: "2026-11-09",
  start: "2026-11-09T17:00:00.000Z",
  end: "2026-11-09T17:50:00.000Z",
  kind: "focus",
  lane: "lane-a",
  taskId: TASK_ID,
  title: "Read chapter two",
  state: "planned",
  reason: "lane-next",
};

describe("v2 store mappers: round trips", () => {
  test("an ask survives row and back, including every effect shape", () => {
    expect(fromAskRow(toAskRow(USER, ask))).toEqual(ask);
  });

  test("a block survives row and back, and keeps its colon-bearing id", () => {
    const row = toBlockRow(USER, block);
    expect(row.id).toBe("2026-11-09:focus:abc");
    expect(row.user_id).toBe(USER);
    expect(fromBlockRow(row)).toEqual(block);
  });

  test("a day record survives row and back", () => {
    const day = {
      userId: USER,
      date: "2026-11-09",
      energy: "low" as const,
      energyAssumed: true,
      mode: "rough-day" as const,
      plannedAt: "2026-11-09T17:05:00.000Z",
      morningSentAt: null,
      dropped: [{ candidateId: TASK_ID, reason: "no-capacity" }],
      leaveBy: [{ fixedId: "ev-1", at: "2026-11-09T19:40:00.000Z" }],
    };
    expect(fromDayRow(toDayRow(USER, day))).toEqual(day);
  });

  test("an outbox item survives row and back", () => {
    const item = {
      id: OUT_ID,
      userId: USER,
      kind: "ask" as const,
      dedupeKey: `ask:${ASK_ID}`,
      delivery: "interrupt" as const,
      message: {
        text: "Did that block happen?",
        buttons: [{ label: "Done", askId: ASK_ID, optionId: "done" }],
      },
      askId: ASK_ID,
      createdAt: "2026-11-09T17:00:00.000Z",
      claimedAt: null,
      sentAt: null,
      chatMessageId: null,
      error: null,
    };
    expect(fromOutboxRow(toOutboxRow(USER, item))).toEqual(item);
  });

  test("a feed run survives row and back, and a running one keeps a null finish", () => {
    const run: FeedRun = {
      feed: "calendar",
      startedAt: "2026-11-09T17:00:00.000Z",
      finishedAt: null,
      status: "ok",
      count: 0,
      errorClass: null,
    };
    expect(fromFeedRunRow(toFeedRunRow(USER, run))).toEqual(run);
    const done: FeedRun = { ...run, finishedAt: "2026-11-09T17:00:02.000Z", count: 7 };
    expect(fromFeedRunRow(toFeedRunRow(USER, done))).toEqual(done);
  });

  test("an expectation survives row and back, with and without active hours", () => {
    const always: StoredExpectation = {
      feed: "calendar",
      label: "Calendar",
      everyMinutes: 30,
      graceMinutes: 10,
      minCount: 0,
      activeHours: null,
      enabledAt: "2026-11-01T00:00:00.000Z",
    };
    expect(fromExpectationRow(toExpectationRow(USER, always))).toEqual(always);
    const windowed: StoredExpectation = {
      ...always,
      activeHours: { from: "08:00", to: "22:00" },
    };
    expect(fromExpectationRow(toExpectationRow(USER, windowed))).toEqual(windowed);
  });

  test("an alert survives row and back, feeds included", () => {
    const alert: Alert = {
      id: ALERT_ID,
      cause: "auth-expired",
      feeds: ["calendar", "tasks"],
      since: "2026-11-09T09:00:00.000Z",
      step: 1,
      lastSentAt: "2026-11-09T11:00:00.000Z",
      status: "open",
    };
    expect(fromAlertRow(toAlertRow(USER, alert))).toEqual(alert);
  });

  test("a channel link survives row and back", () => {
    const link = { userId: USER, chatId: "4242", linkedAt: "2026-11-02T10:00:00.000Z" };
    expect(fromChannelRow(toChannelRow(USER, link))).toEqual(link);
    const unlinked = { userId: USER, chatId: null, linkedAt: null };
    expect(fromChannelRow(toChannelRow(USER, unlinked))).toEqual(unlinked);
  });

  test("an engine user survives row and back", () => {
    const rules = {
      planner: { timeZone: "Asia/Tokyo", bufferMinutes: 15 },
      lanes: [
        { key: "lane-a", label: "Lane A", color: "#b5ff3c", groupIds: ["g1"], hardDates: true },
      ],
      feedLabels: { calendar: "Calendar" },
    };
    const row = toRulesRow(USER, rules, true);
    expect(row.enabled).toBe(true);
    expect(fromRulesRow(row)).toEqual({ userId: USER, timeZone: "Asia/Tokyo", rules });
  });
});

describe("v2 store mappers: instants", () => {
  test("a postgrest offset instant is normalised, not compared as text", () => {
    const row = { ...toAskRow(USER, ask), opened_at: "2026-11-09 17:00:00+00:00" };
    expect(fromAskRow(row).openedAt).toBe("2026-11-09T17:00:00.000Z");
  });

  test("microseconds are cut to milliseconds", () => {
    const row = { ...toAskRow(USER, ask), opened_at: "2026-11-09T17:00:00.123456+00:00" };
    expect(fromAskRow(row).openedAt).toBe("2026-11-09T17:00:00.123Z");
  });

  test("a non-UTC offset keeps its instant", () => {
    const row = { ...toAskRow(USER, ask), opened_at: "2026-11-09T09:00:00-08:00" };
    expect(fromAskRow(row).openedAt).toBe("2026-11-09T17:00:00.000Z");
  });

  test("a date column stays a date key and is never widened to an instant", () => {
    const row = { ...toBlockRow(USER, block), date: "2026-11-09" };
    expect(fromBlockRow(row).date).toBe("2026-11-09");
  });
});

describe("v2 store mappers: malformed rows", () => {
  test("a bad enum names its table and column", () => {
    const row = { ...toBlockRow(USER, block), kind: "nap" };
    expect(() => fromBlockRow(row)).toThrow(RowShapeError);
    try {
      fromBlockRow(row);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RowShapeError);
      const shape = error as RowShapeError;
      expect(shape.table).toBe("v2_blocks");
      expect(shape.column).toBe("kind");
      expect(shape.message).toContain("v2_blocks");
      expect(shape.message).toContain("kind");
    }
  });

  test("a bad nested jsonb payload names the column it came from", () => {
    const row = { ...toAskRow(USER, ask), options: [{ id: "x", label: "X", effect: { type: "nope" } }] };
    try {
      fromAskRow(row);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RowShapeError);
      expect((error as RowShapeError).table).toBe("v2_asks");
      expect((error as RowShapeError).column).toContain("options");
    }
  });

  test("an unparseable instant is a row shape error, not a NaN", () => {
    const row = { ...toAskRow(USER, ask), expires_at: "soon" };
    try {
      fromAskRow(row);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RowShapeError);
      expect((error as RowShapeError).column).toBe("expires_at");
    }
  });

  test("a uuid column is checked as a uuid, because Postgres would answer 22P02", () => {
    // Memory has to refuse exactly what the table refuses, or an engine test
    // passes on an id production rejects.
    for (const [table, column, row] of [
      ["v2_asks", "id", { ...toAskRow(USER, ask), id: "ask-1" }],
      ["v2_asks", "user_id", { ...toAskRow(USER, ask), user_id: "me" }],
      ["v2_blocks", "task_id", { ...toBlockRow(USER, block), task_id: "task-1" }],
    ] as const) {
      try {
        if (table === "v2_blocks") fromBlockRow(row);
        else fromAskRow(row);
        throw new Error(`should have thrown for ${table}.${column}`);
      } catch (error) {
        expect(error, `${table}.${column}`).toBeInstanceOf(RowShapeError);
        expect((error as RowShapeError).table).toBe(table);
        expect((error as RowShapeError).column).toBe(column);
      }
    }
  });

  test("a block id is text, so a colon-bearing id is not a uuid failure", () => {
    expect(fromBlockRow(toBlockRow(USER, block)).id).toBe("2026-11-09:focus:abc");
  });

  test("an option id longer than the contract allows is refused at the door", () => {
    // 12 characters is the cap in types.ts, because the id has to survive a
    // round trip through a Telegram callback payload. Postgres does not check
    // inside jsonb, so this is the only place it can be caught.
    const row = {
      ...toAskRow(USER, ask),
      options: [{ id: "thirteenchars", label: "X", effect: { type: "none" } }],
    };
    expect(() => fromAskRow(row)).toThrow(RowShapeError);
  });

  test("a missing required column is a row shape error", () => {
    const row = { ...toAlertRow(USER, {
      id: ALERT_ID,
      cause: "auth-expired",
      feeds: [],
      since: "2026-11-09T09:00:00.000Z",
      step: 0,
      lastSentAt: null,
      status: "open",
    }) } as Record<string, unknown>;
    delete row.cause;
    try {
      fromAlertRow(row);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RowShapeError);
      expect((error as RowShapeError).table).toBe("v2_alerts");
      expect((error as RowShapeError).column).toBe("cause");
    }
  });
});

describe("v2 store mappers: constraints the table also states", () => {
  test("a block that ends before it starts is a row shape error on ends_at", () => {
    // 0066's v2_blocks_window. Without it the memory store would accept a block
    // Postgres answers with a 23514, and an engine test would pass on
    // behaviour production does not have.
    const row = { ...toBlockRow(USER, block), ends_at: "2026-11-09T16:00:00.000Z" };
    try {
      fromBlockRow(row);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RowShapeError);
      expect((error as RowShapeError).table).toBe("v2_blocks");
      expect((error as RowShapeError).column).toBe("ends_at");
    }
  });

  test("a zero length block is allowed, because the constraint is >=", () => {
    const at = "2026-11-09T17:00:00.000Z";
    expect(fromBlockRow({ ...toBlockRow(USER, block), starts_at: at, ends_at: at }).end).toBe(at);
  });

  test("assertWindow matches that constraint", () => {
    expect(() => assertWindow("2026-11-09T17:00:00.000Z", "2026-11-09T17:50:00.000Z")).not.toThrow();
    expect(() => assertWindow("2026-11-09T17:00:00.000Z", "2026-11-09T16:00:00.000Z")).toThrow(
      RowShapeError,
    );
    expect(() => assertWindow("tomorrow", "2026-11-09T17:50:00.000Z")).toThrow(RowShapeError);
  });

  test("assertOptionId holds the twelve character contract", () => {
    expect(assertOptionId("did")).toBe("did");
    expect(assertOptionId("twelvechars!")).toBe("twelvechars!");
    for (const bad of ["", "thirteenchars"]) {
      expect(() => assertOptionId(bad), bad).toThrow(RowShapeError);
    }
  });

  test("assertErrorClass and assertChatMessageId refuse the empty string", () => {
    expect(assertErrorClass("bot-blocked")).toBe("bot-blocked");
    expect(() => assertErrorClass("")).toThrow(RowShapeError);
    expect(assertChatMessageId(null)).toBeNull();
    expect(assertChatMessageId("991")).toBe("991");
    expect(() => assertChatMessageId("")).toThrow(RowShapeError);
  });

  test("assertPairingHash takes a digest and nothing else", () => {
    const digest = "a".repeat(64);
    expect(assertPairingHash(digest)).toBe(digest);
    for (const bad of ["", "hunter2", "A".repeat(64), "a".repeat(63), `${"a".repeat(63)}g`]) {
      expect(() => assertPairingHash(bad), JSON.stringify(bad)).toThrow(RowShapeError);
    }
    try {
      assertPairingHash("hunter2");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as RowShapeError).table).toBe("v2_channels");
      expect((error as RowShapeError).column).toBe("pairing_hash");
    }
  });
});

describe("parseRulesDocument", () => {
  test("fills every absent part so an empty row still parses", () => {
    expect(parseRulesDocument({})).toEqual({ planner: {}, lanes: [], feedLabels: {} });
  });

  test("keeps the planner object exactly as stored", () => {
    // The planner's own parser (app/lib/v2/rules.ts) validates it later. Here it
    // is opaque data, so an unknown key must survive rather than be stripped.
    const doc = parseRulesDocument({
      planner: { bufferMinutes: 15, somethingNewerThanThisCode: 3 },
    });
    expect(doc.planner).toEqual({ bufferMinutes: 15, somethingNewerThanThisCode: 3 });
  });

  test("validates the lane list", () => {
    const doc = parseRulesDocument({
      lanes: [
        { key: "lane-a", label: "Lane A", color: "#b5ff3c", groupIds: ["g1", "g2"], hardDates: true },
      ],
    });
    expect(doc.lanes).toEqual([
      { key: "lane-a", label: "Lane A", color: "#b5ff3c", groupIds: ["g1", "g2"], hardDates: true },
    ]);
    expect(() => parseRulesDocument({ lanes: [{ key: "lane-a" }] })).toThrow(RowShapeError);
  });

  test("a lane with no hardDates is a lane whose dates are not deadlines", () => {
    // The field arrived after the first documents were written, so silence has
    // to read as false rather than as a malformed row.
    const doc = parseRulesDocument({
      lanes: [{ key: "lane-a", label: "Lane A", color: "#b5ff3c", groupIds: [] }],
    });
    expect(doc.lanes[0].hardDates).toBe(false);
  });

  test("a hardDates that is not a boolean is a row shape error naming the lane", () => {
    try {
      parseRulesDocument({
        lanes: [{ key: "lane-a", label: "Lane A", color: "#b5ff3c", groupIds: [], hardDates: "yes" }],
      });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RowShapeError);
      expect((error as RowShapeError).table).toBe("v2_rules");
      expect((error as RowShapeError).column).toBe("lanes.0.hardDates");
    }
  });

  test("hardDates survives the engine user round trip", () => {
    const rules = {
      planner: {},
      lanes: [
        { key: "lane-a", label: "A", color: "#111111", groupIds: ["g1"], hardDates: true },
        { key: "lane-b", label: "B", color: "#222222", groupIds: [], hardDates: false },
      ],
      feedLabels: {},
    };
    expect(fromRulesRow(toRulesRow(USER, rules, true)).rules.lanes).toEqual(rules.lanes);
  });

  test("rejects a document that is not an object", () => {
    expect(() => parseRulesDocument(null)).toThrow(RowShapeError);
    expect(() => parseRulesDocument("{}")).toThrow(RowShapeError);
  });

  test("an invalid zone falls back to UTC rather than throwing", () => {
    // The zone is the one planner field the store itself projects, so a bad one
    // must not stop the engine reading the account.
    const row = toRulesRow(USER, { planner: { timeZone: "Mars/Olympus" }, lanes: [], feedLabels: {} }, true);
    expect(fromRulesRow(row).timeZone).toBe("UTC");
  });

  test("no zone at all is UTC", () => {
    const row = toRulesRow(USER, { planner: {}, lanes: [], feedLabels: {} }, false);
    expect(fromRulesRow(row).timeZone).toBe("UTC");
  });
});
