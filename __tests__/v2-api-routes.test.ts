// @vitest-environment node
// Task 7, behaviours 10 and 11: the three thin routes. The engine they run is
// the real one on memory stores, injected through the one factory the routes
// import, so these tests exercise the handlers without a database.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FakeTelegram } from "@/app/lib/v2/channel/fake-telegram";
import {
  ENGINE_TICK_FEED,
  TICK_DEADLINE_MS,
  runTick,
  type TickDeps,
} from "@/app/lib/v2/engine/tick";
import { createMemoryStores } from "@/app/lib/v2/store/memory";
import type { RulesDocument, Stores } from "@/app/lib/v2/store/types";
import type { Candidate, FeedRun } from "@/app/lib/v2/types";

const engine = vi.hoisted(() => ({
  current: null as null | { stores: unknown; deps: unknown },
}));

vi.mock("@/app/lib/v2/engine/sources", () => ({
  createEngine: () => {
    if (!engine.current) throw new Error("this test set up no engine");
    return engine.current;
  },
}));

import * as statusRoute from "@/app/api/v2/status/route";
import * as tickRoute from "@/app/api/v2/cron/tick/route";
import * as webhookRoute from "@/app/api/v2/telegram/webhook/route";

const USER = "11111111-1111-4111-8111-111111111111";
const BROKEN = "22222222-2222-4222-8222-222222222222";
const HUNG = "33333333-3333-4333-8333-333333333333";
const TASK_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const CHAT = "4242";
const HASH = "a".repeat(64);
const NOW = "2026-11-09T17:00:00.000Z";
const MINUTE = 60_000;

const RULES: RulesDocument = {
  planner: {
    timeZone: "America/Phoenix",
    wakeByWeekday: ["08:00", "08:00", "08:00", "08:00", "08:00", "08:00", "08:00"],
    noFocusBefore: "09:00",
    lightsOut: "23:00",
  },
  lanes: [
    { key: "lane-a", label: "Lane A", color: "#b5ff3c", groupIds: ["g1"], hardDates: false },
  ],
  feedLabels: {},
};

const BAD_RULES: RulesDocument = {
  planner: { timeZone: "America/Phoenix", lightsOut: "25:00" },
  lanes: [],
  feedLabels: {},
};

const candidate: Candidate = {
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
};

const CALENDAR_OK: FeedRun = {
  feed: "calendar",
  startedAt: NOW,
  finishedAt: NOW,
  status: "ok",
  count: 0,
  errorClass: null,
};

async function setEngine(
  over: { users?: Array<{ userId: string; rules: RulesDocument; enabled?: boolean }> } = {},
): Promise<{ stores: Stores; telegram: FakeTelegram; deps: TickDeps }> {
  const stores = createMemoryStores();
  for (const user of over.users ?? [{ userId: USER, rules: RULES }]) {
    await stores.users.save(user.userId, { rules: user.rules, enabled: user.enabled ?? true });
  }
  await stores.channels.setPairing(USER, HASH, new Date(Date.parse(NOW) + 60 * MINUTE).toISOString());
  await stores.channels.redeemPairing(HASH, CHAT, NOW);
  const telegram = new FakeTelegram();
  let n = 0;
  const deps: TickDeps = {
    stores,
    telegram,
    loadFixed: async () => ({ fixed: [], calendar: CALENDAR_OK }),
    loadCandidates: async () => [candidate],
    loadWeekCapHours: async () => ({ hours: 0, ok: true }),
    newId: () => `bbbbbbbb-bbbb-4bbb-8bbb-${String(++n).padStart(12, "0")}`,
    probes: [],
  };
  engine.current = { stores, deps };
  return { stores, telegram, deps };
}

function post(url: string, init: RequestInit = {}): Request {
  return new Request(url, { method: "POST", ...init });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  engine.current = null;
  delete process.env.V2_CRON_SECRET;
  delete process.env.V2_STATUS_SECRET;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/v2/cron/tick", () => {
  test("is configured for the node runtime with a minute to work in", () => {
    expect(tickRoute.runtime).toBe("nodejs");
    expect(tickRoute.maxDuration).toBe(60);
  });

  test("answers 503 while the secret is unset", async () => {
    await setEngine();
    const response = await tickRoute.POST(post("https://example.test/api/v2/cron/tick"));
    expect(response.status).toBe(503);
  });

  test("answers 401 for a wrong bearer, and never runs the engine", async () => {
    const { stores } = await setEngine();
    process.env.V2_CRON_SECRET = "right-secret";
    const response = await tickRoute.POST(
      post("https://example.test/api/v2/cron/tick", {
        headers: { authorization: "Bearer wrong-secret" },
      }),
    );
    expect(response.status).toBe(401);
    expect(await stores.blocks.listForDate(USER, "2026-11-09")).toEqual([]);
  });

  test("answers 401 for no bearer at all", async () => {
    await setEngine();
    process.env.V2_CRON_SECRET = "right-secret";
    const response = await tickRoute.POST(post("https://example.test/api/v2/cron/tick"));
    expect(response.status).toBe(401);
  });

  test("runs the tick for every enabled account and answers counts only", async () => {
    const { stores } = await setEngine();
    process.env.V2_CRON_SECRET = "right-secret";
    const response = await tickRoute.POST(
      post("https://example.test/api/v2/cron/tick", {
        headers: { authorization: "Bearer right-secret" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ users: 1, failed: 0 });
    expect(await stores.blocks.listForDate(USER, "2026-11-09")).toHaveLength(1);
  });

  test("one failing account never stops the next", async () => {
    const { stores } = await setEngine({
      users: [
        { userId: BROKEN, rules: BAD_RULES },
        { userId: USER, rules: RULES },
      ],
    });
    process.env.V2_CRON_SECRET = "right-secret";
    const response = await tickRoute.POST(
      post("https://example.test/api/v2/cron/tick", {
        headers: { authorization: "Bearer right-secret" },
      }),
    );
    expect(await response.json()).toEqual({ users: 2, failed: 1 });
    expect(await stores.blocks.listForDate(USER, "2026-11-09")).toHaveLength(1);
  });

  test("an account whose tick hangs is abandoned, and the next one still runs", async () => {
    // The shared setup fakes only Date; the route's deadline is a real timer.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date(NOW));
    const stores = createMemoryStores();
    await stores.users.save(HUNG, { rules: RULES, enabled: true });
    await stores.users.save(USER, { rules: RULES, enabled: true });
    let n = 0;
    const deps: TickDeps = {
      stores,
      telegram: new FakeTelegram(),
      // The account that hangs is the FIRST one, so the assertion below is
      // about the route's deadline and not about running order.
      loadFixed: async (userId) =>
        userId === HUNG
          ? new Promise(() => {})
          : { fixed: [], calendar: CALENDAR_OK },
      loadCandidates: async () => [candidate],
      loadWeekCapHours: async () => ({ hours: 0, ok: true }),
      newId: () => `bbbbbbbb-bbbb-4bbb-8bbb-${String(++n).padStart(12, "0")}`,
      probes: [],
    };
    engine.current = { stores, deps };
    process.env.V2_CRON_SECRET = "right-secret";

    const pending = tickRoute.POST(
      post("https://example.test/api/v2/cron/tick", {
        headers: { authorization: "Bearer right-secret" },
      }),
    );
    await vi.advanceTimersByTimeAsync(TICK_DEADLINE_MS);
    const response = await pending;

    expect(await response.json()).toEqual({ users: 2, failed: 1 });
    // The abandoned account says so on its own feed.
    const runs = await stores.feeds.listRuns(HUNG, "2026-01-01T00:00:00.000Z");
    expect(runs.find((run) => run.feed === ENGINE_TICK_FEED)).toMatchObject({
      status: "error",
      errorClass: "timeout",
    });
    // And the account behind it was planned anyway.
    expect(await stores.blocks.listForDate(USER, "2026-11-09")).toHaveLength(1);
  });

  test("skips an account whose engine is switched off", async () => {
    await setEngine({
      users: [
        { userId: USER, rules: RULES, enabled: true },
        { userId: BROKEN, rules: RULES, enabled: false },
      ],
    });
    process.env.V2_CRON_SECRET = "right-secret";
    const response = await tickRoute.POST(
      post("https://example.test/api/v2/cron/tick", {
        headers: { authorization: "Bearer right-secret" },
      }),
    );
    expect(await response.json()).toEqual({ users: 1, failed: 0 });
  });
});

describe("POST /api/v2/telegram/webhook", () => {
  const secretHeader = "x-telegram-bot-api-secret-token";

  function update(body: unknown, secret?: string): Request {
    return post("https://example.test/api/v2/telegram/webhook", {
      headers: {
        "content-type": "application/json",
        ...(secret === undefined ? {} : { [secretHeader]: secret }),
      },
      body: JSON.stringify(body),
    });
  }

  test("answers 401 when the secret header does not match", async () => {
    await setEngine();
    process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret";
    expect((await webhookRoute.POST(update({}, "wrong"))).status).toBe(401);
    expect((await webhookRoute.POST(update({}))).status).toBe(401);
  });

  test("answers 401 while the secret is unset, whatever the header says", async () => {
    await setEngine();
    expect((await webhookRoute.POST(update({}, "anything"))).status).toBe(401);
  });

  test("answers 200 for an update it cannot parse, and does nothing", async () => {
    const { telegram } = await setEngine();
    process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret";
    for (const body of [{}, { update_id: 1 }, { message: { chat: {} } }, [1, 2, 3]]) {
      expect((await webhookRoute.POST(update(body, "hook-secret"))).status).toBe(200);
    }
    expect(telegram.sent).toEqual([]);
  });

  test("answers 200 for a body that is not json at all", async () => {
    await setEngine();
    process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret";
    const response = await webhookRoute.POST(
      post("https://example.test/api/v2/telegram/webhook", {
        headers: { [secretHeader]: "hook-secret" },
        body: "not json",
      }),
    );
    expect(response.status).toBe(200);
  });

  test("hands a /start to the engine, which answers it", async () => {
    const { stores, telegram } = await setEngine();
    process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret";
    // The chat is linked already, so a bare /start gets the refusal. What is
    // being pinned is that the update reached the engine at all.
    const response = await webhookRoute.POST(
      update({ message: { message_id: 1, chat: { id: 7 }, text: "/start" } }, "hook-secret"),
    );
    expect(response.status).toBe(200);
    expect(telegram.sent).toHaveLength(1);
    expect(await stores.channels.userForChat("7")).toBeNull();
  });

  test("a tapped button answers its ask, and a retry of the same update changes nothing", async () => {
    const { stores, deps, telegram } = await setEngine();
    process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret";
    await stores.blocks.replacePlanned(USER, "2026-11-09", [
      {
        id: `2026-11-09:focus:${TASK_A}`,
        date: "2026-11-09",
        start: "2026-11-09T17:00:00.000Z",
        end: "2026-11-09T17:50:00.000Z",
        kind: "focus",
        lane: "lane-a",
        taskId: TASK_A,
        title: "Write the brief",
        state: "planned",
        reason: "lane-next",
      },
    ]);
    vi.setSystemTime(new Date(Date.parse(NOW) + 20 * MINUTE));
    await runTick(deps, USER, new Date().toISOString());
    const ask = (await stores.asks.listOpen(USER)).find((open) => open.kind === "slip");
    if (ask === undefined) throw new Error("the tick opened no slip ask");
    telegram.sent.length = 0;

    const body = {
      callback_query: {
        id: "cb-1",
        data: `a:${ask.id}:did`,
        message: { message_id: 9, chat: { id: Number(CHAT) }, text: "Still doing Write the brief?" },
      },
    };
    expect((await webhookRoute.POST(update(body, "hook-secret"))).status).toBe(200);
    expect(
      (await stores.blocks.listForDate(USER, "2026-11-09")).find(
        (block) => block.taskId === TASK_A,
      )?.state,
    ).toBe("done");
    expect(telegram.sent.map((call) => call.method)).toEqual([
      "answerCallback",
      "replaceButtons",
    ]);

    telegram.sent.length = 0;
    expect((await webhookRoute.POST(update(body, "hook-secret"))).status).toBe(200);
    expect(telegram.sent.map((call) => call.method)).toEqual(["answerCallback"]);
  });
});

describe("GET /api/v2/status", () => {
  function get(secret?: string): Request {
    return new Request("https://example.test/api/v2/status", {
      headers: secret === undefined ? {} : { authorization: `Bearer ${secret}` },
    });
  }

  test("answers 503 while the secret is unset and 401 for a wrong one", async () => {
    await setEngine();
    expect((await statusRoute.GET(get("anything"))).status).toBe(503);
    process.env.V2_STATUS_SECRET = "status-secret";
    expect((await statusRoute.GET(get("wrong"))).status).toBe(401);
    expect((await statusRoute.GET(get())).status).toBe(401);
  });

  test("answers ok with the newest tick and how stale it is", async () => {
    const { deps } = await setEngine();
    process.env.V2_STATUS_SECRET = "status-secret";
    await runTick(deps, USER, NOW);
    vi.setSystemTime(new Date(Date.parse(NOW) + 10 * MINUTE));

    const response = await statusRoute.GET(get("status-secret"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      lastTickAt: NOW,
      staleMinutes: 10,
    });
  });

  test("is not ok past thirty minutes, and carries no per account data", async () => {
    const { deps } = await setEngine();
    process.env.V2_STATUS_SECRET = "status-secret";
    await runTick(deps, USER, NOW);
    vi.setSystemTime(new Date(Date.parse(NOW) + 31 * MINUTE));

    const response = await statusRoute.GET(get("status-secret"));
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: false, lastTickAt: NOW, staleMinutes: 31 });
    expect(JSON.stringify(body)).not.toContain(USER);
  });

  test("is not ok when nothing has ticked", async () => {
    await setEngine();
    process.env.V2_STATUS_SECRET = "status-secret";
    expect(await (await statusRoute.GET(get("status-secret"))).json()).toEqual({
      ok: false,
      lastTickAt: null,
      staleMinutes: null,
    });
  });
});
