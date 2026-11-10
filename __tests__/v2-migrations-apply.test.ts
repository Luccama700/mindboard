// @vitest-environment node
//
// Migration rehearsal. The newest ten migrations (0056 to 0065, a security
// release) were written without a database to run them on. These tests run all
// of them, unmodified, in an in-memory Postgres (PGlite) with Supabase's
// platform stubbed, so a mistake shows up here and not on the production
// database. The harness itself lives in test/migrations/ (see its README).
//
// The upper bound is always named explicitly (0065): migration files above it
// are somebody else's work in progress and never affect these tests.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyMigrations,
  CATALOG_CONSTRAINTS_SQL,
  CATALOG_CONSTRAINTS_SQL_AS_DISPATCHED,
  CATALOG_POLICIES_SQL,
  catalog,
  createDatabase,
  listMigrations,
  loadSeed,
  rowCounts,
  runRehearsal,
} from "../test/migrations/harness.mjs";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

type Db = Awaited<ReturnType<typeof createDatabase>>;

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HARNESS = path.resolve(__dirname, "../test/migrations/harness.mjs");

const LAST = "0065";
const upToLast = (name: string) => name.slice(0, 4) <= LAST;

async function rows<T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(sql, params)).rows as T[];
}

// Run `fn` the way PostgREST would for a signed-in user: the authenticated
// role, with the user's id in the JWT claim that auth.uid() reads.
async function asUser<T>(db: Db, userId: string, fn: () => Promise<T>): Promise<T> {
  await db.exec("set role authenticated");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  }
}

// ---------------------------------------------------------------------------
// What the security release must leave behind (brief item 4). Used on the
// full chain and again on the sequence production will actually run.
// ---------------------------------------------------------------------------
const SERVER_ONLY_TABLES = ["jobs", "ai_audit_log", "urc_devices", "urc_jobs", "oauth_grants", "oauth_used_codes"];

async function anonPrivilegedRelations(db: Db): Promise<string[]> {
  const r = await rows<{ relname: string }>(
    db,
    `select c.relname
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')
        and (has_table_privilege('anon', c.oid, 'select,insert,update,delete,truncate,references,trigger')
             or (c.relkind <> 'S' and has_any_column_privilege('anon', c.oid, 'select,insert,update,references')))
      order by 1`,
  );
  return r.map((x) => x.relname);
}

async function expectReleaseState(db: Db) {
  // row level security on for every table in public
  const tables = await rows<{ relname: string; relrowsecurity: boolean }>(
    db,
    `select c.relname, c.relrowsecurity
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
      order by 1`,
  );
  expect(tables.length).toBeGreaterThan(40);
  expect(tables.filter((t) => !t.relrowsecurity).map((t) => t.relname)).toEqual([]);

  // no policy a client can write through on the server-only tables
  const present = await rows<{ tablename: string }>(
    db,
    "select tablename from pg_tables where schemaname = 'public' and tablename = any($1) order by 1",
    [SERVER_ONLY_TABLES],
  );
  expect(present.map((p) => p.tablename)).toEqual([...SERVER_ONLY_TABLES].sort());
  const writers = await rows(
    db,
    "select tablename, policyname, cmd from pg_policies where schemaname = 'public' and tablename = any($1) and cmd <> 'SELECT'",
    [SERVER_ONLY_TABLES],
  );
  expect(writers).toEqual([]);
  // not vacuous: the two tables whose reads stay open still have their select policy
  const readers = await rows<{ tablename: string }>(
    db,
    "select distinct tablename from pg_policies where schemaname = 'public' and tablename in ('jobs','ai_audit_log') and cmd = 'SELECT'",
  );
  expect(readers.map((r) => r.tablename).sort()).toEqual(["ai_audit_log", "jobs"]);

  // anon holds nothing in public, now or for tables created later
  expect(await anonPrivilegedRelations(db)).toEqual([]);
  await db.exec("create table public.created_after_release (id int)");
  const [row] = await rows<{ anon: boolean; authed: boolean }>(
    db,
    `select has_table_privilege('anon', 'public.created_after_release', 'select') as anon,
            has_table_privilege('authenticated', 'public.created_after_release', 'select') as authed`,
  );
  expect(row).toEqual({ anon: false, authed: true });
  await db.exec("drop table public.created_after_release");
}

// Tables 0059 creates: new, and empty.
const NEW_EMPTY_TABLES = { "public.oauth_grants": 0, "public.oauth_used_codes": 0 };

const tmpDirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mb-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. The stubs
// ---------------------------------------------------------------------------
describe("platform stubs", () => {
  let db: Db;
  beforeAll(async () => {
    db = await createDatabase();
  });

  it("has the three API roles, and only service_role bypasses row level security", async () => {
    const r = await rows<{ rolname: string; rolbypassrls: boolean; rolcanlogin: boolean }>(
      db,
      "select rolname, rolbypassrls, rolcanlogin from pg_roles where rolname in ('anon','authenticated','service_role') order by rolname",
    );
    expect(r.map((x) => x.rolname)).toEqual(["anon", "authenticated", "service_role"]);
    expect(Object.fromEntries(r.map((x) => [x.rolname, x.rolbypassrls]))).toEqual({
      anon: false,
      authenticated: false,
      service_role: true,
    });
  });

  it("has auth.users and an auth.uid() that reads the request's sub claim", async () => {
    expect((await rows(db, "select count(*)::int as n from auth.users"))[0]).toEqual({ n: 0 });
    expect((await rows(db, "select auth.uid() as u"))[0]).toEqual({ u: null });
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [A]);
    expect((await rows(db, "select auth.uid() as u"))[0]).toEqual({ u: A });
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  });

  it("has storage.buckets, storage.objects and storage.foldername()", async () => {
    await rows(db, "select id, name, public, file_size_limit, allowed_mime_types from storage.buckets");
    await rows(db, "select bucket_id, name, owner from storage.objects");
    expect((await rows(db, "select storage.foldername('u1/s1/file.pdf') as f"))[0]).toEqual({ f: ["u1", "s1"] });
    expect((await rows(db, "select storage.foldername('file.pdf') as f"))[0]).toEqual({ f: [] });
  });

  it("records what cron, net and vault were asked to do, and scheduling a name twice replaces it", async () => {
    await db.exec("select cron.schedule('nightly', '1 2 * * *', 'select 1')");
    await db.exec("select cron.schedule('nightly', '5 6 * * *', 'select 2')");
    expect(await rows(db, "select jobname, schedule, command from cron.job")).toEqual([
      { jobname: "nightly", schedule: "5 6 * * *", command: "select 2" },
    ]);
    await db.exec("select cron.unschedule('nightly')");
    expect(await rows(db, "select count(*)::int as n from cron.job")).toEqual([{ n: 0 }]);

    await db.exec("select net.http_post('https://example.test/hook', '{\"a\":1}'::jsonb)");
    expect(await rows(db, "select method, url, body from net.requests")).toEqual([
      { method: "POST", url: "https://example.test/hook", body: { a: 1 } },
    ]);

    await db.exec("select vault.create_secret('s3cret-value', 'my_secret')");
    expect(await rows(db, "select name, decrypted_secret from vault.decrypted_secrets")).toEqual([
      { name: "my_secret", decrypted_secret: "s3cret-value" },
    ]);
  });

  it("gives new public tables Supabase's default grants, so a later revoke has something to remove", async () => {
    await db.exec("create table public.probe_defaults (id int)");
    for (const role of ["anon", "authenticated", "service_role"]) {
      const r = await rows<{ ok: boolean }>(db, "select has_table_privilege($1, 'public.probe_defaults', 'select') as ok", [role]);
      expect(r[0].ok, role).toBe(true);
    }
    await db.exec("drop table public.probe_defaults");
  });
});

// ---------------------------------------------------------------------------
// The harness's own contract: listing, ranges, skips, failure reporting
// ---------------------------------------------------------------------------
describe("listMigrations and applyMigrations options", () => {
  it("lists the real migrations in order and ignores anything that is not a numbered .sql file", () => {
    const names = listMigrations();
    expect(names[0]).toBe("0001_init.sql");
    expect(names.every((n) => /^\d{4}_.+\.sql$/.test(n))).toBe(true);
    expect(names).toEqual([...names].sort());
    expect(names.filter(upToLast).at(-1)).toBe("0065_rls_hardening.sql");

    const dir = tmpDir("list");
    fs.writeFileSync(path.join(dir, "0002_b.sql"), "select 1;");
    fs.writeFileSync(path.join(dir, "0001_a.sql"), "select 1;");
    fs.writeFileSync(path.join(dir, "README.md"), "not a migration");
    fs.writeFileSync(path.join(dir, "notes.sql"), "select 1;");
    expect(listMigrations(dir)).toEqual(["0001_a.sql", "0002_b.sql"]);
  });

  it("applies from/upTo inclusively, honours skip, and refuses a skip that matches nothing", async () => {
    const dir = tmpDir("range");
    for (const n of [1, 2, 3, 4]) {
      fs.writeFileSync(path.join(dir, `000${n}_t${n}.sql`), `create table public.t${n} (id int);`);
    }
    const db = await createDatabase();
    const tables = async () =>
      (await rows<{ relname: string }>(db, "select relname from pg_class where relname ~ '^t[0-9]$' and relkind = 'r' order by 1")).map((r) => r.relname);

    expect(await applyMigrations(db, { dir, upTo: "0002" })).toEqual(["0001_t1.sql", "0002_t2.sql"]);
    expect(await tables()).toEqual(["t1", "t2"]);

    await expect(applyMigrations(db, { dir, from: "0003", skip: ["0009"] })).rejects.toThrow(/skip/i);
    expect(await tables()).toEqual(["t1", "t2"]);

    expect(await applyMigrations(db, { dir, from: "0003", skip: ["0004"] })).toEqual(["0003_t3.sql"]);
    expect(await tables()).toEqual(["t1", "t2", "t3"]);
  });
});

// ---------------------------------------------------------------------------
// 5. A failing migration is named
// ---------------------------------------------------------------------------
describe("a failing migration", () => {
  it("is reported by file name with Postgres's message, undone as a whole, and stops the run", async () => {
    const dir = tmpDir("broken");
    fs.writeFileSync(path.join(dir, "0001_ok.sql"), "create table public.kept (id int);");
    fs.writeFileSync(
      path.join(dir, "0002_broken.sql"),
      "create table public.half_done (id int);\nselect * from public.no_such_table;\n",
    );
    fs.writeFileSync(path.join(dir, "0003_never.sql"), "create table public.never (id int);");

    const db = await createDatabase();
    const failure = await applyMigrations(db, { dir }).then(
      () => null,
      (e: Error) => e,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toContain("0002_broken.sql");
    expect(failure!.message).toContain("no_such_table");

    const exists = async (t: string) =>
      (await rows<{ n: number }>(db, "select count(*)::int as n from pg_class where relname = $1", [t]))[0].n === 1;
    expect(await exists("kept")).toBe(true);
    expect(await exists("half_done")).toBe(false); // the whole file was rolled back
    expect(await exists("never")).toBe(false); // nothing ran after it

    // The connection is still usable: the aborted transaction was cleared.
    expect(await rows(db, "select 1 as ok")).toEqual([{ ok: 1 }]);
  });

  it("copes with a migration that opens and closes its own transaction (0064 does)", async () => {
    const dir = tmpDir("selftx");
    fs.writeFileSync(path.join(dir, "0001_tx.sql"), "begin;\ncreate table public.tx_ok (id int);\ncommit;\n");
    fs.writeFileSync(path.join(dir, "0002_tx_bad.sql"), "begin;\ncreate table public.tx_bad (id int);\nselect 1/0;\ncommit;\n");
    const db = await createDatabase();
    await expect(applyMigrations(db, { dir })).rejects.toThrow(/0002_tx_bad\.sql[\s\S]*division by zero/);
    const n = await rows<{ n: number }>(db, "select count(*)::int as n from pg_class where relname in ('tx_ok','tx_bad')");
    expect(n[0].n).toBe(1);
    expect(await rows(db, "select 1 as ok")).toEqual([{ ok: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// 2 and 4. The whole chain on an empty database, and what it leaves behind
// ---------------------------------------------------------------------------
describe("every migration on an empty database", () => {
  let db: Db;
  let applied: string[] & { neutralised?: { file: string; statement: string; reason: string }[] };
  beforeAll(async () => {
    db = await createDatabase();
    applied = await applyMigrations(db, { upTo: LAST });
  });

  it("applies 0001 to 0065 in order", () => {
    const expected = listMigrations().filter(upToLast);
    expect(expected.length).toBeGreaterThan(60);
    expect(applied).toEqual(expected);
    expect(applied[0]).toBe("0001_init.sql");
    expect(applied.at(-1)).toBe("0065_rls_hardening.sql");
  });

  it("neutralises exactly one statement, pg_cron's create extension, and says so", () => {
    expect(applied.neutralised).toEqual([
      {
        file: "0061_retention_prune.sql",
        statement: "create extension if not exists pg_cron with schema pg_catalog;",
        reason: expect.stringContaining("pg_cron"),
      },
    ]);
  });

  it("still reaches the rest of 0061: the nightly prune is scheduled", async () => {
    const jobs = await rows<{ jobname: string; schedule: string; command: string }>(
      db,
      "select jobname, schedule, command from cron.job",
    );
    expect(jobs).toEqual([
      { jobname: "mindboard-retention-prune", schedule: "27 3 * * *", command: "select public.prune_retained_rows();" },
    ]);
  });

  it("leaves the release state behind: RLS everywhere, no client write policy on the server-only tables, nothing for anon", async () => {
    await expectReleaseState(db);
  });

  it("keeps token columns out of reach of a signed-in client (0058) and tightens the buckets (0062)", async () => {
    const [grants] = await rows<{ token: boolean; own_id: boolean; vault_token: boolean; vault_repo: boolean }>(
      db,
      `select has_column_privilege('authenticated', 'public.google_tokens', 'access_token', 'select') as token,
              has_column_privilege('authenticated', 'public.google_tokens', 'user_id', 'select') as own_id,
              has_column_privilege('authenticated', 'public.vault_settings', 'github_token', 'select') as vault_token,
              has_column_privilege('authenticated', 'public.vault_settings', 'repo', 'select') as vault_repo`,
    );
    expect(grants).toEqual({ token: false, own_id: true, vault_token: false, vault_repo: true });

    const buckets = await rows<{ id: string; allowed_mime_types: string[] | null }>(
      db,
      "select id, allowed_mime_types from storage.buckets where id in ('course-files','inventory-icons') order by 1",
    );
    expect(buckets.find((b) => b.id === "course-files")!.allowed_mime_types).toEqual(["application/pdf"]);
    expect(buckets.find((b) => b.id === "inventory-icons")!.allowed_mime_types).toContain("image/png");
    const publicRead = await rows(db, "select 1 from pg_policies where policyname = 'inventory_icons_read_public'");
    expect(publicRead).toEqual([]);
  });
});

describe("anon's privileges, before and after 0065", () => {
  it("holds privileges on public tables up to 0064 (the stub is realistic) and none after 0065", async () => {
    const db = await createDatabase();
    await applyMigrations(db, { upTo: "0064" });

    // Supabase's default privileges: tables arwdDxtm, sequences rwU, functions execute, to all three API roles.
    const acl = await rows<{ objtype: string; roles: string[] }>(
      db,
      `select d.defaclobjtype as objtype,
              array(select r.rolname from aclexplode(d.defaclacl) a join pg_roles r on r.oid = a.grantee order by 1) as roles
         from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
        where n.nspname = 'public' order by 1`,
    );
    expect(acl.map((a) => a.objtype)).toEqual(["S", "f", "r"]);
    for (const a of acl) expect([...new Set(a.roles)]).toEqual(["anon", "authenticated", "service_role"]);
    const [tablePriv] = await rows<{ privs: string[] }>(
      db,
      `select array(select a.privilege_type from pg_default_acl d, aclexplode(d.defaclacl) a join pg_roles r on r.oid = a.grantee
                     where d.defaclobjtype = 'r' and r.rolname = 'anon' order by 1) as privs`,
    );
    expect(tablePriv.privs).toEqual(["DELETE", "INSERT", "MAINTAIN", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"]);

    const total = (await rows<{ n: number }>(db, "select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p')"))[0].n;
    const privileged = (await anonPrivilegedRelations(db)).length;
    expect(total).toBeGreaterThan(40);
    expect(privileged).toBe(total); // every table in public is reachable by anon today

    await applyMigrations(db, { from: "0065", upTo: "0065" });
    expect(await anonPrivilegedRelations(db)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. The security release over rows that already exist
// ---------------------------------------------------------------------------
describe("0056 to 0065 over existing data", () => {
  let base: Db; // 0001..0055 applied, two tenants loaded
  let db: Db; // the same, with 0056..0065 applied on top
  let before: Record<string, number>;
  let after: Record<string, number>;
  let applied: string[];

  beforeAll(async () => {
    base = await createDatabase();
    await applyMigrations(base, { upTo: "0055" });
    await loadSeed(base);
    db = (await base.clone()) as Db;
    before = await rowCounts(db);
    applied = await applyMigrations(db, { from: "0056", upTo: LAST });
    after = await rowCounts(db);
  });

  it("starts from a populated database, so the run below proves something", () => {
    expect(before["auth.users"]).toBe(2);
    expect(before["public.tasks"]).toBe(4);
    expect(before["public.urc_jobs"]).toBe(3);
    expect(before["public.course_sources"]).toBe(2);
    expect(before["public.ai_audit_log"]).toBe(3);
  });

  it("applies exactly 0056 to 0065, in order", () => {
    expect(applied).toEqual(listMigrations().filter((n) => n >= "0056" && upToLast(n)));
    expect(applied).toHaveLength(10);
  });

  it("loses and gains no rows (the only change is the two empty tables 0059 creates)", () => {
    expect(after).toEqual({ ...before, ...NEW_EMPTY_TABLES });
  });

  it("clears the session link on a finished remote-control job before the new check needs it to be gone (0063)", async () => {
    const r = await rows<{ id: string; status: string; session_url: string | null }>(
      db,
      "select id, status, session_url from public.urc_jobs where user_id = $1 order by status",
      [A],
    );
    expect(r.map((x) => [x.status, x.session_url !== null])).toEqual([
      ["running", true],
      ["stopped", false],
    ]);
  });

  it("refuses a cross-tenant reference that the old single-column foreign keys let through (0064)", async () => {
    const groupOfB = "bbbbbbbb-0000-4000-8000-000000000101";
    await expect(
      db.query("insert into public.tasks (user_id, group_id, title) values ($1, $2, 'sneaky')", [A, groupOfB]),
    ).rejects.toThrow(/tasks_group_id_fkey/);
    await db.query(
      "insert into public.tasks (user_id, group_id, title) values ($1, 'aaaaaaaa-0000-4000-8000-000000000101', 'fine')",
      [A],
    );
  });

  it("refuses a course file path outside the owner's folder (0057)", async () => {
    await expect(
      db.query(
        "insert into public.course_sources (user_id, course_id, title, storage_path) values ($1, 'aaaaaaaa-0000-4000-8000-000000000701', 'x', $2)",
        [A, `${B}/elsewhere/file.pdf`],
      ),
    ).rejects.toThrow(/course_sources_storage_path_own_folder/);
  });

  it("refuses a finished remote-control job that keeps its link (0063)", async () => {
    await expect(
      db.query("update public.urc_jobs set session_url = 'https://example.test/x' where id = 'bbbbbbbb-0000-4000-8000-000000000811'"),
    ).rejects.toThrow(/urc_jobs_session_url_only_while_live/);
  });

  it("stops a signed-in client from enqueuing jobs or writing the audit log, but not from reading its own (0056, 0060)", async () => {
    await asUser(db, A, async () => {
      const mine = await rows<{ n: number }>(db, "select count(*)::int as n from public.jobs");
      expect(mine[0].n).toBe(2); // its own two, not tenant B's
      const audit = await rows<{ n: number }>(db, "select count(*)::int as n from public.ai_audit_log");
      expect(audit[0].n).toBe(2);
    });
    await asUser(db, A, async () => {
      await expect(db.query("insert into public.jobs (user_id, kind) values ($1, 'ocr')", [A])).rejects.toThrow(/row-level security/);
    });
    await asUser(db, A, async () => {
      await expect(
        db.query("insert into public.ai_audit_log (user_id, tool_name, input, summary) values ($1, 't', '{}', 's')", [A]),
      ).rejects.toThrow(/row-level security/);
    });
    // The same session can still write where it should, so the checks above are about policy, not a broken stub.
    await asUser(db, A, async () => {
      await db.query("insert into public.groups (user_id, name, type, color) values ($1, 'Mine', 'work', '#fff')", [A]);
    });
  });

  it("hides token columns from a signed-in client (0058)", async () => {
    await asUser(db, A, async () => {
      await expect(db.query("select access_token from public.google_tokens")).rejects.toThrow(/permission denied/);
    });
    await asUser(db, A, async () => {
      expect((await rows(db, "select user_id, scopes from public.google_tokens"))).toEqual([{ user_id: A, scopes: "calendar.readonly" }]);
    });
  });

  it("also succeeds in the sequence production will run, with 0061 skipped, and leaves the same release state", async () => {
    const prod = (await base.clone()) as Db;
    const run = await applyMigrations(prod, { from: "0056", upTo: LAST, skip: ["0061"] });
    expect(run).toEqual(listMigrations().filter((n) => n >= "0056" && upToLast(n) && !n.startsWith("0061")));
    expect(run.neutralised).toEqual([]); // 0061 never ran, so nothing was rewritten
    expect(await rowCounts(prod)).toEqual({ ...before, ...NEW_EMPTY_TABLES });
    expect((await rows(prod, "select count(*)::int as n from cron.job"))[0]).toEqual({ n: 0 });
    expect((await rows(prod, "select count(*)::int as n from pg_proc where proname = 'prune_retained_rows'"))[0]).toEqual({ n: 0 });
    await expectReleaseState(prod);
  });

  it("is where an existing row that breaks a new constraint shows up, by file name (the point of this harness)", async () => {
    // Tenant A's task filed under tenant B's group: legal under 0001's foreign key, illegal under 0064's.
    const poisoned = (await base.clone()) as Db;
    await poisoned.query(
      "insert into public.tasks (user_id, group_id, title) values ($1, 'bbbbbbbb-0000-4000-8000-000000000101', 'misfiled')",
      [A],
    );
    const failure = await applyMigrations(poisoned, { from: "0056", upTo: LAST }).then(
      () => null,
      (e: Error) => e,
    );
    expect(failure).not.toBeNull();
    expect(failure!.message).toContain("0064_same_tenant_fks.sql");
    expect(failure!.message).toMatch(/tasks_group_id_fkey/);

    // 0064 is atomic, and the migrations before it stay applied.
    const keyed = await rows<{ n: number }>(poisoned, "select count(*)::int as n from pg_constraint where conname = 'tasks_user_id_id_key'");
    expect(keyed[0].n).toBe(0);
    const policies = await rows<{ n: number }>(poisoned, "select count(*)::int as n from pg_policies where policyname = 'jobs_insert_own'");
    expect(policies[0].n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Neutralising is exact: one named statement in one named file, and nothing else
// ---------------------------------------------------------------------------
describe("neutralised statements", () => {
  it("does not touch the same statement in any other file", async () => {
    const dir = tmpDir("other-ext");
    fs.writeFileSync(path.join(dir, "0001_ext.sql"), "create extension if not exists pg_cron with schema pg_catalog;\n");
    const db = await createDatabase();
    await expect(applyMigrations(db, { dir })).rejects.toThrow(/0001_ext\.sql/);
  });

  it("refuses to carry on if the named file stops containing the statement", async () => {
    const dir = tmpDir("stale-rule");
    fs.writeFileSync(path.join(dir, "0061_retention_prune.sql"), "select 1;\n");
    const db = await createDatabase();
    await expect(applyMigrations(db, { dir })).rejects.toThrow(/0061_retention_prune\.sql[\s\S]*no longer/);
  });
});

// ---------------------------------------------------------------------------
// 6. The command line, on a tiny invented export
// ---------------------------------------------------------------------------
const GROUP_1 = "11111111-0000-4000-8000-000000000001";
const GROUP_OF_OTHER = "22222222-0000-4000-8000-000000000002";
const USER_1 = "11111111-1111-4111-8111-111111111111";
const USER_2 = "22222222-2222-4222-8222-222222222222";
const SECRET_TITLE = "SENTINEL-task-title-4f9a";
const SECRET_EMAIL = "sentinel-4f9a@example.test";
const SECRET_NAME = "SENTINEL-group-name-4f9a";

function writeExport(dir: string, opts: { misfiled?: boolean } = {}) {
  const w = (name: string, value: unknown) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  // tasks is listed before groups on purpose: load order must not matter.
  w("manifest.json", {
    tables: [
      { table: "tasks", rows: 2, excludedColumns: [], primaryKey: ["id"] },
      { table: "groups", rows: 2, excludedColumns: [], primaryKey: ["id"] },
      { table: "google_tokens", rows: 1, excludedColumns: ["access_token", "refresh_token"], primaryKey: ["id"] },
    ],
  });
  w("auth-users.json", [
    { id: USER_1, email: SECRET_EMAIL, created_at: "2026-01-05T10:00:00Z", last_sign_in_at: "2026-10-01T10:00:00Z", providers: ["google"] },
    { id: USER_2, email: "other@example.test", created_at: "2026-02-05T10:00:00Z", last_sign_in_at: null, providers: ["google"] },
  ]);
  w("groups.json", [
    { id: GROUP_1, user_id: USER_1, name: SECRET_NAME, type: "course", color: "#b5ff3c", archived: false, created_at: "2026-03-01T10:00:00Z" },
    { id: GROUP_OF_OTHER, user_id: USER_2, name: "Other", type: "personal", color: "#ff6b6b", archived: false, created_at: "2026-03-01T10:00:00Z" },
  ]);
  w("tasks.json", [
    { id: "11111111-0000-4000-8000-0000000000a1", user_id: USER_1, group_id: GROUP_1, title: SECRET_TITLE, status: "todo", priority: "med" },
    {
      id: "11111111-0000-4000-8000-0000000000a2",
      user_id: USER_1,
      group_id: opts.misfiled ? GROUP_OF_OTHER : null,
      title: "No group",
      status: "todo",
      priority: "low",
    },
  ]);
  w("google_tokens.json", [
    { id: "11111111-0000-4000-8000-0000000000b1", user_id: USER_1, expires_at: "2026-12-01T00:00:00Z", scopes: "calendar.readonly", updated_at: "2026-10-01T00:00:00Z" },
  ]);
}

describe("rehearsal command line", () => {
  it("loads the export after the applied migrations, fills left-out secrets, applies the rest, and prints counts but no rows", async () => {
    const dir = tmpDir("export-ok");
    writeExport(dir);
    const lines: string[] = [];
    const result = await runRehearsal({ data: dir, fromApplied: "0055", skip: ["0061"], upTo: LAST, log: (l: string) => lines.push(l) });
    const out = lines.join("\n");

    // one line per migration
    for (const name of listMigrations().filter(upToLast)) {
      expect(out, name).toContain(name);
    }
    expect(lines.filter((l) => l.includes("0061_retention_prune.sql") && /skipped/i.test(l))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("0064_same_tenant_fks.sql") && /applied/i.test(l))).toHaveLength(1);

    // row counts of every table, before and after
    expect(out).toMatch(/public\.tasks\s+2\s+2/);
    expect(out).toMatch(/public\.groups\s+2\s+2/);
    expect(out).toMatch(/public\.jobs\s+0\s+0/);
    expect(out).toMatch(/auth\.users\s+2\s+2/);

    // never a row
    for (const secret of [SECRET_TITLE, SECRET_EMAIL, SECRET_NAME, GROUP_1, USER_1]) {
      expect(out).not.toContain(secret);
    }

    // state: placeholder for the secrets the export left out, constraints back on, skip honoured
    const db = result.db as Db;
    const [tok] = await rows<{ access_token: string; refresh_token: string }>(db, "select access_token, refresh_token from public.google_tokens");
    expect(tok).toEqual({ access_token: "redacted", refresh_token: "redacted" });
    expect((await rows(db, "show session_replication_role"))[0]).toEqual({ session_replication_role: "origin" });
    expect((await rows(db, "select count(*)::int as n from pg_constraint where conname = 'tasks_user_id_id_key'"))[0]).toEqual({ n: 1 });
    expect((await rows(db, "select count(*)::int as n from cron.job"))[0]).toEqual({ n: 0 });
    await expect(
      db.query("insert into public.tasks (user_id, group_id, title) values ($1, $2, 'x')", [USER_1, GROUP_OF_OTHER]),
    ).rejects.toThrow(/tasks_group_id_fkey/);
    await db.close();
  });

  it("when a migration cannot take the data: exits 1, names the file, and still prints no row", () => {
    const dir = tmpDir("export-bad");
    writeExport(dir, { misfiled: true });
    const run = spawnSync(process.execPath, [HARNESS, "--data", dir, "--from-applied", "0055"], { encoding: "utf8" });
    const out = `${run.stdout}\n${run.stderr}`;
    expect(run.status).toBe(1);
    expect(out).toContain("0064_same_tenant_fks.sql");
    expect(out).toMatch(/tasks_group_id_fkey/);
    expect(out).toMatch(/public\.tasks\s+2/); // the before counts still print
    for (const secret of [SECRET_TITLE, SECRET_EMAIL, SECRET_NAME, GROUP_1, GROUP_OF_OTHER, USER_1, USER_2]) {
      expect(out).not.toContain(secret);
    }
  });

  it("refuses to run without --data", () => {
    const run = spawnSync(process.execPath, [HARNESS], { encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/--data/);
  });

  it("refuses an export whose file holds fewer rows than its manifest says", async () => {
    const dir = tmpDir("export-short");
    writeExport(dir);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    manifest.tables[0].rows = 3; // tasks.json has 2
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    await expect(runRehearsal({ data: dir, fromApplied: "0055", upTo: LAST, log: () => {} })).rejects.toThrow(/tasks[\s\S]*3[\s\S]*2/);
  });
});

// ---------------------------------------------------------------------------
// Catalog fingerprints, for comparing the files with production
// ---------------------------------------------------------------------------
describe("catalog mode", () => {
  it("runs the agreed queries, with one cast on the constraints query because the dispatched text does not run", async () => {
    // Policies: verbatim.
    expect(CATALOG_POLICIES_SQL).toBe(
      "select tablename as t, md5(string_agg(policyname || ':' || cmd, ',' order by policyname)) as h, count(*)::int as n from pg_policies where schemaname = 'public' group by 1 order by 1",
    );
    // Constraints: identical except `c.contype` became `c.contype::text`.
    expect(CATALOG_CONSTRAINTS_SQL).toBe(CATALOG_CONSTRAINTS_SQL_AS_DISPATCHED.replace("|| c.contype,", "|| c.contype::text,"));
    expect(CATALOG_CONSTRAINTS_SQL).not.toBe(CATALOG_CONSTRAINTS_SQL_AS_DISPATCHED);

    const db = await createDatabase();
    await expect(db.query(CATALOG_CONSTRAINTS_SQL_AS_DISPATCHED)).rejects.toThrow(/operator is not unique: text \|\| "char"/);
    await db.query(CATALOG_CONSTRAINTS_SQL);
    await db.close();
  });

  it("prints two JSON arrays and nothing else, the same as the in-process fingerprints", async () => {
    const db = await createDatabase();
    await applyMigrations(db, { upTo: LAST });
    const expected = await catalog(db);
    const tasks = expected.constraints.find((c) => c.t === "tasks")!;
    expect(tasks.h).toMatch(/^[0-9a-f]{32}$/);
    expect(tasks.n).toBeGreaterThanOrEqual(3);
    expect(expected.policies.find((p) => p.t === "jobs")!.n).toBe(1); // select-own only, after 0056
    await db.close();

    const run = spawnSync(process.execPath, [HARNESS, "--catalog", "--upto", LAST], { encoding: "utf8" });
    expect(run.status).toBe(0);
    const lines = run.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(expected.constraints);
    expect(JSON.parse(lines[1])).toEqual(expected.policies);
  });

  it("with --names prints one table's constraint names with their types and policy names with their commands", () => {
    const run = spawnSync(process.execPath, [HARNESS, "--catalog", "--upto", LAST, "--names", "tasks"], { encoding: "utf8" });
    expect(run.status).toBe(0);
    const lines = run.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    const constraints = JSON.parse(lines[0]) as { name: string; type: string }[];
    const policies = JSON.parse(lines[1]) as { name: string; cmd: string }[];
    expect(constraints).toEqual(expect.arrayContaining([
      { name: "tasks_pkey", type: "p" },
      { name: "tasks_group_id_fkey", type: "f" },
      { name: "tasks_user_id_id_key", type: "u" },
    ]));
    expect(constraints.map((c) => c.name)).toEqual([...constraints.map((c) => c.name)].sort());
    expect(policies.length).toBeGreaterThan(0);
    expect(policies.every((p) => typeof p.name === "string" && ["SELECT", "INSERT", "UPDATE", "DELETE", "ALL"].includes(p.cmd))).toBe(true);
  });
});
