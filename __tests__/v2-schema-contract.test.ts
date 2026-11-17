// @vitest-environment node
//
// Every column name the v2 engine sends to Postgres, checked against the real
// schema.
//
// This file exists because of a defect nothing else could have caught:
// `engine/sources.ts` selected `income_sources.google_calendar_id`, a column
// that has never existed (0007_finance_recurring.sql calls it `calendar_id`).
// On the rehearsed schema that select answers 42703, which took the plan, the
// morning message and "later today" down on every tick, for every account. The
// unit tests passed because they stubbed rows with the same wrong key: a stub
// is only ever as right as the person who wrote it, so the schema has to be the
// thing that answers.
//
// It applies every migration to an in-memory Postgres (PGlite; see
// test/migrations/README.md), prepares that database once, and then asserts
// three things.
//
//   1. THE EXISTING TABLES. `engine/sources.ts` and `engine/probes.ts` are
//      driven with a recording client, so what is checked is what they
//      actually send, not a second list that could drift. Their exported
//      descriptors (SOURCE_QUERIES, PROBE_QUERIES) have to name that same set,
//      both ways, so the declaration and the query cannot disagree either.
//   2. THE NINE v2_* TABLES. The set of columns the mappers map equals the
//      table's columns, both ways: a column the store never maps is as much a
//      finding as a mapped column that does not exist, so every unmapped
//      column is named below with the reason it is unmapped.
//   3. store/supabase.ts. The real `createSupabaseStores` is driven the same
//      way, so every select list, filter, order, onConflict target and payload
//      key is checked, and so are the RPC's argument names and the jsonb keys
//      of the plan rows it sends.
//
// Nothing here talks to Google: the calendar module is mocked, because the
// subject is column names.

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

vi.mock("@/utils/google/calendar", () => ({
  listEvents: async () => [],
  GoogleCalendarConnectionError: class GoogleCalendarConnectionError extends Error {},
}));

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  SOURCE_QUERIES,
  createLoadCandidates,
  createLoadFixed,
  createLoadWeekCapHours,
} from "@/app/lib/v2/engine/sources";
import { PROBE_QUERIES, homeWorkerProbe } from "@/app/lib/v2/engine/probes";
import {
  emptyDayRow,
  toAlertRow,
  toAskRow,
  toBlockRow,
  toChannelRow,
  toExpectationRow,
  toFeedRunRow,
  toOutboxRow,
  toPlanRows,
  toRulesRow,
} from "@/app/lib/v2/store/mappers";
import { createSupabaseStores } from "@/app/lib/v2/store/supabase";
import type { EngineUser } from "@/app/lib/v2/store/types";
import type { Alert, Ask, Block, FeedRun } from "@/app/lib/v2/types";
import { applyMigrations, createDatabase } from "../test/migrations/harness.mjs";

const USER = "11111111-1111-4111-8111-111111111111";
const ASK_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OUTBOX_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ALERT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TASK_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const DATE = "2026-11-09";
const NOW = "2026-11-09T21:00:00.000Z";
const HASH = "a".repeat(64);
const ZONE = "America/Phoenix";

// ---------------------------------------------------------------- the schema

type Db = Awaited<ReturnType<typeof createDatabase>>;

let columnsByTable = new Map<string, Set<string>>();
/** `pg_get_functiondef` of the one function 0066 creates, plus its argument names. */
let replacePlanned: { def: string; args: string[] } = { def: "", args: [] };

beforeAll(async () => {
  const db: Db = await createDatabase();
  try {
    await applyMigrations(db);
    const { rows } = await db.query(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public'`,
    );
    columnsByTable = new Map();
    for (const row of rows as Array<{ table_name: string; column_name: string }>) {
      const set = columnsByTable.get(row.table_name) ?? new Set<string>();
      set.add(row.column_name);
      columnsByTable.set(row.table_name, set);
    }

    const fn = await db.query(
      `select pg_get_functiondef(p.oid) as def, p.proargnames as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'v2_replace_planned_blocks'`,
    );
    const first = (fn.rows as Array<{ def: string; args: string[] }>)[0];
    replacePlanned = first ?? { def: "", args: [] };
  } finally {
    await db.close();
  }
});

function columnsOf(table: string): Set<string> {
  const columns = columnsByTable.get(table);
  if (columns === undefined) throw new Error(`no table ${table} in the migrated schema`);
  return columns;
}

/** The names a select list, an onConflict target or a column list holds. */
function namesIn(list: string): string[] {
  return list
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

// ------------------------------------------------------- the recording client
//
// A PostgREST stub that answers every chain with one canned row and records the
// table and column of everything it was asked for. The adapters and the stores
// therefore run their REAL query chains: the recording is what they sent.

type How = "select" | "filter" | "order" | "onConflict" | "payload";

interface Sent {
  table: string;
  column: string;
  how: How;
}

interface Rpc {
  name: string;
  args: Record<string, unknown>;
}

function recordingClient(
  rows: Record<string, unknown>,
  options: { nullFirstMaybeSingle?: boolean } = {},
): { client: SupabaseClient; sent: Sent[]; rpcs: Rpc[] } {
  const sent: Sent[] = [];
  const rpcs: Rpc[] = [];
  let nulls = options.nullFirstMaybeSingle === true ? 1 : 0;

  const note = (table: string, column: string, how: How) => {
    sent.push({ table, column, how });
  };

  const FILTERS = [
    "eq",
    "neq",
    "in",
    "is",
    "gt",
    "gte",
    "lt",
    "lte",
    "like",
    "ilike",
    "contains",
    "filter",
    "not",
  ] as const;

  function builder(table: string): Record<string, unknown> {
    const row = table in rows ? rows[table] : null;
    const chain: Record<string, unknown> = {};

    for (const name of FILTERS) {
      chain[name] = (column: string) => {
        note(table, column, "filter");
        return chain;
      };
    }
    chain.order = (column: string) => {
      note(table, column, "order");
      return chain;
    };
    chain.limit = () => chain;
    chain.range = () => chain;
    chain.select = (list?: string) => {
      if (typeof list === "string") for (const name of namesIn(list)) note(table, name, "select");
      return chain;
    };
    chain.delete = () => chain;

    const write = (values: unknown, opts?: { onConflict?: string }) => {
      for (const value of Array.isArray(values) ? values : [values]) {
        if (value !== null && typeof value === "object") {
          for (const key of Object.keys(value as Record<string, unknown>)) {
            note(table, key, "payload");
          }
        }
      }
      if (typeof opts?.onConflict === "string") {
        for (const name of namesIn(opts.onConflict)) note(table, name, "onConflict");
      }
      return chain;
    };
    chain.insert = write;
    chain.upsert = write;
    chain.update = write;

    chain.maybeSingle = async () => ({
      data: nulls-- > 0 ? null : row,
      error: null,
    });
    chain.single = async () => ({ data: row, error: null });
    chain.then = (resolve: (answer: unknown) => unknown) =>
      resolve({ data: row === null ? [] : [row], error: null, count: 0 });

    return chain;
  }

  const client = {
    from: (table: string) => builder(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      return { data: null, error: null };
    },
  };
  return { client: client as unknown as SupabaseClient, sent, rpcs };
}

const tablesOf = (sent: Sent[]): string[] => [...new Set(sent.map((entry) => entry.table))];

const columnsSentTo = (sent: Sent[], table: string): Set<string> =>
  new Set(sent.filter((entry) => entry.table === table).map((entry) => entry.column));

/** Every (table, column) pair that is not a column of that table. */
function unknownColumns(sent: Sent[]): string[] {
  const out = new Set<string>();
  for (const entry of sent) {
    if (!columnsOf(entry.table).has(entry.column)) {
      out.add(`${entry.table}.${entry.column} (${entry.how})`);
    }
  }
  return [...out].sort();
}

// ------------------------------------------------------------- canned rows

const user: EngineUser = {
  userId: USER,
  timeZone: ZONE,
  rules: {
    planner: { timeZone: ZONE },
    lanes: [
      { key: "lane-a", label: "Lane A", color: "#b5ff3c", groupIds: ["g1"], hardDates: true },
    ],
    feedLabels: {},
  },
};

const block: Block = {
  id: `${DATE}:focus:${TASK_ID}`,
  date: DATE,
  start: "2026-11-09T21:00:00.000Z",
  end: "2026-11-09T21:50:00.000Z",
  kind: "focus",
  lane: "lane-a",
  taskId: TASK_ID,
  title: "Write the brief",
  state: "planned",
  reason: "lane-next",
};

const ask: Ask = {
  id: ASK_ID,
  userId: USER,
  kind: "slip",
  topic: `task:${TASK_ID}`,
  text: "Still doing Write the brief?",
  options: [{ id: "did", label: "Did it", effect: { type: "block.done", blockId: block.id, fraction: 1 } }],
  defaultOptionId: "did",
  timeCritical: true,
  openedAt: NOW,
  remindAt: null,
  remindedAt: null,
  expiresAt: NOW,
  status: "open",
  answeredOptionId: null,
  answeredAt: null,
  assumed: false,
  dedupeKey: `slip:${block.id}`,
};

const alert: Alert = {
  id: ALERT_ID,
  cause: "no-run",
  feeds: ["calendar"],
  since: NOW,
  step: 0,
  lastSentAt: null,
  status: "open",
};

const feedRun: FeedRun = {
  feed: "calendar",
  startedAt: NOW,
  finishedAt: NOW,
  status: "ok",
  count: 1,
  errorClass: null,
};

/** One valid row per v2 table, built by the mappers so it is a row the store accepts. */
const V2_ROWS: Record<string, Record<string, unknown>> = {
  v2_rules: toRulesRow(USER, { planner: {}, lanes: [], feedLabels: {} }, true) as unknown as Record<
    string,
    unknown
  >,
  v2_days: emptyDayRow(USER, DATE) as unknown as Record<string, unknown>,
  v2_blocks: toBlockRow(USER, block) as unknown as Record<string, unknown>,
  v2_asks: toAskRow(USER, ask) as unknown as Record<string, unknown>,
  v2_outbox: toOutboxRow(USER, {
    id: OUTBOX_ID,
    userId: USER,
    kind: "ask",
    dedupeKey: `ask:${ASK_ID}`,
    delivery: "interrupt",
    message: { text: "Still doing Write the brief?", buttons: [] },
    askId: ASK_ID,
    createdAt: NOW,
    claimedAt: null,
    sentAt: null,
    chatMessageId: null,
    error: null,
  }) as unknown as Record<string, unknown>,
  v2_feed_expectations: toExpectationRow(USER, {
    feed: "calendar",
    everyMinutes: 60,
    graceMinutes: 10,
    minCount: 0,
    activeHours: null,
    label: "the calendar",
    enabledAt: NOW,
  }) as unknown as Record<string, unknown>,
  v2_feed_runs: toFeedRunRow(USER, feedRun) as unknown as Record<string, unknown>,
  v2_alerts: toAlertRow(USER, alert) as unknown as Record<string, unknown>,
  v2_channels: toChannelRow(USER, {
    userId: USER,
    chatId: "4242",
    linkedAt: NOW,
  }) as unknown as Record<string, unknown>,
};

/**
 * Columns of a v2 table that no mapper maps, each with the reason. A column
 * missing from here fails the both-ways check below, which is the point: a
 * column the store never reads or writes is a finding until someone says why.
 */
const UNMAPPED: Record<string, Record<string, string>> = {
  v2_rules: {
    created_at:
      "set by the table default; nothing above the store asks when an account was switched on",
  },
  v2_days: {},
  v2_blocks: {
    created_at: "set by the table default; a block's own date and times are what the engine reads",
  },
  v2_asks: {
    created_at: "set by the table default; openedAt is the instant the lifecycle reasons about",
  },
  v2_outbox: {},
  v2_feed_expectations: {},
  v2_feed_runs: {
    id: "the row's own uuid, defaulted by the table; a run is read as a value and is never updated or deleted by id",
  },
  v2_alerts: {
    created_at: "set by the table default; `since` is the instant the watchdog reasons about",
  },
  v2_channels: {
    created_at: "set by the table default",
    pairing_hash:
      "written and cleared inside channels.setPairing and redeemPairing and never read into a domain value, so a live pairing hash cannot leave the store",
    pairing_expires_at: "the other half of the pairing hash, for the same reason",
  },
};

// --------------------------------------------------------------- the tests

describe("the rehearsed schema", () => {
  it("holds every table the v2 engine names", () => {
    const named = [
      ...SOURCE_QUERIES.map((query) => query.table),
      ...PROBE_QUERIES.map((query) => query.table),
      ...Object.keys(V2_ROWS),
    ];
    for (const table of new Set(named)) {
      expect(columnsByTable.has(table), `no table ${table} in the migrated schema`).toBe(true);
    }
  });
});

describe("engine/sources.ts and engine/probes.ts against the schema", () => {
  async function drive(): Promise<Sent[]> {
    const { client, sent } = recordingClient({
      income_sources: { calendar_id: "cal-1" },
      tasks: {
        id: TASK_ID,
        title: "Write the brief",
        group_id: "g1",
        due_date: DATE,
        due_time: "13:00",
        status: "todo",
        estimated_minutes: 50,
        duration_min: 90,
        gcal_event_id: null,
        gcal_calendar_id: null,
      },
      v2_blocks: V2_ROWS.v2_blocks,
      worker_status: { last_seen_at: NOW },
    });
    await createLoadFixed(client)(USER, DATE, user);
    await createLoadCandidates(client)(USER, user, NOW);
    await createLoadWeekCapHours(client)(USER, DATE, DATE, user);
    await homeWorkerProbe(client)(USER, NOW);
    return sent;
  }

  it("sends only columns that exist", async () => {
    expect(unknownColumns(await drive())).toEqual([]);
  });

  it("sends exactly what its descriptors declare, both ways", async () => {
    const sent = await drive();
    const declared = new Map<string, Set<string>>();
    for (const query of [...SOURCE_QUERIES, ...PROBE_QUERIES]) {
      const set = declared.get(query.table) ?? new Set<string>();
      for (const name of namesIn(query.select)) set.add(name);
      for (const name of query.where) set.add(name);
      declared.set(query.table, set);
    }

    expect(tablesOf(sent).sort()).toEqual([...declared.keys()].sort());
    for (const [table, columns] of declared) {
      expect([...columnsSentTo(sent, table)].sort(), `${table}: sent`).toEqual(
        [...columns].sort(),
      );
    }
  });
});

describe("store/mappers.ts against the schema", () => {
  it("maps every column of every v2 table, and no column that does not exist", () => {
    for (const [table, row] of Object.entries(V2_ROWS)) {
      const mapped = new Set(Object.keys(row));
      const actual = columnsOf(table);
      const named = UNMAPPED[table] ?? {};

      expect(
        [...mapped].filter((column) => !actual.has(column)).sort(),
        `${table}: mapped but not in the schema`,
      ).toEqual([]);
      expect(
        [...actual].filter((column) => !mapped.has(column) && !(column in named)).sort(),
        `${table}: in the schema but mapped nowhere and not named in UNMAPPED`,
      ).toEqual([]);
    }
  });

  it("gives every unmapped column a reason, and leaves no stale entry", () => {
    for (const [table, named] of Object.entries(UNMAPPED)) {
      const actual = columnsOf(table);
      const mapped = new Set(Object.keys(V2_ROWS[table]));
      for (const [column, why] of Object.entries(named)) {
        expect(actual.has(column), `${table}.${column} is not a column at all`).toBe(true);
        expect(mapped.has(column), `${table}.${column} IS mapped: delete the entry`).toBe(false);
        expect(why.length, `${table}.${column} needs a real reason`).toBeGreaterThan(20);
      }
    }
  });
});

describe("store/supabase.ts against the schema", () => {
  async function drive(options: { nullFirstMaybeSingle?: boolean } = {}) {
    const { client, sent, rpcs } = recordingClient(V2_ROWS, options);
    const stores = createSupabaseStores(client);

    await stores.users.listEnabled();
    await stores.users.get(USER);
    await stores.users.save(USER, { rules: { planner: {}, lanes: [], feedLabels: {} }, enabled: true });

    await stores.days.get(USER, DATE);
    await stores.days.patch(USER, DATE, {
      energy: "ok",
      energyAssumed: true,
      mode: "normal",
      plannedAt: NOW,
      morningSentAt: NOW,
      dropped: [],
      leaveBy: [],
    });

    await stores.blocks.listForDate(USER, DATE);
    await stores.blocks.listOpenBefore(USER, DATE);
    await stores.blocks.replacePlanned(USER, DATE, [block]);
    await stores.blocks.setState(USER, block.id, "skipped", {
      reason: "day ended",
      from: "planned",
    });
    await stores.blocks.setTime(USER, block.id, block.start, block.end);

    await stores.asks.insert(USER, ask);
    await stores.asks.get(USER, ASK_ID);
    await stores.asks.listOpen(USER);
    await stores.asks.answer(USER, ASK_ID, "did", NOW);
    await stores.asks.expire(USER, ASK_ID, NOW);
    await stores.asks.remind(USER, ASK_ID, NOW);
    await stores.asks.countUnanswered(USER, ask.topic, NOW);

    await stores.outbox.enqueue(USER, {
      id: OUTBOX_ID,
      userId: USER,
      kind: "ask",
      dedupeKey: `ask:${ASK_ID}`,
      delivery: "interrupt",
      message: { text: "Still doing Write the brief?", buttons: [] },
      askId: ASK_ID,
      createdAt: NOW,
      claimedAt: null,
      sentAt: null,
      chatMessageId: null,
      error: null,
    });
    await stores.outbox.listSendable(USER, "interrupt");
    await stores.outbox.listUnsent(USER);
    await stores.outbox.claim(USER, OUTBOX_ID, NOW);
    await stores.outbox.markSent(USER, OUTBOX_ID, NOW, "7");
    await stores.outbox.markFailed(USER, OUTBOX_ID, NOW, "bot-blocked");
    await stores.outbox.countInterruptsSince(USER, NOW);

    await stores.feeds.listExpectations(USER);
    await stores.feeds.saveExpectation(USER, {
      feed: "calendar",
      everyMinutes: 60,
      graceMinutes: 10,
      minCount: 0,
      activeHours: null,
      label: "the calendar",
      enabledAt: NOW,
    });
    await stores.feeds.addRun(USER, feedRun);
    await stores.feeds.listRuns(USER, NOW);
    await stores.feeds.prune(USER, NOW);

    await stores.alerts.listOpen(USER);
    await stores.alerts.save(USER, alert);
    await stores.alerts.lastAnnounced(USER, alert.cause);

    await stores.channels.get(USER);
    await stores.channels.setPairing(USER, HASH, NOW);
    await stores.channels.redeemPairing(HASH, "4242", NOW);
    await stores.channels.userForChat("4242");

    return { sent, rpcs };
  }

  it("sends only columns that exist, on every table it touches", async () => {
    const { sent } = await drive();
    expect(unknownColumns(sent)).toEqual([]);
    // Every v2 table, so a method that was never driven cannot hide here.
    expect(tablesOf(sent).sort()).toEqual(Object.keys(V2_ROWS).sort());
  });

  it("sends only columns that exist on the ask read-back path too", async () => {
    // asks.insert reads the stored ask back when the dedupe key was already
    // used, which is a filter the happy path never sends.
    const { sent } = await drive({ nullFirstMaybeSingle: true });
    expect(unknownColumns(sent)).toEqual([]);
    expect(columnsSentTo(sent, "v2_asks").has("dedupe_key")).toBe(true);
  });

  it("calls v2_replace_planned_blocks with the arguments the function declares", async () => {
    const { rpcs } = await drive();
    const call = rpcs.find((rpc) => rpc.name === "v2_replace_planned_blocks");
    expect(call, "blocks.replacePlanned did not call the function").toBeDefined();
    expect(replacePlanned.args, "0066 does not declare this function").not.toEqual([]);
    expect(Object.keys(call!.args).sort()).toEqual([...replacePlanned.args].sort());
  });

  it("sends plan rows whose keys are v2_blocks columns, and all the function reads", () => {
    const keys = new Set(Object.keys(toPlanRows(USER, DATE, [block])[0]));
    const actual = columnsOf("v2_blocks");
    expect([...keys].filter((key) => !actual.has(key)).sort()).toEqual([]);

    // The function reads the plan rows as jsonb, so a key it reads and the
    // store does not send arrives as null however well the column is named.
    const read = new Set(
      [...replacePlanned.def.matchAll(/block->>'([a-z_]+)'/g)].map((match) => match[1]),
    );
    expect(read.size, "the function body reads no jsonb key").toBeGreaterThan(0);
    expect([...read].filter((key) => !keys.has(key)).sort()).toEqual([]);
  });
});
