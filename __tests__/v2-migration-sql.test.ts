// Task 6, the migrations: 0066 and 0067 are read as text here, because neither
// has been applied and neither will be by this suite. Task 9's rehearsal runs
// every migration in an in-memory Postgres; this file is the cheap gate that
// catches the three mistakes a reviewer skims past - a table whose row level
// security was never switched on, a client write policy, and a grant that
// quietly hands a role more than select.
//
// It is a text check, so it proves shape, not behaviour. What it does buy is
// that a tenth table added to 0066 in a hurry cannot ship without its revoke,
// its RLS and its policy.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");

const ENGINE = readFileSync(path.join(MIGRATIONS, "0066_v2_engine.sql"), "utf8");
const SCHEDULE = readFileSync(path.join(MIGRATIONS, "0067_v2_tick_schedule.sql"), "utf8");

const FILES: Array<[string, string]> = [
  ["0066_v2_engine.sql", ENGINE],
  ["0067_v2_tick_schedule.sql", SCHEDULE],
];

// The nine tables the plan fixes the names of. Listed here rather than derived
// so that a table added to the file without a test entry is a failure, not a
// silent pass.
const TABLES = [
  "v2_rules",
  "v2_days",
  "v2_blocks",
  "v2_asks",
  "v2_outbox",
  "v2_feed_expectations",
  "v2_feed_runs",
  "v2_alerts",
  "v2_channels",
];

// The two tables the server alone touches. No select policy, and therefore no
// grant to authenticated at all.
const SERVER_ONLY = ["v2_outbox", "v2_channels"];

/** The statements that applying 0066 actually runs, without the function body. */
const FUNCTION_AT = ENGINE.search(/^\s*create\s+(or\s+replace\s+)?function/im);
const STATEMENTS = ENGINE.slice(ENGINE.search(/^\s*create\s+table/im), FUNCTION_AT);
const FUNCTION = ENGINE.slice(FUNCTION_AT);

function createdTables(sql: string): string[] {
  return [...sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z0-9_]+)/gi)].map(
    (m) => m[1],
  );
}

/** Single-quoted string literals, so an identifier like net.http_post is not one. */
function stringLiterals(sql: string): string[] {
  return [...sql.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

describe("0066 and 0067: both files", () => {
  test("are ASCII only, so no smart quote or dash can reach psql", () => {
    for (const [name, sql] of FILES) {
      const bad = [...sql].filter((ch) => ch.charCodeAt(0) > 127);
      expect(bad, `${name} has non-ASCII characters: ${JSON.stringify(bad)}`).toEqual([]);
    }
  });

  test("open with a header saying what they do, that they are not applied, what must exist first, and how to undo them", () => {
    for (const [name, sql] of FILES) {
      const header = sql.slice(0, sql.search(/^\s*(create|do|select|alter|revoke|grant)\b/im));
      expect(header.length, `${name} has no header comment`).toBeGreaterThan(400);
      expect(header.toLowerCase(), `${name} must say it has not been applied`).toContain(
        "not applied",
      );
      expect(header.toLowerCase(), `${name} must say what has to exist first`).toContain("first");
      expect(header.toLowerCase(), `${name} must give the statements that remove it`).toMatch(
        /drop |unschedule/,
      );
    }
  });

  test("do no time-zone arithmetic: local dates are filled by the app", () => {
    for (const [name, sql] of FILES) {
      expect(sql.toLowerCase(), `${name} must not use at time zone`).not.toContain("at time zone");
      expect(sql.toLowerCase(), `${name} must not call timezone()`).not.toContain("timezone(");
    }
  });

  test("grant nothing to anon", () => {
    for (const [name, sql] of FILES) {
      const grants = [...sql.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => m[0]);
      for (const grant of grants) {
        expect(/\banon\b/i.test(grant), `${name} grants to anon: ${grant}`).toBe(false);
      }
    }
  });
});

describe("0066: new tables only", () => {
  test("creates exactly the nine engine tables", () => {
    expect(createdTables(ENGINE).sort()).toEqual([...TABLES].sort());
  });

  test("changes no existing table, column, policy or row", () => {
    // Only the new tables may be altered (that is how RLS is switched on), and
    // nothing may be inserted, updated, deleted or dropped.
    const alters = [...ENGINE.matchAll(/alter\s+table\s+(?:public\.)?([a-z0-9_]+)/gi)].map(
      (m) => m[1],
    );
    for (const table of alters) {
      expect(TABLES, `0066 alters ${table}, which it did not create`).toContain(table);
    }
    for (const forbidden of [
      /\binsert\s+into\b/i,
      /\bupdate\s+public\./i,
      /\bdelete\s+from\b/i,
      /\bdrop\s+(table|policy|constraint|index)\b/i,
      /\balter\s+policy\b/i,
    ]) {
      // The header comment names the drop statements that undo the migration,
      // and the function DEFINITION contains a delete and an update that run
      // only when it is called, so neither is part of what applying this file
      // does. Both are excluded; the function's own body is checked below.
      expect(forbidden.test(STATEMENTS), `0066 must not contain ${forbidden}`).toBe(false);
    }
  });

  test("creates exactly one function, with a name that cannot replace an existing one", () => {
    const functions = [
      ...ENGINE.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.([a-z0-9_]+)/gi),
    ].map((m) => m[1]);
    expect(functions).toEqual(["v2_replace_planned_blocks"]);
  });

  test("gives every table a cascading user_id and switches row level security on", () => {
    for (const table of TABLES) {
      const start = ENGINE.indexOf(`create table public.${table} (`);
      expect(start, `${table} is not created`).toBeGreaterThanOrEqual(0);
      const body = ENGINE.slice(start, ENGINE.indexOf(");", start));
      expect(body, `${table} needs a cascading user_id`).toContain(
        "user_id uuid not null references auth.users (id) on delete cascade",
      );
      expect(
        ENGINE.includes(`alter table public.${table} enable row level security;`),
        `${table} has no enable row level security`,
      ).toBe(true);
    }
  });

  test("switches row level security on for every table it creates, in that table's own statement", () => {
    // The pairing that actually matters: a create with no matching enable.
    const created = createdTables(ENGINE);
    const enabled = [
      ...ENGINE.matchAll(/alter\s+table\s+public\.([a-z0-9_]+)\s+enable\s+row\s+level\s+security/gi),
    ].map((m) => m[1]);
    expect([...created].sort()).toEqual([...enabled].sort());
  });

  test("has no insert, update, delete or all policy anywhere", () => {
    const policies = [...ENGINE.matchAll(/create\s+policy[^;]*;/gi)].map((m) => m[0]);
    expect(policies.length, "0066 defines no policy at all").toBeGreaterThan(0);
    for (const policy of policies) {
      expect(/\bfor\s+select\b/i.test(policy), `not a select policy: ${policy}`).toBe(true);
      for (const verb of ["insert", "update", "delete", "all"]) {
        expect(
          new RegExp(`\\bfor\\s+${verb}\\b`, "i").test(policy),
          `0066 has a ${verb} policy: ${policy}`,
        ).toBe(false);
      }
    }
  });

  test("writes every policy as (select auth.uid()) = user_id", () => {
    const policies = [...ENGINE.matchAll(/create\s+policy[^;]*;/gi)].map((m) => m[0]);
    for (const policy of policies) {
      expect(policy).toContain("(select auth.uid()) = user_id");
      expect(/using\s*\(\s*auth\.uid\(\)/i.test(policy), `bare auth.uid(): ${policy}`).toBe(false);
    }
  });

  test("revokes the inherited privileges on every table, and grants only select", () => {
    // New tables in public inherit every privilege for anon and authenticated
    // from Supabase's default privileges, so the policies alone would not make
    // "no client write" true. 0065 only revoked the anon default, and only for
    // tables that already existed.
    for (const table of TABLES) {
      expect(
        ENGINE.includes(`revoke all on table public.${table} from anon, authenticated;`),
        `${table} must revoke the inherited privileges`,
      ).toBe(true);
    }
    const grants = [...ENGINE.matchAll(/\bgrant\s+([^;]*?)\s+on\s+table\s+public\.([a-z0-9_]+)\s+to\s+([^;]*);/gi)];
    const granted = new Set<string>();
    for (const [, privileges, table, role] of grants) {
      expect(privileges.trim().toLowerCase(), `${table} may only grant select`).toBe("select");
      expect(role.trim().toLowerCase(), `${table} may only grant to authenticated`).toBe(
        "authenticated",
      );
      granted.add(table);
    }
    for (const table of SERVER_ONLY) {
      expect(granted.has(table), `${table} must get no grant to authenticated`).toBe(false);
    }
    expect([...granted].sort()).toEqual(TABLES.filter((t) => !SERVER_ONLY.includes(t)).sort());
  });

  test("leaves the two server-only tables without a policy", () => {
    for (const table of SERVER_ONLY) {
      expect(
        new RegExp(`create\\s+policy[^;]*on\\s+public\\.${table}\\b`, "i").test(ENGINE),
        `${table} must have no policy at all`,
      ).toBe(false);
    }
  });

  test("gives every other table exactly one select policy", () => {
    for (const table of TABLES.filter((t) => !SERVER_ONLY.includes(t))) {
      const matches = [
        ...ENGINE.matchAll(new RegExp(`create\\s+policy[^;]*on\\s+public\\.${table}\\b[^;]*;`, "gi")),
      ];
      expect(matches.length, `${table} needs exactly one select policy`).toBe(1);
    }
  });

  test("makes every foreign key to a user-owned table composite", () => {
    for (const fk of [
      "foreign key (user_id, task_id) references public.tasks (user_id, id)",
      "foreign key (user_id, ask_id) references public.v2_asks (user_id, id)",
    ]) {
      expect(ENGINE, `missing composite foreign key: ${fk}`).toContain(fk);
    }
    // The column-list form of on delete set null, so a parent delete can never
    // null user_id (0064's reason).
    expect(ENGINE).toContain("on delete set null (task_id)");
    expect(ENGINE).toContain("on delete set null (ask_id)");
    // No single-column reference to another user-owned table.
    const refs = [...ENGINE.matchAll(/references\s+public\.([a-z0-9_]+)\s*\(([^)]*)\)/gi)];
    for (const [, table, columns] of refs) {
      expect(
        columns.split(",").map((c) => c.trim()),
        `reference to ${table} must be composite`,
      ).toEqual(["user_id", "id"]);
    }
  });

  test("makes the race rules database facts", () => {
    for (const fact of [
      "primary key (user_id, id)",
      "primary key (user_id, date)",
      "primary key (user_id, feed)",
      "unique (user_id, dedupe_key)",
    ]) {
      expect(ENGINE, `missing: ${fact}`).toContain(fact);
    }
    expect(ENGINE).toMatch(
      /create unique index v2_alerts_open_cause_idx[\s\S]*?\(user_id, cause\)\s*\n?\s*where status = 'open'/,
    );
    expect(ENGINE).toMatch(/create unique index v2_channels_chat_idx[\s\S]*?\(chat_id\)/);
  });

  test("checks every text column that mirrors a union in types.ts", () => {
    for (const check of [
      "check (energy in ('low', 'ok', 'good'))",
      "check (mode in ('normal', 'short-night', 'rough-day', 'travel'))",
      "check (kind in ('floor', 'focus', 'session', 'touch', 'income', 'gym', 'small'))",
      "check (state in ('planned', 'started', 'done', 'skipped'))",
      "check (status in ('open', 'answered', 'expired', 'cancelled'))",
      "check (kind in ('morning', 'ask', 'alert', 'note'))",
      "check (delivery in ('interrupt', 'digest'))",
      "check (status in ('ok', 'error'))",
      "check (status in ('open', 'closed'))",
      "check (step in (0, 1, 2))",
    ]) {
      expect(ENGINE, `missing check constraint: ${check}`).toContain(check);
    }
  });

  test("stores instants as timestamptz and local dates as date", () => {
    expect(ENGINE).toContain("date date not null");
    // No naked timestamp, which would drop the offset the engine needs.
    expect(/\btimestamp\b(?!tz)/i.test(ENGINE.replace(/--[^\n]*/g, "")), "naked timestamp").toBe(
      false,
    );
  });

  test("keeps a pairing hash with an expiry and never the code", () => {
    expect(ENGINE).toContain("pairing_hash");
    expect(ENGINE).toContain("pairing_expires_at");
    expect(/pairing_code\b/i.test(ENGINE), "0066 must not store the code").toBe(false);
    expect(ENGINE.toLowerCase()).toContain("sha-256");
    // The column takes a digest and nothing else, so a raw code cannot land
    // there by mistake rather than merely by convention.
    expect(ENGINE).toContain("check (pairing_hash ~ '^[0-9a-f]{64}$')");
  });

  test("gives feed runs an index that serves the newest runs for one user and feed", () => {
    expect(ENGINE).toMatch(
      /create index v2_feed_runs_[a-z_]*idx on public\.v2_feed_runs \(user_id, feed, started_at desc\)/,
    );
  });
});

describe("0066: v2_replace_planned_blocks", () => {
  const SIGNATURE = "public.v2_replace_planned_blocks(uuid, date, jsonb)";

  test("exists, takes the user, the date and the plan, and returns a count", () => {
    expect(ENGINE).toContain("create or replace function public.v2_replace_planned_blocks(");
    for (const argument of ["p_user uuid", "p_date date", "p_blocks jsonb"]) {
      expect(FUNCTION, `missing argument: ${argument}`).toContain(argument);
    }
    expect(FUNCTION).toContain("returns integer");
  });

  test("pins its search_path, with pg_temp last", () => {
    expect(FUNCTION).toContain("set search_path = public, pg_temp");
  });

  test("is server-only: revoked from every client role, granted to service_role", () => {
    for (const role of ["public", "anon", "authenticated"]) {
      expect(
        ENGINE.includes(`revoke all on function ${SIGNATURE} from ${role};`),
        `must revoke execute from ${role}`,
      ).toBe(true);
    }
    expect(ENGINE).toContain(`grant execute on function ${SIGNATURE} to service_role;`);
  });

  test("serialises replans of one day with a transaction-scoped advisory lock", () => {
    // Transaction scoped, so it is released however the statement ends, and it
    // is keyed on (user, date), so it blocks no other day and no other account.
    expect(FUNCTION).toContain("pg_advisory_xact_lock(hashtext(p_user::text), hashtext(p_date::text))");
    expect(/pg_advisory_lock\b/.test(FUNCTION), "a session lock would outlive the statement").toBe(
      false,
    );
  });

  test("deletes only planned rows of that account and that day", () => {
    const deletion = FUNCTION.slice(FUNCTION.indexOf("delete from public.v2_blocks"));
    const body = deletion.slice(0, deletion.indexOf("returning"));
    expect(body).toContain("b.user_id = p_user");
    expect(body).toContain("b.date = p_date");
    expect(body).toContain("b.state = 'planned'");
  });

  test("never writes state on a row that already exists, and only touches planned ones", () => {
    const update = FUNCTION.slice(FUNCTION.indexOf("on conflict (user_id, id) do update"));
    const assignments = update.slice(0, update.indexOf("where"));
    expect(/\bstate\s*=/.test(assignments), "a plan must never write state").toBe(false);
    expect(update).toContain("where public.v2_blocks.state = 'planned'");
  });

  test("lands every row on p_date, so a plan is a plan for one day", () => {
    const insert = FUNCTION.slice(FUNCTION.indexOf("insert into public.v2_blocks"));
    expect(insert).toContain("select p_user, k.id, p_date,");
  });
});

describe("0067: the ten minute tick", () => {
  test("schedules one pg_cron job every ten minutes", () => {
    expect(SCHEDULE).toContain("cron.schedule(");
    expect(SCHEDULE).toContain("'*/10 * * * *'");
    // Unschedule first, so re-running the file never stacks duplicates.
    expect(SCHEDULE).toContain("cron.unschedule(");
  });

  test("calls the route with net.http_post and a bearer from the vault", () => {
    expect(SCHEDULE).toContain("net.http_post");
    expect(SCHEDULE).toContain("vault.decrypted_secrets");
    expect(SCHEDULE).toContain("v2_tick_url");
    expect(SCHEDULE).toContain("v2_cron_secret");
    expect(SCHEDULE).toContain("timeout_milliseconds");
  });

  test("holds no url and no secret: not in a literal, not in the header", () => {
    for (const literal of stringLiterals(SCHEDULE)) {
      expect(/http/i.test(literal), `0067 has a url literal: ${literal}`).toBe(false);
    }
    expect(/https?:\/\//i.test(SCHEDULE), "0067 must hold no url").toBe(false);
    expect(/\bBearer\s+[A-Za-z0-9_-]{8,}/.test(SCHEDULE), "0067 must hold no secret").toBe(false);
  });

  test("names the prerequisites the owner has to switch on", () => {
    const header = SCHEDULE.slice(0, 2000).toLowerCase();
    for (const needed of ["pg_cron", "pg_net", "vault"]) {
      expect(header, `0067's header must name ${needed}`).toContain(needed);
    }
  });

  test("creates no extension, because enabling one needs rights a migration may not have", () => {
    expect(/create\s+extension/i.test(SCHEDULE), "0067 must not create an extension").toBe(false);
  });

  test("creates no table and no policy", () => {
    expect(createdTables(SCHEDULE)).toEqual([]);
    expect(/create\s+policy/i.test(SCHEDULE)).toBe(false);
  });
});
