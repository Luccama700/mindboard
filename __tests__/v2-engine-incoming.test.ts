// @vitest-environment node
// Task 7, behaviours 5, 6 and 7: what happens when something comes back from
// Telegram. The asks are the real ones the tick opens, so these tests answer
// the same rows production would.

import { describe, expect, test } from "vitest";

import { FakeTelegram, type FakeTelegramCall } from "@/app/lib/v2/channel/fake-telegram";
import { callbackMessage, handleIncoming } from "@/app/lib/v2/engine/incoming";
import { runTick, type TickDeps } from "@/app/lib/v2/engine/tick";
import { createPairingCode } from "@/app/lib/v2/engine/pairing";
import { createMemoryStores } from "@/app/lib/v2/store/memory";
import { zonedWallTimeToUtcMs } from "@/app/lib/snapshots/zoned-time";
import type { RulesDocument, Stores } from "@/app/lib/v2/store/types";
import type { Ask, Block, Candidate, FeedRun, FixedEvent } from "@/app/lib/v2/types";

const USER = "11111111-1111-4111-8111-111111111111";
const TASK_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CHAT = "4242";
const HASH = "a".repeat(64);
const ZONE = "America/Phoenix";
const DATE = "2026-11-09";
const DAY = 86_400_000;

function local(wall: string, date = DATE): string {
  const [hour, minute] = wall.split(":").map(Number);
  return new Date(zonedWallTimeToUtcMs(date, hour, minute, ZONE)).toISOString();
}

const RULES: RulesDocument = {
  planner: {
    timeZone: ZONE,
    wakeByWeekday: ["08:00", "08:00", "08:00", "08:00", "08:00", "08:00", "08:00"],
    lightsOut: "23:00",
    noFocusBefore: "09:00",
    bufferMinutes: 10,
    blockMinutes: { floor: 25, standard: 50, long: 120 },
    capacity: {
      low: { blocks: 0, small: 1, gym: false, social: false },
      ok: { blocks: 2, small: 0, gym: false, social: false },
      good: { blocks: 3, small: 0, gym: false, social: false },
    },
    slipDefaultAfterMinutes: 30,
    interruptsPerDay: 3,
  },
  lanes: [
    { key: "lane-a", label: "Lane A", color: "#b5ff3c", groupIds: ["g1"], hardDates: false },
  ],
  feedLabels: {},
};

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    id: TASK_A,
    title: "Write the brief",
    lane: "lane-a",
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

function aBlock(over: Partial<Block> = {}): Block {
  return {
    id: `${DATE}:focus:${TASK_A}`,
    date: DATE,
    start: local("10:00"),
    end: local("10:50"),
    kind: "focus",
    lane: "lane-a",
    taskId: TASK_A,
    title: "Write the brief",
    state: "planned",
    reason: "lane-next",
    ...over,
  };
}

const CALENDAR_OK: FeedRun = {
  feed: "calendar",
  startedAt: local("09:00"),
  finishedAt: local("09:00"),
  status: "ok",
  count: 0,
  errorClass: null,
};

async function harness(
  over: { linked?: boolean; fixed?: FixedEvent[]; candidates?: Candidate[] } = {},
): Promise<{ stores: Stores; deps: TickDeps; telegram: FakeTelegram }> {
  const stores = createMemoryStores();
  await stores.users.save(USER, { rules: RULES, enabled: true });
  if (over.linked !== false) {
    await stores.channels.setPairing(USER, HASH, new Date(Date.parse(local("07:00")) + DAY).toISOString());
    await stores.channels.redeemPairing(HASH, CHAT, local("07:00"));
  }
  const telegram = new FakeTelegram();
  let n = 0;
  const deps: TickDeps = {
    stores,
    telegram,
    loadFixed: async () => ({ fixed: over.fixed ?? [], calendar: CALENDAR_OK }),
    loadCandidates: async () => over.candidates ?? [candidate()],
    loadWeekCapHours: async () => ({ hours: 0, ok: true }),
    newId: () => `bbbbbbbb-bbbb-4bbb-8bbb-${String(++n).padStart(12, "0")}`,
    probes: [],
  };
  return { stores, deps, telegram };
}

/** Runs one tick on a block that has slipped, which opens the real slip ask. */
async function slipAskFor(stores: Stores, deps: TickDeps): Promise<Ask> {
  await stores.blocks.replacePlanned(USER, DATE, [aBlock()]);
  await runTick(deps, USER, local("10:15"));
  const ask = (await stores.asks.listOpen(USER)).find((open) => open.kind === "slip");
  if (ask === undefined) throw new Error("the tick opened no slip ask");
  return ask;
}

const calls = (telegram: FakeTelegram): FakeTelegramCall["method"][] =>
  telegram.sent.map((call) => call.method);

function blockOf(blocks: Block[], id = aBlock().id): Block | undefined {
  return blocks.find((block) => block.id === id);
}

describe("handleIncoming, an answer", () => {
  test("an unknown chat does nothing at all", async () => {
    const { stores, deps, telegram } = await harness();
    const ask = await slipAskFor(stores, deps);
    telegram.sent.length = 0;

    await handleIncoming(
      deps,
      { type: "answer", chatId: "9999", askId: ask.id, optionId: "did", callbackId: "cb-1" },
      local("10:20"),
    );

    expect(telegram.sent).toEqual([]);
    expect((await stores.asks.get(USER, ask.id))?.status).toBe("open");
  });

  test("an answer applies the effect, replans, then acknowledges and rewrites the message", async () => {
    const { stores, deps, telegram } = await harness();
    const ask = await slipAskFor(stores, deps);
    telegram.sent.length = 0;

    await handleIncoming(
      deps,
      { type: "answer", chatId: CHAT, askId: ask.id, optionId: "did", callbackId: "cb-1" },
      local("10:20"),
      { chatMessageId: "77" },
    );

    expect(blockOf(await stores.blocks.listForDate(USER, DATE))?.state).toBe("done");
    expect((await stores.asks.get(USER, ask.id))?.answeredOptionId).toBe("did");
    expect((await stores.days.get(USER, DATE))?.plannedAt).toBe(local("10:20"));
    expect(telegram.sent).toEqual([
      { method: "answerCallback", chatId: null, callbackId: "cb-1", text: "Got it: Did it." },
      {
        method: "replaceButtons",
        chatId: CHAT,
        messageId: "77",
        text: "Still doing Write the brief?\nGot it: Did it.",
      },
    ]);
  });

  test("keeps the message that carried the ask when the caller knows it", async () => {
    const { stores, deps, telegram } = await harness();
    const ask = await slipAskFor(stores, deps);
    telegram.sent.length = 0;

    await handleIncoming(
      deps,
      { type: "answer", chatId: CHAT, askId: ask.id, optionId: "drop", callbackId: "cb-2" },
      local("10:20"),
      { chatMessageId: "77", chatMessageText: "Morning. Nothing fixed today." },
    );

    const edit = telegram.sent.find((call) => call.method === "replaceButtons");
    expect(edit).toMatchObject({
      text: "Morning. Nothing fixed today.\nGot it: Drop.",
    });
  });

  test("a retried webhook update changes nothing", async () => {
    const { stores, deps, telegram } = await harness();
    const ask = await slipAskFor(stores, deps);
    const update = {
      type: "answer" as const,
      chatId: CHAT,
      askId: ask.id,
      optionId: "did",
      callbackId: "cb-1",
    };
    await handleIncoming(deps, update, local("10:20"), { chatMessageId: "77" });
    const after = await stores.blocks.listForDate(USER, DATE);
    telegram.sent.length = 0;

    await handleIncoming(deps, update, local("10:25"), { chatMessageId: "77" });

    expect(await stores.blocks.listForDate(USER, DATE)).toEqual(after);
    expect(telegram.sent).toEqual([
      { method: "answerCallback", chatId: null, callbackId: "cb-1", text: "Got it: Did it." },
    ]);
  });

  test("an answer after the ask expired changes nothing", async () => {
    const { stores, deps, telegram } = await harness();
    const ask = await slipAskFor(stores, deps);
    // The tick's sweep expires it and applies the default, later today.
    await runTick(deps, USER, local("10:50"));
    const after = await stores.blocks.listForDate(USER, DATE);
    telegram.sent.length = 0;

    await handleIncoming(
      deps,
      { type: "answer", chatId: CHAT, askId: ask.id, optionId: "did", callbackId: "cb-9" },
      local("10:55"),
      { chatMessageId: "77" },
    );

    expect(await stores.blocks.listForDate(USER, DATE)).toEqual(after);
    expect(telegram.sent).toEqual([
      {
        method: "answerCallback",
        chatId: null,
        callbackId: "cb-9",
        text: "No answer, so I went with Later today.",
      },
    ]);
  });

  test("an option the ask never had is dismissed without a claim", async () => {
    const { stores, deps, telegram } = await harness();
    const ask = await slipAskFor(stores, deps);
    telegram.sent.length = 0;

    await handleIncoming(
      deps,
      { type: "answer", chatId: CHAT, askId: ask.id, optionId: "nope", callbackId: "cb-3" },
      local("10:20"),
    );

    expect((await stores.asks.get(USER, ask.id))?.status).toBe("open");
    expect(telegram.sent).toEqual([
      { method: "answerCallback", chatId: null, callbackId: "cb-3", text: "" },
    ]);
  });

  test("an option id longer than the contract allows never reaches the store", async () => {
    const { stores, deps, telegram } = await harness();
    const ask = await slipAskFor(stores, deps);
    telegram.sent.length = 0;

    await handleIncoming(
      deps,
      {
        type: "answer",
        chatId: CHAT,
        askId: ask.id,
        optionId: "x".repeat(40),
        callbackId: "cb-5",
      },
      local("10:20"),
    );

    expect((await stores.asks.get(USER, ask.id))?.status).toBe("open");
    expect(telegram.sent).toEqual([
      { method: "answerCallback", chatId: null, callbackId: "cb-5", text: "" },
    ]);
  });

  test("a chat linked to one account cannot answer another account's ask", async () => {
    const { stores, deps, telegram } = await harness();
    const ask = await slipAskFor(stores, deps);

    // A second account, linked to its own chat, taps the first account's ask id.
    await stores.users.save(OTHER, { rules: RULES, enabled: true });
    await stores.channels.setPairing(
      OTHER,
      "b".repeat(64),
      new Date(Date.parse(local("10:00")) + DAY).toISOString(),
    );
    await stores.channels.redeemPairing("b".repeat(64), "9999", local("10:00"));
    telegram.sent.length = 0;

    await handleIncoming(
      deps,
      { type: "answer", chatId: "9999", askId: ask.id, optionId: "did", callbackId: "cb-x" },
      local("10:20"),
      { chatMessageId: "77" },
    );

    expect((await stores.asks.get(USER, ask.id))?.status).toBe("open");
    expect(blockOf(await stores.blocks.listForDate(USER, DATE))?.state).toBe("planned");
    expect(await stores.blocks.listForDate(OTHER, DATE)).toEqual([]);
    expect(telegram.sent).toEqual([]);
  });

  test("a tap that arrives after the block was started does not overwrite it", async () => {
    const { stores, deps } = await harness();
    const ask = await slipAskFor(stores, deps);
    await stores.blocks.setState(USER, aBlock().id, "started");

    await handleIncoming(
      deps,
      { type: "answer", chatId: CHAT, askId: ask.id, optionId: "drop", callbackId: "cb-1" },
      local("10:20"),
    );

    expect(blockOf(await stores.blocks.listForDate(USER, DATE))?.state).toBe("started");
  });

  test("tomorrow does not overwrite a block that was already finished", async () => {
    const { stores, deps } = await harness();
    const ask = await slipAskFor(stores, deps);
    await stores.blocks.setState(USER, aBlock().id, "done");

    await handleIncoming(
      deps,
      { type: "answer", chatId: CHAT, askId: ask.id, optionId: "tomorrow", callbackId: "cb-1" },
      local("10:20"),
    );

    expect(blockOf(await stores.blocks.listForDate(USER, DATE))?.state).toBe("done");
  });

  test("an ask id that belongs to nobody is ignored", async () => {
    const { deps, telegram } = await harness();
    await handleIncoming(
      deps,
      {
        type: "answer",
        chatId: CHAT,
        askId: "cccccccc-cccc-4ccc-8ccc-000000000001",
        optionId: "did",
        callbackId: "cb-4",
      },
      local("10:20"),
    );
    expect(telegram.sent).toEqual([]);
  });
});

describe("handleIncoming, the effects", () => {
  test("tapping later today moves the block to a later free slot and the next tick keeps it there", async () => {
    const { stores, deps } = await harness();
    const ask = await slipAskFor(stores, deps);

    await handleIncoming(
      deps,
      { type: "answer", chatId: CHAT, askId: ask.id, optionId: "later", callbackId: "cb-1" },
      local("10:20"),
    );

    const moved = blockOf(await stores.blocks.listForDate(USER, DATE));
    expect(moved).toMatchObject({ state: "planned", start: local("11:00"), end: local("11:50") });

    await runTick(deps, USER, local("10:30"));
    expect(blockOf(await stores.blocks.listForDate(USER, DATE))).toMatchObject({
      state: "planned",
      start: local("11:00"),
      end: local("11:50"),
    });
  });

  test("later today never lands closer than the slip grace, or it slips at once", async () => {
    const { stores, deps } = await harness();
    const ask = await slipAskFor(stores, deps);

    await handleIncoming(
      deps,
      { type: "answer", chatId: CHAT, askId: ask.id, optionId: "later", callbackId: "cb-1" },
      local("14:00"),
    );

    // Now is past the block's own end, so the buffer does not decide this: the
    // grace does, and a block placed at 14:00 would have slipped by 14:10.
    expect(blockOf(await stores.blocks.listForDate(USER, DATE))).toMatchObject({
      start: local("14:10"),
      end: local("15:00"),
    });
  });

  test("later today with no room left skips the block and says so", async () => {
    const wall: FixedEvent = {
      id: "cal-1:wall",
      title: "Shift",
      start: local("10:30"),
      end: local("23:00"),
      allDay: false,
      calendarId: "cal-1",
      location: null,
      countsTowardCap: false,
      source: "google",
    };
    const { stores, deps } = await harness({ fixed: [wall] });
    const ask = await slipAskFor(stores, deps);

    await handleIncoming(
      deps,
      { type: "answer", chatId: CHAT, askId: ask.id, optionId: "later", callbackId: "cb-1" },
      local("10:20"),
    );

    expect(blockOf(await stores.blocks.listForDate(USER, DATE))).toMatchObject({
      state: "skipped",
      reason: "no room later today",
    });
  });

  test("tomorrow and drop each skip the block with their own reason", async () => {
    const tomorrow = await harness();
    const askA = await slipAskFor(tomorrow.stores, tomorrow.deps);
    await handleIncoming(
      tomorrow.deps,
      { type: "answer", chatId: CHAT, askId: askA.id, optionId: "tomorrow", callbackId: "cb-1" },
      local("10:20"),
    );
    expect(blockOf(await tomorrow.stores.blocks.listForDate(USER, DATE))).toMatchObject({
      state: "skipped",
      reason: "moved to tomorrow",
    });

    const dropped = await harness();
    const askB = await slipAskFor(dropped.stores, dropped.deps);
    await handleIncoming(
      dropped.deps,
      { type: "answer", chatId: CHAT, askId: askB.id, optionId: "drop", callbackId: "cb-2" },
      local("10:20"),
    );
    expect(blockOf(await dropped.stores.blocks.listForDate(USER, DATE))).toMatchObject({
      state: "skipped",
      reason: "dropped",
    });
  });

  test("an energy answer stores the day's energy as given, not assumed", async () => {
    const { stores, deps } = await harness();
    await runTick(deps, USER, local("08:10"));
    const [ask] = await stores.asks.listOpen(USER);
    expect(ask.kind).toBe("energy");

    await handleIncoming(
      deps,
      { type: "answer", chatId: CHAT, askId: ask.id, optionId: "low", callbackId: "cb-1" },
      local("08:15"),
    );

    const day = await stores.days.get(USER, DATE);
    expect(day?.energy).toBe("low");
    expect(day?.energyAssumed).toBe(false);
  });

});

describe("handleIncoming, start and text", () => {
  test("a valid code links the chat and says so", async () => {
    const stores = createMemoryStores();
    await stores.users.save(USER, { rules: RULES, enabled: true });
    const telegram = new FakeTelegram();
    const deps: TickDeps = {
      stores,
      telegram,
      loadFixed: async () => ({ fixed: [], calendar: CALENDAR_OK }),
      loadCandidates: async () => [],
      loadWeekCapHours: async () => ({ hours: 0, ok: true }),
      newId: () => "bbbbbbbb-bbbb-4bbb-8bbb-000000000001",
    };
    const code = await createPairingCode(stores, USER, local("09:00"), () => "MNPQRSTVWXYZ0123456789ABCD");

    await handleIncoming(deps, { type: "start", chatId: CHAT, pairingCode: code }, local("09:05"));

    expect(await stores.channels.userForChat(CHAT)).toBe(USER);
    expect(telegram.sent).toEqual([
      {
        method: "sendMessage",
        chatId: CHAT,
        msg: { text: "Linked. I will message you here.", buttons: [] },
        messageId: "1",
      },
    ]);
  });

  test("a used code, a wrong code and no code all get the same plain refusal", async () => {
    const refusal = "That code is not valid any more. Make a new one in Mindboard.";
    const { stores, deps, telegram } = await harness({ linked: false });
    const code = await createPairingCode(stores, USER, local("09:00"), () => "MNPQRSTVWXYZ0123456789ABCD");

    await handleIncoming(deps, { type: "start", chatId: CHAT, pairingCode: code }, local("09:05"));
    await handleIncoming(deps, { type: "start", chatId: CHAT, pairingCode: code }, local("09:06"));
    await handleIncoming(deps, { type: "start", chatId: CHAT, pairingCode: "NOPE" }, local("09:07"));
    await handleIncoming(deps, { type: "start", chatId: CHAT, pairingCode: null }, local("09:08"));

    const texts = telegram.sent.map((call) =>
      call.method === "sendMessage" ? call.msg.text : "",
    );
    expect(texts).toEqual(["Linked. I will message you here.", refusal, refusal, refusal]);
  });

  test("a text message from any chat is ignored in this slice", async () => {
    const { stores, deps, telegram } = await harness();
    await handleIncoming(
      deps,
      { type: "text", chatId: CHAT, text: "move the gym to friday" },
      local("10:20"),
    );
    expect(telegram.sent).toEqual([]);
    expect(await stores.blocks.listForDate(USER, DATE)).toEqual([]);
  });

  test("with no telegram client an answer still lands, it is just not acknowledged", async () => {
    const { stores, deps } = await harness();
    const ask = await slipAskFor(stores, deps);
    const quiet: TickDeps = { ...deps, telegram: null };

    await handleIncoming(
      quiet,
      { type: "answer", chatId: CHAT, askId: ask.id, optionId: "did", callbackId: "cb-1" },
      local("10:20"),
    );

    expect(blockOf(await stores.blocks.listForDate(USER, DATE))?.state).toBe("done");
  });
});

describe("callbackMessage", () => {
  test("reads the id and text of the message a button was tapped on", () => {
    expect(
      callbackMessage({
        callback_query: {
          id: "cb-1",
          data: "a:ask-1:good",
          message: { message_id: 9, chat: { id: 4242 }, text: "Energy today?" },
        },
      }),
    ).toEqual({ messageId: "9", text: "Energy today?" });
  });

  test("gives nulls for anything else, without throwing", () => {
    for (const input of [null, undefined, 42, {}, { callback_query: { id: "x" } }, { message: {} }]) {
      expect(callbackMessage(input)).toEqual({ messageId: null, text: null });
    }
  });
});

describe("the call shapes", () => {
  test("an answer never calls replaceButtons without a message id", async () => {
    const { stores, deps, telegram } = await harness();
    const ask = await slipAskFor(stores, deps);
    telegram.sent.length = 0;

    await handleIncoming(
      deps,
      { type: "answer", chatId: CHAT, askId: ask.id, optionId: "did", callbackId: "cb-1" },
      local("10:20"),
    );

    expect(calls(telegram)).toEqual(["answerCallback"]);
  });
});
