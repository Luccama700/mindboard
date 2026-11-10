// Task 6, the memory stores: the semantics every engine test runs on, and the
// same semantics the Supabase stores implement with one conditional statement
// each. The three that matter most are the ones that make a retry harmless:
// an ask is opened once per key, answered once; an outbox item is claimed once;
// and a plan never rewrites a block the user already touched.
//
// Every assertion here is a statement about the Supabase stores too. If one of
// them stops being true in memory, the engine tests stop testing production.

import { describe, expect, test } from "vitest";

import { createMemoryStores } from "@/app/lib/v2/store/memory";
import { RowShapeError } from "@/app/lib/v2/store/mappers";
import type { OutboxItem, StoredExpectation } from "@/app/lib/v2/store/types";
import type { Alert, Ask, Block, FeedRun, OutgoingMessage } from "@/app/lib/v2/types";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ASK_1 = "33333333-3333-4333-8333-333333333333";
const ASK_2 = "33333333-3333-4333-8333-333333333334";
const OUT_1 = "44444444-4444-4444-8444-444444444444";
const OUT_2 = "44444444-4444-4444-8444-444444444445";
const ALERT_1 = "55555555-5555-4555-8555-555555555555";
const ALERT_2 = "55555555-5555-4555-8555-555555555556";
const TASK_1 = "66666666-6666-4666-8666-666666666666";

const DATE = "2026-11-09";

// 0066 constrains pairing_hash to 64 lowercase hex characters, so a raw code
// cannot be stored by mistake. The store refuses anything else.
const HASH_1 = "a".repeat(64);
const HASH_2 = `b${"c".repeat(63)}`;

function anAsk(over: Partial<Ask> = {}): Ask {
  return {
    id: ASK_1,
    userId: A,
    kind: "slip",
    topic: `task:${TASK_1}`,
    text: "Did that block happen?",
    options: [
      { id: "done", label: "Done", effect: { type: "block.done", blockId: "b1", fraction: 1 } },
      { id: "drop", label: "Drop", effect: { type: "block.drop", blockId: "b1" } },
    ],
    defaultOptionId: "drop",
    timeCritical: true,
    openedAt: "2026-11-09T17:00:00.000Z",
    remindAt: "2026-11-09T17:20:00.000Z",
    remindedAt: null,
    expiresAt: "2026-11-09T17:30:00.000Z",
    status: "open",
    answeredOptionId: null,
    answeredAt: null,
    assumed: false,
    dedupeKey: "slip:b1",
    ...over,
  };
}

function aBlock(over: Partial<Block> = {}): Block {
  return {
    id: `${DATE}:focus:one`,
    date: DATE,
    start: "2026-11-09T17:00:00.000Z",
    end: "2026-11-09T17:50:00.000Z",
    kind: "focus",
    lane: "lane-a",
    taskId: null,
    title: "Focus",
    state: "planned",
    reason: "lane-next",
    ...over,
  };
}

const MESSAGE: OutgoingMessage = { text: "Morning", buttons: [] };

function anItem(over: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id: OUT_1,
    userId: A,
    kind: "morning",
    dedupeKey: `morning:${DATE}`,
    delivery: "interrupt",
    message: MESSAGE,
    askId: null,
    createdAt: "2026-11-09T08:00:00.000Z",
    claimedAt: null,
    sentAt: null,
    chatMessageId: null,
    error: null,
    ...over,
  };
}

const RULES = { planner: { timeZone: "Asia/Tokyo" }, lanes: [], feedLabels: {} };

describe("memory users store", () => {
  test("listEnabled returns the ids of enabled accounts only", async () => {
    const stores = createMemoryStores();
    await stores.users.save(A, { rules: RULES, enabled: true });
    await stores.users.save(B, { rules: RULES, enabled: false });
    expect(await stores.users.listEnabled()).toEqual([A]);
  });

  test("get projects the zone out of the planner and keeps the document", async () => {
    const stores = createMemoryStores();
    await stores.users.save(A, { rules: RULES, enabled: true });
    const user = await stores.users.get(A);
    expect(user).toEqual({ userId: A, timeZone: "Asia/Tokyo", rules: RULES });
    expect(await stores.users.get(B)).toBeNull();
  });

  test("save checks the envelope and leaves the planner opaque", async () => {
    const stores = createMemoryStores();
    // A lane missing its label is a malformed document, refused on the way in.
    await expect(
      stores.users.save(A, {
        rules: { planner: {}, lanes: [{ key: "lane-a" }], feedLabels: {} } as never,
        enabled: true,
      }),
    ).rejects.toThrow(RowShapeError);
    expect(await stores.users.get(A)).toBeNull();

    // The planner half keeps a key this code has never heard of.
    await stores.users.save(A, {
      rules: { planner: { newerThanThisCode: 7 }, lanes: [], feedLabels: {} } as never,
      enabled: true,
    });
    expect((await stores.users.get(A))?.rules.planner).toEqual({ newerThanThisCode: 7 });
  });

  test("save replaces the stored document", async () => {
    const stores = createMemoryStores();
    await stores.users.save(A, { rules: RULES, enabled: true });
    await stores.users.save(A, { rules: { planner: {}, lanes: [], feedLabels: {} }, enabled: false });
    expect(await stores.users.listEnabled()).toEqual([]);
    expect((await stores.users.get(A))?.timeZone).toBe("UTC");
  });
});

describe("memory days store", () => {
  test("a patch creates the row with the documented defaults", async () => {
    const stores = createMemoryStores();
    const day = await stores.days.patch(A, DATE, { plannedAt: "2026-11-09T17:05:00.000Z" });
    expect(day).toEqual({
      userId: A,
      date: DATE,
      energy: null,
      energyAssumed: false,
      mode: "normal",
      plannedAt: "2026-11-09T17:05:00.000Z",
      morningSentAt: null,
      dropped: [],
      leaveBy: [],
    });
  });

  test("a second patch changes only the fields it names", async () => {
    const stores = createMemoryStores();
    await stores.days.patch(A, DATE, { energy: "good", energyAssumed: false });
    const day = await stores.days.patch(A, DATE, { morningSentAt: "2026-11-09T08:00:00.000Z" });
    expect(day.energy).toBe("good");
    expect(day.morningSentAt).toBe("2026-11-09T08:00:00.000Z");
  });

  test("days are per user and per date", async () => {
    const stores = createMemoryStores();
    await stores.days.patch(A, DATE, { energy: "low" });
    expect(await stores.days.get(B, DATE)).toBeNull();
    expect(await stores.days.get(A, "2026-11-10")).toBeNull();
  });
});

describe("memory blocks store", () => {
  test("replacePlanned stores a plan and reads it back for the date", async () => {
    const stores = createMemoryStores();
    await stores.blocks.replacePlanned(A, DATE, [aBlock(), aBlock({ id: `${DATE}:gym:x`, kind: "gym" })]);
    const stored = await stores.blocks.listForDate(A, DATE);
    expect(stored.map((b) => b.id)).toEqual([`${DATE}:focus:one`, `${DATE}:gym:x`]);
    expect(await stores.blocks.listForDate(B, DATE)).toEqual([]);
  });

  test("replacePlanned never rewrites a started, done or skipped block", async () => {
    const stores = createMemoryStores();
    await stores.blocks.replacePlanned(A, DATE, [
      aBlock({ id: `${DATE}:focus:a` }),
      aBlock({ id: `${DATE}:focus:b` }),
      aBlock({ id: `${DATE}:focus:c` }),
    ]);
    await stores.blocks.setState(A, `${DATE}:focus:a`, "started");
    await stores.blocks.setState(A, `${DATE}:focus:b`, "done");

    // A new plan that moves a and drops b and c entirely.
    await stores.blocks.replacePlanned(A, DATE, [
      aBlock({ id: `${DATE}:focus:a`, start: "2026-11-09T20:00:00.000Z", end: "2026-11-09T20:50:00.000Z" }),
    ]);

    const stored = await stores.blocks.listForDate(A, DATE);
    const byId = new Map(stored.map((b) => [b.id, b]));
    expect(byId.get(`${DATE}:focus:a`)?.state).toBe("started");
    expect(byId.get(`${DATE}:focus:a`)?.start).toBe("2026-11-09T17:00:00.000Z");
    expect(byId.get(`${DATE}:focus:b`)?.state).toBe("done");
    expect(byId.has(`${DATE}:focus:c`)).toBe(false);
  });

  test("replacePlanned rewrites a planned block in place, keeping its id", async () => {
    const stores = createMemoryStores();
    await stores.blocks.replacePlanned(A, DATE, [aBlock()]);
    await stores.blocks.replacePlanned(A, DATE, [
      aBlock({ start: "2026-11-09T21:00:00.000Z", end: "2026-11-09T21:50:00.000Z", reason: "hard-window" }),
    ]);
    const stored = await stores.blocks.listForDate(A, DATE);
    expect(stored).toHaveLength(1);
    expect(stored[0].start).toBe("2026-11-09T21:00:00.000Z");
    expect(stored[0].reason).toBe("hard-window");
  });

  test("replacePlanned touches no other date", async () => {
    const stores = createMemoryStores();
    await stores.blocks.replacePlanned(A, DATE, [aBlock()]);
    await stores.blocks.replacePlanned(A, "2026-11-10", []);
    expect(await stores.blocks.listForDate(A, DATE)).toHaveLength(1);
  });

  test("listOpenBefore returns earlier planned and started blocks only", async () => {
    const stores = createMemoryStores();
    await stores.blocks.replacePlanned(A, "2026-11-07", [
      aBlock({ id: "2026-11-07:focus:a", date: "2026-11-07" }),
      aBlock({ id: "2026-11-07:focus:b", date: "2026-11-07" }),
      aBlock({ id: "2026-11-07:focus:c", date: "2026-11-07" }),
    ]);
    await stores.blocks.setState(A, "2026-11-07:focus:b", "started");
    await stores.blocks.setState(A, "2026-11-07:focus:c", "done");
    await stores.blocks.replacePlanned(A, DATE, [aBlock()]);

    const open = await stores.blocks.listOpenBefore(A, DATE);
    expect(open.map((b) => b.id).sort()).toEqual(["2026-11-07:focus:a", "2026-11-07:focus:b"]);
  });

  test("replacePlanned is all or nothing", async () => {
    const stores = createMemoryStores();
    await stores.blocks.replacePlanned(A, DATE, [aBlock()]);
    // The second block is malformed. The Supabase store sends one statement in
    // one transaction, so nothing lands; memory has to agree, which means
    // checking everything before writing anything.
    await expect(
      stores.blocks.replacePlanned(A, DATE, [
        aBlock({ id: `${DATE}:focus:two` }),
        aBlock({ id: `${DATE}:focus:three`, kind: "nap" as Block["kind"] }),
      ]),
    ).rejects.toThrow(RowShapeError);
    const stored = await stores.blocks.listForDate(A, DATE);
    expect(stored.map((b) => b.id)).toEqual([`${DATE}:focus:one`]);
  });

  test("replacePlanned refuses a block dated somewhere else", async () => {
    const stores = createMemoryStores();
    await expect(
      stores.blocks.replacePlanned(A, DATE, [aBlock({ date: "2026-11-10" })]),
    ).rejects.toThrow(RowShapeError);
    expect(await stores.blocks.listForDate(A, DATE)).toEqual([]);
    expect(await stores.blocks.listForDate(A, "2026-11-10")).toEqual([]);
  });

  test("replacePlanned refuses a block that ends before it starts", async () => {
    const stores = createMemoryStores();
    await expect(
      stores.blocks.replacePlanned(A, DATE, [
        aBlock({ start: "2026-11-09T18:00:00.000Z", end: "2026-11-09T17:00:00.000Z" }),
      ]),
    ).rejects.toThrow(RowShapeError);
    expect(await stores.blocks.listForDate(A, DATE)).toEqual([]);
  });

  test("a plan never writes state, not even the state it was handed", async () => {
    const stores = createMemoryStores();
    await stores.blocks.replacePlanned(A, DATE, [aBlock()]);
    await stores.blocks.replacePlanned(A, DATE, [aBlock({ state: "done" })]);
    expect((await stores.blocks.listForDate(A, DATE))[0].state).toBe("planned");
  });

  test("an id held by a touched row on another date is not available to a plan", async () => {
    const stores = createMemoryStores();
    const shared = "2026-11-07:focus:a";
    await stores.blocks.replacePlanned(A, "2026-11-07", [
      aBlock({ id: shared, date: "2026-11-07" }),
    ]);
    await stores.blocks.setState(A, shared, "started");

    // Same id, new day. The started row records what he did, so the plan does
    // not get to move it.
    await stores.blocks.replacePlanned(A, DATE, [aBlock({ id: shared })]);
    expect(await stores.blocks.listForDate(A, DATE)).toEqual([]);
    const kept = await stores.blocks.listForDate(A, "2026-11-07");
    expect(kept).toHaveLength(1);
    expect(kept[0].state).toBe("started");
  });

  test("setState stores a reason and honours a from guard", async () => {
    const stores = createMemoryStores();
    await stores.blocks.replacePlanned(A, DATE, [aBlock()]);
    const id = `${DATE}:focus:one`;

    const skipped = await stores.blocks.setState(A, id, "skipped", { reason: "slipped twice" });
    expect(skipped?.state).toBe("skipped");
    expect(skipped?.reason).toBe("slipped twice");

    // The tick's "a started block whose end has passed is done" must not fire on
    // a block somebody already skipped.
    expect(await stores.blocks.setState(A, id, "done", { from: "started" })).toBeNull();
    expect((await stores.blocks.listForDate(A, DATE))[0].state).toBe("skipped");

    expect(await stores.blocks.setState(A, "nope", "done")).toBeNull();
    expect(await stores.blocks.setState(B, id, "done")).toBeNull();
  });

  test("setTime moves a planned block and refuses a touched one", async () => {
    const stores = createMemoryStores();
    await stores.blocks.replacePlanned(A, DATE, [aBlock()]);
    const id = `${DATE}:focus:one`;
    const moved = await stores.blocks.setTime(A, id, "2026-11-09T22:00:00.000Z", "2026-11-09T22:50:00.000Z");
    expect(moved?.start).toBe("2026-11-09T22:00:00.000Z");
    expect(moved?.end).toBe("2026-11-09T22:50:00.000Z");

    await stores.blocks.setState(A, id, "started");
    expect(await stores.blocks.setTime(A, id, "2026-11-09T23:00:00.000Z", "2026-11-09T23:50:00.000Z")).toBeNull();
    expect((await stores.blocks.listForDate(A, DATE))[0].start).toBe("2026-11-09T22:00:00.000Z");
  });

  test("setTime refuses a window that ends before it starts", async () => {
    const stores = createMemoryStores();
    await stores.blocks.replacePlanned(A, DATE, [aBlock()]);
    await expect(
      stores.blocks.setTime(
        A,
        `${DATE}:focus:one`,
        "2026-11-09T22:00:00.000Z",
        "2026-11-09T21:00:00.000Z",
      ),
    ).rejects.toThrow(RowShapeError);
    expect((await stores.blocks.listForDate(A, DATE))[0].start).toBe("2026-11-09T17:00:00.000Z");
  });
});

describe("memory asks store", () => {
  test("a dedupe key can be asked once, ever", async () => {
    const stores = createMemoryStores();
    const first = await stores.asks.insert(A, anAsk());
    expect(first.created).toBe(true);

    const second = await stores.asks.insert(A, anAsk({ id: ASK_2, text: "different wording" }));
    expect(second.created).toBe(false);
    expect(second.ask.id).toBe(ASK_1);
    expect(second.ask.text).toBe("Did that block happen?");

    // Still once, ever: not just while the first one is open.
    await stores.asks.answer(A, ASK_1, "done", "2026-11-09T17:10:00.000Z");
    const third = await stores.asks.insert(A, anAsk({ id: ASK_2 }));
    expect(third.created).toBe(false);
    expect(third.ask.status).toBe("answered");
  });

  test("the same key for another user is another ask", async () => {
    const stores = createMemoryStores();
    await stores.asks.insert(A, anAsk());
    const other = await stores.asks.insert(B, anAsk({ id: ASK_2, userId: B }));
    expect(other.created).toBe(true);
    expect(await stores.asks.get(A, ASK_2)).toBeNull();
  });

  test("answer changes an open ask once; a second tap changes nothing", async () => {
    const stores = createMemoryStores();
    await stores.asks.insert(A, anAsk());
    const answered = await stores.asks.answer(A, ASK_1, "done", "2026-11-09T17:10:00.000Z");
    expect(answered?.status).toBe("answered");
    expect(answered?.answeredOptionId).toBe("done");
    expect(answered?.answeredAt).toBe("2026-11-09T17:10:00.000Z");
    expect(answered?.assumed).toBe(false);

    expect(await stores.asks.answer(A, ASK_1, "drop", "2026-11-09T17:11:00.000Z")).toBeNull();
    expect((await stores.asks.get(A, ASK_1))?.answeredOptionId).toBe("done");
  });

  test("answer refuses another user's ask and an unknown id", async () => {
    const stores = createMemoryStores();
    await stores.asks.insert(A, anAsk());
    expect(await stores.asks.answer(B, ASK_1, "done", "2026-11-09T17:10:00.000Z")).toBeNull();
    expect(await stores.asks.answer(A, ASK_2, "done", "2026-11-09T17:10:00.000Z")).toBeNull();
    expect((await stores.asks.get(A, ASK_1))?.status).toBe("open");
  });

  test("expire marks the ask assumed, once", async () => {
    const stores = createMemoryStores();
    await stores.asks.insert(A, anAsk());
    const expired = await stores.asks.expire(A, ASK_1, "2026-11-09T17:30:00.000Z");
    expect(expired?.status).toBe("expired");
    expect(expired?.assumed).toBe(true);
    expect(expired?.answeredOptionId).toBeNull();
    expect(await stores.asks.expire(A, ASK_1, "2026-11-09T17:31:00.000Z")).toBeNull();
  });

  test("an answer after the ask expired changes nothing", async () => {
    const stores = createMemoryStores();
    await stores.asks.insert(A, anAsk());
    await stores.asks.expire(A, ASK_1, "2026-11-09T17:30:00.000Z");
    expect(await stores.asks.answer(A, ASK_1, "done", "2026-11-09T17:31:00.000Z")).toBeNull();
    expect((await stores.asks.get(A, ASK_1))?.status).toBe("expired");
  });

  test("remind records one reminder", async () => {
    const stores = createMemoryStores();
    await stores.asks.insert(A, anAsk());
    const reminded = await stores.asks.remind(A, ASK_1, "2026-11-09T17:20:00.000Z");
    expect(reminded?.remindedAt).toBe("2026-11-09T17:20:00.000Z");
    expect(await stores.asks.remind(A, ASK_1, "2026-11-09T17:25:00.000Z")).toBeNull();
  });

  test("listOpen returns only open asks, for that user", async () => {
    const stores = createMemoryStores();
    await stores.asks.insert(A, anAsk());
    await stores.asks.insert(A, anAsk({ id: ASK_2, dedupeKey: "slip:b2" }));
    await stores.asks.insert(B, anAsk({ id: ASK_2, userId: B }));
    await stores.asks.answer(A, ASK_1, "done", "2026-11-09T17:10:00.000Z");
    const open = await stores.asks.listOpen(A);
    expect(open.map((a) => a.id)).toEqual([ASK_2]);
  });

  test("countUnanswered counts expired asks on a topic since an instant", async () => {
    const stores = createMemoryStores();
    const topic = `task:${TASK_1}`;
    const ids = [ASK_1, ASK_2, "33333333-3333-4333-8333-333333333335"];

    // One expired inside the window, one expired before it, one answered.
    await stores.asks.insert(A, anAsk({ id: ids[0], dedupeKey: "k1", openedAt: "2026-11-09T10:00:00.000Z" }));
    await stores.asks.expire(A, ids[0], "2026-11-09T11:00:00.000Z");
    await stores.asks.insert(A, anAsk({ id: ids[1], dedupeKey: "k2", openedAt: "2026-11-01T10:00:00.000Z" }));
    await stores.asks.expire(A, ids[1], "2026-11-01T11:00:00.000Z");
    await stores.asks.insert(A, anAsk({ id: ids[2], dedupeKey: "k3", openedAt: "2026-11-09T12:00:00.000Z" }));
    await stores.asks.answer(A, ids[2], "done", "2026-11-09T12:05:00.000Z");

    expect(await stores.asks.countUnanswered(A, topic, "2026-11-05T00:00:00.000Z")).toBe(1);
    expect(await stores.asks.countUnanswered(A, topic, "2026-10-01T00:00:00.000Z")).toBe(2);
    expect(await stores.asks.countUnanswered(A, "task:other", "2026-10-01T00:00:00.000Z")).toBe(0);
    expect(await stores.asks.countUnanswered(B, topic, "2026-10-01T00:00:00.000Z")).toBe(0);
  });

  test("an ask whose row shape is wrong is refused at the door", async () => {
    const stores = createMemoryStores();
    await expect(
      stores.asks.insert(A, anAsk({ status: "whenever" as unknown as Ask["status"] })),
    ).rejects.toThrow(RowShapeError);
  });

  test("a malformed ask is refused even when its dedupe key is already taken", async () => {
    const stores = createMemoryStores();
    await stores.asks.insert(A, anAsk());
    // Postgres checks the row's shape whatever the conflict resolution is, so a
    // malformed ask must not come back as a harmless created: false.
    await expect(
      stores.asks.insert(A, anAsk({ id: ASK_2, status: "whenever" as unknown as Ask["status"] })),
    ).rejects.toThrow(RowShapeError);
  });

  test("an answer for an option the ask never had changes nothing", async () => {
    const stores = createMemoryStores();
    await stores.asks.insert(A, anAsk());
    // A stale button from an older message, or a forged callback. Null, the
    // same answer a second tap gets.
    expect(await stores.asks.answer(A, ASK_1, "nope", "2026-11-09T17:10:00.000Z")).toBeNull();
    expect((await stores.asks.get(A, ASK_1))?.status).toBe("open");
    expect(await stores.asks.answer(A, ASK_1, "done", "2026-11-09T17:10:00.000Z")).not.toBeNull();
  });

  test("an option id that cannot be a real option is refused, not stored", async () => {
    const stores = createMemoryStores();
    await stores.asks.insert(A, anAsk());
    for (const optionId of ["", "thirteenchars"]) {
      await expect(
        stores.asks.answer(A, ASK_1, optionId, "2026-11-09T17:10:00.000Z"),
      ).rejects.toThrow(RowShapeError);
    }
    expect((await stores.asks.get(A, ASK_1))?.status).toBe("open");
  });
});

describe("memory outbox store", () => {
  test("enqueue does nothing when the key exists", async () => {
    const stores = createMemoryStores();
    expect(await stores.outbox.enqueue(A, anItem())).toBe(true);
    expect(await stores.outbox.enqueue(A, anItem({ id: OUT_2 }))).toBe(false);
    expect(await stores.outbox.listUnsent(A)).toHaveLength(1);
  });

  test("two ticks at the same instant enqueue one morning message", async () => {
    const stores = createMemoryStores();
    const [first, second] = await Promise.all([
      stores.outbox.enqueue(A, anItem()),
      stores.outbox.enqueue(A, anItem({ id: OUT_2 })),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await stores.outbox.listUnsent(A)).toHaveLength(1);
  });

  test("the same key for another user is another message", async () => {
    const stores = createMemoryStores();
    await stores.outbox.enqueue(A, anItem());
    expect(await stores.outbox.enqueue(B, anItem({ id: OUT_2, userId: B }))).toBe(true);
    expect(await stores.outbox.listUnsent(A)).toHaveLength(1);
    expect(await stores.outbox.listUnsent(B)).toHaveLength(1);
  });

  test("claim succeeds once, so two overlapping ticks send one message", async () => {
    const stores = createMemoryStores();
    await stores.outbox.enqueue(A, anItem());
    const claimed = await stores.outbox.claim(A, OUT_1, "2026-11-09T08:00:05.000Z");
    expect(claimed?.claimedAt).toBe("2026-11-09T08:00:05.000Z");
    expect(await stores.outbox.claim(A, OUT_1, "2026-11-09T08:00:06.000Z")).toBeNull();
    expect(await stores.outbox.claim(B, OUT_1, "2026-11-09T08:00:06.000Z")).toBeNull();
  });

  test("markSent takes the item out of the unsent list", async () => {
    const stores = createMemoryStores();
    await stores.outbox.enqueue(A, anItem());
    await stores.outbox.claim(A, OUT_1, "2026-11-09T08:00:05.000Z");
    await stores.outbox.markSent(A, OUT_1, "2026-11-09T08:00:06.000Z", "991");
    expect(await stores.outbox.listUnsent(A)).toEqual([]);
  });

  test("markFailed records the error class and leaves the item claimed", async () => {
    const stores = createMemoryStores();
    await stores.outbox.enqueue(A, anItem());
    await stores.outbox.claim(A, OUT_1, "2026-11-09T08:00:05.000Z");
    await stores.outbox.markFailed(A, OUT_1, "2026-11-09T08:00:06.000Z", "bot-blocked");
    const unsent = await stores.outbox.listUnsent(A);
    expect(unsent).toHaveLength(1);
    expect(unsent[0].error).toBe("bot-blocked");
    expect(unsent[0].sentAt).toBeNull();
  });

  test("an item may only point at an ask of the same account", async () => {
    const stores = createMemoryStores();
    // The composite foreign key on (user_id, ask_id). It bites because
    // asks.insert can return an EXISTING ask whose id is not the one the
    // caller made, so a message built from the caller's id points at nothing.
    await expect(
      stores.outbox.enqueue(A, anItem({ kind: "ask", askId: ASK_1 })),
    ).rejects.toThrow(/ask_id/);

    await stores.asks.insert(B, anAsk({ id: ASK_1, userId: B }));
    await expect(
      stores.outbox.enqueue(A, anItem({ kind: "ask", askId: ASK_1 })),
    ).rejects.toThrow(/ask_id/);

    await stores.asks.insert(A, anAsk({ id: ASK_1 }));
    expect(await stores.outbox.enqueue(A, anItem({ kind: "ask", askId: ASK_1 }))).toBe(true);
  });

  test("listSendable gives the sender unsent, unclaimed items of one delivery", async () => {
    const stores = createMemoryStores();
    await stores.outbox.enqueue(A, anItem({ id: OUT_1, dedupeKey: "a", createdAt: "2026-11-09T08:00:00.000Z" }));
    await stores.outbox.enqueue(A, anItem({ id: OUT_2, dedupeKey: "b", createdAt: "2026-11-09T07:00:00.000Z" }));
    await stores.outbox.enqueue(A, anItem({
      id: "44444444-4444-4444-8444-444444444449",
      dedupeKey: "c",
      delivery: "digest",
    }));

    // Oldest first, so nothing queued earlier is starved.
    expect((await stores.outbox.listSendable(A, "interrupt")).map((i) => i.id)).toEqual([
      OUT_2,
      OUT_1,
    ]);
    expect((await stores.outbox.listSendable(A, "digest")).map((i) => i.id)).toEqual([
      "44444444-4444-4444-8444-444444444449",
    ]);
    expect(await stores.outbox.listSendable(B, "interrupt")).toEqual([]);

    // A claimed item leaves the sendable set for good, which is what keeps it
    // bounded, but it stays visible as unsent.
    await stores.outbox.claim(A, OUT_2, "2026-11-09T08:00:05.000Z");
    expect((await stores.outbox.listSendable(A, "interrupt")).map((i) => i.id)).toEqual([OUT_1]);
    expect((await stores.outbox.listUnsent(A)).map((i) => i.id)).toContain(OUT_2);
  });

  test("listUnsent is newest first, so a pile of held items cannot hide today's", async () => {
    const stores = createMemoryStores();
    await stores.outbox.enqueue(A, anItem({ id: OUT_1, dedupeKey: "old", createdAt: "2026-11-01T08:00:00.000Z" }));
    await stores.outbox.enqueue(A, anItem({ id: OUT_2, dedupeKey: "new", createdAt: "2026-11-09T08:00:00.000Z" }));
    expect((await stores.outbox.listUnsent(A)).map((i) => i.id)).toEqual([OUT_2, OUT_1]);
  });

  test("a malformed item is refused even when its dedupe key is already taken", async () => {
    const stores = createMemoryStores();
    await stores.outbox.enqueue(A, anItem());
    await expect(
      stores.outbox.enqueue(
        A,
        anItem({ id: OUT_2, kind: "shout" as unknown as OutboxItem["kind"] }),
      ),
    ).rejects.toThrow(RowShapeError);
  });

  test("an empty error class or chat message id is refused, not written", async () => {
    const stores = createMemoryStores();
    await stores.outbox.enqueue(A, anItem());
    await stores.outbox.claim(A, OUT_1, "2026-11-09T08:00:05.000Z");
    // Postgres would take either happily, and then every later read of this
    // account would throw on a row the store itself wrote.
    await expect(
      stores.outbox.markFailed(A, OUT_1, "2026-11-09T08:00:06.000Z", ""),
    ).rejects.toThrow(RowShapeError);
    await expect(
      stores.outbox.markSent(A, OUT_1, "2026-11-09T08:00:06.000Z", ""),
    ).rejects.toThrow(RowShapeError);
    const unsent = await stores.outbox.listUnsent(A);
    expect(unsent).toHaveLength(1);
    expect(unsent[0].error).toBeNull();
    // null is the normal "sent, no message id" case and stays allowed.
    await stores.outbox.markSent(A, OUT_1, "2026-11-09T08:00:06.000Z", null);
    expect(await stores.outbox.listUnsent(A)).toEqual([]);
  });

  test("countInterruptsSince counts interrupting asks by enqueue time, not by send", async () => {
    const stores = createMemoryStores();
    // Two asks opened in one tick both count, even though neither has been sent.
    await stores.asks.insert(A, anAsk({ id: ASK_1, dedupeKey: "d1" }));
    await stores.asks.insert(A, anAsk({ id: ASK_2, dedupeKey: "d2" }));
    await stores.outbox.enqueue(A, anItem({ id: OUT_1, kind: "ask", dedupeKey: "ask:1", askId: ASK_1 }));
    await stores.outbox.enqueue(A, anItem({ id: OUT_2, kind: "ask", dedupeKey: "ask:2", askId: ASK_2 }));
    // The morning message and an alert are outside the budget.
    await stores.outbox.enqueue(A, anItem({ id: "44444444-4444-4444-8444-444444444446", kind: "morning", dedupeKey: "m" }));
    await stores.outbox.enqueue(A, anItem({ id: "44444444-4444-4444-8444-444444444447", kind: "alert", dedupeKey: "al" }));
    // A digest ask never interrupts.
    await stores.outbox.enqueue(A, anItem({
      id: "44444444-4444-4444-8444-444444444448",
      kind: "ask",
      dedupeKey: "ask:3",
      delivery: "digest",
    }));

    expect(await stores.outbox.countInterruptsSince(A, "2026-11-09T00:00:00.000Z")).toBe(2);
    expect(await stores.outbox.countInterruptsSince(A, "2026-11-10T00:00:00.000Z")).toBe(0);
    expect(await stores.outbox.countInterruptsSince(B, "2026-11-09T00:00:00.000Z")).toBe(0);
  });
});

describe("memory feeds store", () => {
  const expectation: StoredExpectation = {
    feed: "calendar",
    label: "Calendar",
    everyMinutes: 30,
    graceMinutes: 10,
    minCount: 0,
    activeHours: null,
    enabledAt: "2026-11-01T00:00:00.000Z",
  };

  function aRun(over: Partial<FeedRun> = {}): FeedRun {
    return {
      feed: "calendar",
      startedAt: "2026-11-09T17:00:00.000Z",
      finishedAt: "2026-11-09T17:00:01.000Z",
      status: "ok",
      count: 3,
      errorClass: null,
      ...over,
    };
  }

  test("an expectation round trips with its label and enabledAt", async () => {
    const stores = createMemoryStores();
    await stores.feeds.saveExpectation(A, expectation);
    expect(await stores.feeds.listExpectations(A)).toEqual([expectation]);
    expect(await stores.feeds.listExpectations(B)).toEqual([]);
  });

  test("saving the same feed twice replaces it", async () => {
    const stores = createMemoryStores();
    await stores.feeds.saveExpectation(A, expectation);
    await stores.feeds.saveExpectation(A, { ...expectation, everyMinutes: 60 });
    const stored = await stores.feeds.listExpectations(A);
    expect(stored).toHaveLength(1);
    expect(stored[0].everyMinutes).toBe(60);
  });

  test("runs come back newest first, from the instant asked for", async () => {
    const stores = createMemoryStores();
    await stores.feeds.addRun(A, aRun({ startedAt: "2026-11-09T10:00:00.000Z" }));
    await stores.feeds.addRun(A, aRun({ startedAt: "2026-11-09T12:00:00.000Z" }));
    await stores.feeds.addRun(A, aRun({ startedAt: "2026-11-07T12:00:00.000Z" }));
    const runs = await stores.feeds.listRuns(A, "2026-11-09T00:00:00.000Z");
    expect(runs.map((r) => r.startedAt)).toEqual([
      "2026-11-09T12:00:00.000Z",
      "2026-11-09T10:00:00.000Z",
    ]);
  });

  test("prune removes only that user's older runs", async () => {
    const stores = createMemoryStores();
    await stores.feeds.addRun(A, aRun({ startedAt: "2026-10-01T10:00:00.000Z" }));
    await stores.feeds.addRun(A, aRun({ startedAt: "2026-11-09T10:00:00.000Z" }));
    await stores.feeds.addRun(B, aRun({ startedAt: "2026-10-01T10:00:00.000Z" }));
    expect(await stores.feeds.prune(A, "2026-11-01T00:00:00.000Z")).toBe(1);
    expect(await stores.feeds.listRuns(A, "2026-01-01T00:00:00.000Z")).toHaveLength(1);
    expect(await stores.feeds.listRuns(B, "2026-01-01T00:00:00.000Z")).toHaveLength(1);
  });
});

describe("memory alerts store", () => {
  function anAlert(over: Partial<Alert> = {}): Alert {
    return {
      id: ALERT_1,
      cause: "auth-expired",
      feeds: ["calendar"],
      since: "2026-11-09T09:00:00.000Z",
      step: 0,
      lastSentAt: null,
      status: "open",
      ...over,
    };
  }

  test("save stores a new alert and updates an existing one silently", async () => {
    const stores = createMemoryStores();
    expect(await stores.alerts.save(A, anAlert())).toBe(true);
    // The AlertAction `update` member: the feed list changed, nothing is sent.
    expect(await stores.alerts.save(A, anAlert({ feeds: ["calendar", "tasks"] }))).toBe(true);
    const open = await stores.alerts.listOpen(A);
    expect(open).toHaveLength(1);
    expect(open[0].feeds).toEqual(["calendar", "tasks"]);
  });

  test("a second open alert for the same cause is refused", async () => {
    const stores = createMemoryStores();
    await stores.alerts.save(A, anAlert());
    expect(await stores.alerts.save(A, anAlert({ id: ALERT_2 }))).toBe(false);
    expect(await stores.alerts.listOpen(A)).toHaveLength(1);
    // Closing the first frees the cause.
    await stores.alerts.save(A, anAlert({ status: "closed" }));
    expect(await stores.alerts.save(A, anAlert({ id: ALERT_2 }))).toBe(true);
  });

  test("the same cause for another user is another alert", async () => {
    const stores = createMemoryStores();
    await stores.alerts.save(A, anAlert());
    expect(await stores.alerts.save(B, anAlert({ id: ALERT_2 }))).toBe(true);
    expect(await stores.alerts.listOpen(A)).toHaveLength(1);
  });

  test("listOpen leaves closed alerts out", async () => {
    const stores = createMemoryStores();
    await stores.alerts.save(A, anAlert({ status: "closed" }));
    expect(await stores.alerts.listOpen(A)).toEqual([]);
  });

  test("lastAnnounced finds the newest alert for a cause that was sent", async () => {
    const stores = createMemoryStores();
    expect(await stores.alerts.lastAnnounced(A, "auth-expired")).toBeNull();

    // Never sent: not announced.
    await stores.alerts.save(A, anAlert({ status: "closed" }));
    expect(await stores.alerts.lastAnnounced(A, "auth-expired")).toBeNull();

    await stores.alerts.save(A, anAlert({ id: ALERT_2, status: "closed", lastSentAt: "2026-11-08T09:00:00.000Z" }));
    await stores.alerts.save(A, anAlert({
      id: "55555555-5555-4555-8555-555555555557",
      status: "closed",
      lastSentAt: "2026-11-09T09:00:00.000Z",
    }));
    expect((await stores.alerts.lastAnnounced(A, "auth-expired"))?.lastSentAt).toBe(
      "2026-11-09T09:00:00.000Z",
    );
    expect(await stores.alerts.lastAnnounced(A, "no-run")).toBeNull();
    expect(await stores.alerts.lastAnnounced(B, "auth-expired")).toBeNull();
  });
});

describe("memory channels store", () => {
  test("a user with no row has no link", async () => {
    const stores = createMemoryStores();
    expect(await stores.channels.get(A)).toBeNull();
    expect(await stores.channels.userForChat("4242")).toBeNull();
  });

  test("a pairing hash is redeemed once and links the chat", async () => {
    const stores = createMemoryStores();
    await stores.channels.setPairing(A, HASH_1, "2026-11-09T18:00:00.000Z");
    expect((await stores.channels.get(A))?.chatId).toBeNull();

    expect(await stores.channels.redeemPairing(HASH_1, "4242", "2026-11-09T17:00:00.000Z")).toBe(A);
    expect(await stores.channels.get(A)).toEqual({
      userId: A,
      chatId: "4242",
      linkedAt: "2026-11-09T17:00:00.000Z",
    });
    expect(await stores.channels.userForChat("4242")).toBe(A);

    // Single use: the hash is gone.
    expect(await stores.channels.redeemPairing(HASH_1, "9999", "2026-11-09T17:01:00.000Z")).toBeNull();
    expect(await stores.channels.userForChat("9999")).toBeNull();
  });

  test("an expired hash is refused", async () => {
    const stores = createMemoryStores();
    await stores.channels.setPairing(A, HASH_1, "2026-11-09T18:00:00.000Z");
    expect(await stores.channels.redeemPairing(HASH_1, "4242", "2026-11-09T18:00:01.000Z")).toBeNull();
    expect(await stores.channels.get(A)).toEqual({ userId: A, chatId: null, linkedAt: null });
  });

  test("a value that is not a sha-256 digest is refused, so a raw code cannot be stored", async () => {
    const stores = createMemoryStores();
    for (const bad of ["", "hunter2", "A".repeat(64), "a".repeat(63), "a".repeat(65)]) {
      await expect(
        stores.channels.setPairing(A, bad, "2026-11-09T18:00:00.000Z"),
      ).rejects.toThrow(RowShapeError);
    }
    expect(await stores.channels.get(A)).toBeNull();
  });

  test("an unknown hash is refused", async () => {
    const stores = createMemoryStores();
    await stores.channels.setPairing(A, HASH_1, "2026-11-09T18:00:00.000Z");
    expect(await stores.channels.redeemPairing(HASH_2, "4242", "2026-11-09T17:00:00.000Z")).toBeNull();
  });

  test("a chat already linked to another user is refused", async () => {
    const stores = createMemoryStores();
    await stores.channels.setPairing(A, HASH_1, "2026-11-09T18:00:00.000Z");
    await stores.channels.redeemPairing(HASH_1, "4242", "2026-11-09T17:00:00.000Z");
    await stores.channels.setPairing(B, HASH_2, "2026-11-09T18:00:00.000Z");
    expect(await stores.channels.redeemPairing(HASH_2, "4242", "2026-11-09T17:05:00.000Z")).toBeNull();
    expect(await stores.channels.userForChat("4242")).toBe(A);
  });

  test("setPairing replaces an earlier code and keeps an existing link", async () => {
    const stores = createMemoryStores();
    await stores.channels.setPairing(A, HASH_1, "2026-11-09T18:00:00.000Z");
    await stores.channels.redeemPairing(HASH_1, "4242", "2026-11-09T17:00:00.000Z");
    await stores.channels.setPairing(A, HASH_2, "2026-11-09T19:00:00.000Z");
    expect((await stores.channels.get(A))?.chatId).toBe("4242");
    expect(await stores.channels.redeemPairing(HASH_2, "4242", "2026-11-09T18:30:00.000Z")).toBe(A);
  });
});
