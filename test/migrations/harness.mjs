// Migration rehearsal harness.
//
// Runs supabase/migrations/*.sql, unmodified, in an in-memory Postgres (PGlite)
// that has been given what Supabase gives a migration (supabase-stubs.sql). Two
// uses: the unit tests in __tests__/v2-migrations-apply.test.ts, and a command
// line that rehearses the not-yet-applied migrations on a local copy of an
// export of real data. See README.md in this folder.
//
// Plain JavaScript run by Node directly; types are JSDoc.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const MIGRATIONS_DIR = path.resolve(HERE, "../../supabase/migrations");
export const STUBS_FILE = path.join(HERE, "supabase-stubs.sql");
export const SEED_FILE = path.join(HERE, "seed-two-tenants.sql");

/**
 * The only rewriting of migration text this harness does. A rule names ONE file
 * and ONE statement, which must be a whole line of that file; a line that
 * matches is replaced by `select 1`. Nothing else is touched, and if a rule's
 * file no longer contains its line the run stops, so a rule cannot go stale
 * silently. Every statement actually neutralised is returned by
 * applyMigrations (as `.neutralised`), passed to `onMigration`, and printed by
 * the command line.
 *
 * @typedef {{ file: string, statement: string, reason: string }} NeutraliseRule
 * @type {readonly NeutraliseRule[]}
 */
export const NEUTRALISED = Object.freeze([
  {
    file: "0061_retention_prune.sql",
    statement: "create extension if not exists pg_cron with schema pg_catalog;",
    reason:
      "pg_cron is a compiled Postgres extension and cannot be installed in PGlite; the cron schema it would create is provided by supabase-stubs.sql, which records cron.schedule calls",
  },
]);

const REPLACEMENT = "select 1";

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/** A fresh in-memory Postgres with the Supabase platform stubs loaded. */
export async function createDatabase() {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(fs.readFileSync(STUBS_FILE, "utf8"));
  return db;
}

/** Load the invented two-tenant data set (written against the schema after 0055). */
export async function loadSeed(db, file = SEED_FILE) {
  await db.exec(fs.readFileSync(file, "utf8"));
}

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;
const IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * Row count of every table in public, plus auth.users. Keys look like
 * "public.tasks". Counts only: this is what the command line prints.
 * @returns {Promise<Record<string, number>>}
 */
export async function rowCounts(db) {
  const { rows: tables } = await db.query(
    `select n.nspname as s, c.relname as t
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p')
        and (n.nspname = 'public' or (n.nspname = 'auth' and c.relname = 'users'))
      order by 1, 2`,
  );
  /** @type {Record<string, number>} */
  const out = {};
  for (const { s, t } of /** @type {{ s: string, t: string }[]} */ (tables)) {
    const { rows } = await db.query(`select count(*)::int as n from ${quote(s)}.${quote(t)}`);
    out[`${s}.${t}`] = /** @type {{ n: number }[]} */ (rows)[0].n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/** Numbered .sql file names in a folder, in order. Anything else is ignored. */
export function listMigrations(dir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
}

/** "0056" or "0056_jobs_server_enqueue.sql" -> 56 */
function migrationNumber(spec) {
  const m = /^(\d+)/.exec(String(spec));
  if (!m) throw new Error(`"${spec}" is not a migration number or file name`);
  return parseInt(m[1], 10);
}

const padded = (n) => String(n).padStart(4, "0");

// Classes of SQLSTATE whose messages are built from object names, SQL text or
// fixed wording and never from a row value, so the message is printed as it is.
// (Class 42 is syntax and undefined objects, 55 is object state, and so on.)
// Everything else is an allowlist miss and is reduced to codes and names.
const NAME_ONLY_CLASSES = new Set(["0A", "25", "2B", "3D", "3F", "40", "42", "53", "54", "55", "57", "58"]);

// Fixed texts for the SQLSTATEs that carry a value in their real message.
const FIXED_TEXT = {
  "22001": "string data right truncation",
  "22003": "numeric value out of range",
  "22007": "invalid datetime format",
  "22008": "datetime field overflow",
  "22012": "division by zero",
  "22P02": "invalid text representation",
  "22P03": "invalid binary representation",
  "22P05": "untranslatable character",
  "22021": "invalid byte sequence for the encoding",
  "22023": "invalid parameter value",
  "22025": "invalid escape sequence",
  "22030": "duplicate JSON object key value",
  "2200L": "not a well-formed XML document",
  "23000": "integrity constraint violation",
  "23001": "restrict violation",
  "23502": "not-null violation",
  "23503": "foreign key violation",
  "23505": "unique violation",
  "23514": "check violation",
  "23P01": "exclusion violation",
};
const CLASS_TEXT = { "22": "data exception", "23": "integrity constraint violation", P0: "error raised by a function" };

/**
 * What may be printed about a Postgres error. A message can quote a value from
 * the data (invalid input syntax for type uuid: "...", value "..." is out of
 * range for type integer, a row in a constraint's DETAIL), so this is an
 * allowlist: the SQLSTATE, a fixed description of it, and the table, column and
 * constraint names the error object carries as separate fields. The message
 * itself is used only for the name-only classes above. DETAIL, HINT and WHERE
 * are never used.
 *
 * @param {any} e
 * @param {{ table?: string }} [context] where the error happened, when the caller knows
 */
export function describeError(e, context = {}) {
  const code = typeof e?.code === "string" ? e.code : undefined;
  const firstLine = (text) => String(text).split(/\r?\n/)[0];
  if (!code) return firstLine(e?.message ?? e);
  if (NAME_ONLY_CLASSES.has(code.slice(0, 2))) return firstLine(e.message ?? "");

  const text = FIXED_TEXT[code] ?? CLASS_TEXT[code.slice(0, 2)] ?? "database error";
  const where = [
    ["table", e.table ?? context.table],
    ["column", e.column],
    ["constraint", e.constraint],
  ]
    .filter(([, name]) => typeof name === "string" && name)
    .map(([kind, name]) => `${kind} ${name}`);
  return `SQLSTATE ${code} ${text}${where.length ? ` (${where.join(", ")})` : ""}`;
}

function applyNeutralising(file, sql, rules) {
  /** @type {NeutraliseRule[]} */
  const hits = [];
  let text = sql;
  for (const rule of rules) {
    if (rule.file !== file) continue;
    const lines = text.split("\n");
    let matched = 0;
    const next = lines.map((line) => {
      if (line.trim() === rule.statement) {
        matched += 1;
        return REPLACEMENT + ";";
      }
      return line;
    });
    if (matched !== 1) {
      throw new Error(
        `${file}: neutralise rule for "${rule.statement}" matches ${matched} lines, expected exactly 1: the file no longer contains the statement the harness was built around, so decide again whether it still needs neutralising`,
      );
    }
    text = next.join("\n");
    hits.push(rule);
  }
  return { sql: text, hits };
}

/**
 * Apply migration files to `db`, in order, each as one implicit transaction (a
 * single simple-protocol query, which Postgres runs atomically; a file that
 * opens its own begin/commit, like 0064, is honoured as written).
 *
 * @param {PGlite} db
 * @param {object} [opts]
 * @param {string} [opts.from]   first migration to apply (number or file name), inclusive
 * @param {string} [opts.upTo]   last migration to apply, inclusive
 * @param {string[]} [opts.skip] migrations in range to leave out; one that matches nothing is an error
 * @param {string} [opts.dir]    migrations folder (default: supabase/migrations)
 * @param {readonly NeutraliseRule[]} [opts.neutralise]
 * @param {(event: { file: string, status: "applied" | "skipped" | "failed", ms?: number, message?: string, neutralised: NeutraliseRule[] }) => void} [opts.onMigration]
 * @returns {Promise<string[] & { neutralised: NeutraliseRule[] }>} the files applied, in order;
 *   `.neutralised` lists every statement that was neutralised on the way.
 */
export async function applyMigrations(db, opts = {}) {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const rules = opts.neutralise ?? NEUTRALISED;
  const from = opts.from === undefined ? -Infinity : migrationNumber(opts.from);
  const upTo = opts.upTo === undefined ? Infinity : migrationNumber(opts.upTo);
  const inRange = listMigrations(dir).filter((f) => {
    const n = migrationNumber(f);
    return n >= from && n <= upTo;
  });

  const skipNumbers = new Set();
  for (const spec of opts.skip ?? []) {
    const n = migrationNumber(spec);
    if (!inRange.some((f) => migrationNumber(f) === n)) {
      throw new Error(`skip "${spec}" matches no migration in the range being applied (${inRange.length ? `${inRange[0]} to ${inRange.at(-1)}` : "empty range"})`);
    }
    skipNumbers.add(n);
  }

  const emit = opts.onMigration ?? (() => {});
  /** @type {string[] & { neutralised?: NeutraliseRule[] }} */
  const applied = [];
  /** @type {NeutraliseRule[]} */
  const neutralised = [];

  for (const file of inRange) {
    if (skipNumbers.has(migrationNumber(file))) {
      emit({ file, status: "skipped", neutralised: [] });
      continue;
    }
    const started = Date.now();
    const { sql, hits } = applyNeutralising(file, fs.readFileSync(path.join(dir, file), "utf8"), rules);
    try {
      await db.exec(sql);
    } catch (cause) {
      try {
        await db.exec("rollback");
      } catch {
        // nothing was open
      }
      const message = describeError(cause);
      emit({ file, status: "failed", message, neutralised: hits });
      const error = new Error(`${file}: ${message}`, { cause });
      Object.assign(error, { file, code: cause?.code, constraint: cause?.constraint, table: cause?.table });
      throw error;
    }
    applied.push(file);
    neutralised.push(...hits);
    emit({ file, status: "applied", ms: Date.now() - started, neutralised: hits });
  }

  Object.defineProperty(applied, "neutralised", { value: neutralised, enumerable: false });
  return /** @type {string[] & { neutralised: NeutraliseRule[] }} */ (applied);
}

// ---------------------------------------------------------------------------
// Catalog fingerprints (the same text is run against production to compare;
// see CATALOG_CONSTRAINTS_SQL for the one cast that makes it run)
// ---------------------------------------------------------------------------

/**
 * The constraints query exactly as dispatched. It does not run: `conname`
 * (name) || ':' gives text, and text || "char" is "operator is not unique"
 * (text || text via an implicit cast competes with text || anynonarray). It is
 * kept so a test can show that, and so nobody "restores" it by accident.
 */
export const CATALOG_CONSTRAINTS_SQL_AS_DISPATCHED =
  "select cl.relname as t, md5(string_agg(c.conname || ':' || c.contype, ',' order by c.conname)) as h, count(*)::int as n from pg_constraint c join pg_class cl on cl.oid = c.conrelid join pg_namespace ns on ns.oid = cl.relnamespace where ns.nspname = 'public' and c.contype in ('p','u','f','c') group by 1 order by 1";

/**
 * The same query with one cast, `c.contype::text`. The string being hashed is
 * identical, so a hash from here and a hash from production (run with this
 * text) are comparable.
 */
export const CATALOG_CONSTRAINTS_SQL =
  "select cl.relname as t, md5(string_agg(c.conname || ':' || c.contype::text, ',' order by c.conname)) as h, count(*)::int as n from pg_constraint c join pg_class cl on cl.oid = c.conrelid join pg_namespace ns on ns.oid = cl.relnamespace where ns.nspname = 'public' and c.contype in ('p','u','f','c') group by 1 order by 1";

export const CATALOG_POLICIES_SQL =
  "select tablename as t, md5(string_agg(policyname || ':' || cmd, ',' order by policyname)) as h, count(*)::int as n from pg_policies where schemaname = 'public' group by 1 order by 1";

/** @returns {Promise<{ constraints: { t: string, h: string, n: number }[], policies: { t: string, h: string, n: number }[] }>} */
export async function catalog(db) {
  const constraints = /** @type {{ t: string, h: string, n: number }[]} */ ((await db.query(CATALOG_CONSTRAINTS_SQL)).rows);
  const policies = /** @type {{ t: string, h: string, n: number }[]} */ ((await db.query(CATALOG_POLICIES_SQL)).rows);
  return { constraints, policies };
}

/** One table's constraint names (with types) and policy names (with commands). */
export async function catalogNames(db, table) {
  if (!IDENT.test(table)) throw new Error(`"${table}" is not a plain table name`);
  const constraints = (
    await db.query(
      `select c.conname as name, c.contype::text as type
         from pg_constraint c join pg_class cl on cl.oid = c.conrelid join pg_namespace ns on ns.oid = cl.relnamespace
        where ns.nspname = 'public' and cl.relname = $1 and c.contype in ('p','u','f','c')
        order by c.conname`,
      [table],
    )
  ).rows;
  const policies = (
    await db.query(
      "select policyname as name, cmd from pg_policies where schemaname = 'public' and tablename = $1 order by policyname",
      [table],
    )
  ).rows;
  return { constraints, policies };
}

// ---------------------------------------------------------------------------
// Export folder
// ---------------------------------------------------------------------------

/**
 * @typedef {{ table: string, rows: number, excludedColumns: string[], primaryKey: string[] }} ManifestTable
 * @typedef {{ id: string, email: string | null, created_at: string | null, last_sign_in_at: string | null, providers: string[] }} AuthUser
 * @typedef {{ dir: string, tables: (ManifestTable & { data: Record<string, unknown>[] })[], users: AuthUser[] }} ExportData
 */

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    // Never include the parser's message: it can quote file content.
    throw new Error(`cannot read ${path.basename(file)} as JSON (${e?.code ?? "invalid"})`);
  }
}

/**
 * Read and validate an export folder: manifest.json, auth-users.json, and one
 * <table>.json per manifest table. Pure file work, no database.
 * @returns {ExportData}
 */
export function readExport(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`export folder not found: ${dir}`);
  const manifest = readJson(path.join(dir, "manifest.json"));
  if (!manifest || !Array.isArray(manifest.tables)) throw new Error("manifest.json has no tables array");
  const users = readJson(path.join(dir, "auth-users.json"));
  if (!Array.isArray(users)) throw new Error("auth-users.json is not an array");

  const seen = new Set();
  const tables = manifest.tables.map((entry) => {
    const table = entry?.table;
    if (typeof table !== "string" || !IDENT.test(table)) throw new Error(`manifest.json lists a table with an unusable name`);
    if (seen.has(table)) throw new Error(`manifest.json lists table ${table} twice`);
    seen.add(table);
    const data = readJson(path.join(dir, `${table}.json`));
    if (!Array.isArray(data) || data.some((r) => r === null || typeof r !== "object" || Array.isArray(r))) {
      throw new Error(`${table}.json is not an array of row objects`);
    }
    if (typeof entry.rows === "number" && entry.rows !== data.length) {
      throw new Error(`${table}: manifest.json says ${entry.rows} rows but ${table}.json holds ${data.length}; the export is incomplete`);
    }
    return {
      table,
      rows: data.length,
      excludedColumns: Array.isArray(entry.excludedColumns) ? entry.excludedColumns.map(String) : [],
      primaryKey: Array.isArray(entry.primaryKey) ? entry.primaryKey.map(String) : [],
      data,
    };
  });

  for (const u of users) {
    if (!u || typeof u.id !== "string") throw new Error("auth-users.json has an entry without an id");
  }
  return {
    dir,
    tables,
    users: users.map((u) => ({
      id: u.id,
      email: u.email ?? null,
      created_at: u.created_at ?? null,
      last_sign_in_at: u.last_sign_in_at ?? null,
      providers: Array.isArray(u.providers) ? u.providers.map(String) : [],
    })),
  };
}

const PLACEHOLDER = "redacted";
const TEXT_TYPES = new Set(["text", "character varying", "character"]);
const BATCH = 500;

/**
 * Load an export into `db`. Foreign-key triggers are switched off for the load
 * (the export's own order is arbitrary) and switched back on before returning,
 * so migrations applied afterwards see real constraints. Columns the export
 * left out are filled with the text "redacted" when they are not null; a
 * not-null column that is not text is left to its default, or is an error.
 *
 * @returns {Promise<{ table: string, rows: number, placeholders: string[] }[]>} counts and column names only
 */
export async function loadExport(db, exp) {
  /** @type {{ table: string, rows: number, placeholders: string[] }[]} */
  const loaded = [];
  let current = "auth.users";
  await db.exec("set session_replication_role = replica");
  try {
    for (const u of exp.users) {
      await db.query(
        `insert into auth.users (id, email, created_at, last_sign_in_at, raw_app_meta_data)
         values ($1, $2, coalesce($3::timestamptz, now()), $4::timestamptz, $5::jsonb)`,
        [u.id, u.email, u.created_at, u.last_sign_in_at, JSON.stringify({ provider: u.providers[0] ?? "email", providers: u.providers })],
      );
    }
    loaded.push({ table: "auth.users", rows: exp.users.length, placeholders: [] });

    for (const t of exp.tables) {
      current = t.table;
      const { rows: meta } = await db.query(
        `select column_name, data_type, is_nullable, column_default
           from information_schema.columns where table_schema = 'public' and table_name = $1`,
        [t.table],
      );
      const columns = /** @type {{ column_name: string, data_type: string, is_nullable: string, column_default: string | null }[]} */ (meta);
      if (columns.length === 0) throw new Error(`export table ${t.table} does not exist at this point in the migration history`);
      const known = new Set(columns.map((c) => c.column_name));

      const keys = [...new Set(t.data.flatMap((r) => Object.keys(r)))];
      const unknown = keys.filter((k) => !known.has(k));
      if (unknown.length) throw new Error(`${t.table}: export has columns the schema does not: ${unknown.join(", ")}`);

      /** @type {string[]} */
      const placeholders = [];
      for (const col of t.excludedColumns) {
        const meta1 = columns.find((c) => c.column_name === col);
        if (!meta1) throw new Error(`${t.table}: manifest says column ${col} was left out, but the schema has no such column`);
        if (keys.includes(col) || meta1.is_nullable === "YES") continue;
        if (TEXT_TYPES.has(meta1.data_type)) placeholders.push(col);
        else if (meta1.column_default === null) {
          throw new Error(`${t.table}.${col} is left out of the export, is not null, has no default and is ${meta1.data_type}, so no placeholder fits`);
        }
      }

      if (t.data.length > 0) {
        const names = [...keys, ...placeholders].map(quote).join(", ");
        const select = [...keys.map(quote), ...placeholders.map(() => `'${PLACEHOLDER}'`)].join(", ");
        for (let i = 0; i < t.data.length; i += BATCH) {
          await db.query(
            `insert into public.${quote(t.table)} (${names}) select ${select} from jsonb_populate_recordset(null::public.${quote(t.table)}, $1::jsonb)`,
            [JSON.stringify(t.data.slice(i, i + BATCH))],
          );
        }
      }
      loaded.push({ table: `public.${t.table}`, rows: t.data.length, placeholders });
    }
  } catch (e) {
    throw new Error(`loading the export: ${describeError(e, { table: current })}`, { cause: e });
  } finally {
    await db.exec("set session_replication_role = origin");
  }
  return loaded;
}

// ---------------------------------------------------------------------------
// Rehearsal
// ---------------------------------------------------------------------------

function formatEvent(phase, e) {
  const tag = phase === "base" ? "base   " : "pending";
  if (e.status === "skipped") return `${tag}  skipped ${e.file} (--skip)`;
  if (e.status === "failed") return `${tag}  FAILED  ${e.file}: ${e.message}`;
  const note = e.neutralised.map((r) => ` NEUTRALISED: ${r.statement} (${r.reason})`).join("");
  return `${tag}  applied ${e.file} (${e.ms} ms)${note}`;
}

function formatCounts(before, after) {
  const names = Object.keys(before);
  const width = Math.max(5, ...names.map((n) => n.length));
  const head = `${"table".padEnd(width)}  ${"before".padStart(8)}${after ? `  ${"after".padStart(8)}` : ""}`;
  const body = names.map(
    (n) => `${n.padEnd(width)}  ${String(before[n]).padStart(8)}${after ? `  ${String(after[n] ?? 0).padStart(8)}` : ""}`,
  );
  return [head, ...body];
}

/**
 * Rehearse the pending migrations on a copy of real data: apply everything up
 * to `fromApplied` on an empty database, load the export, count rows, apply the
 * rest, count again. Logs counts and file names only, never a row.
 *
 * @param {object} opts
 * @param {string} opts.data          export folder
 * @param {string} [opts.fromApplied] last migration production already has (default 0055)
 * @param {string[]} [opts.skip]      pending migrations to leave out
 * @param {string} [opts.upTo]        stop after this migration (default: the newest file)
 * @param {string} [opts.dir]         migrations folder
 * @param {(line: string) => void} [opts.log]
 */
export async function runRehearsal(opts) {
  const log = opts.log ?? ((line) => console.log(line));
  const fromApplied = opts.fromApplied ?? "0055";
  const skip = opts.skip ?? [];
  const exp = readExport(opts.data);
  const lastApplied = migrationNumber(fromApplied);

  log(`rehearsal: ${exp.tables.length} tables and ${exp.users.length} auth users from ${opts.data}`);
  log(`production has migrations through ${padded(lastApplied)}; the rest are rehearsed${skip.length ? `; skipping ${skip.join(", ")}` : ""}`);

  const db = await createDatabase();
  const neutralised = [];

  const base = await applyMigrations(db, { dir: opts.dir, upTo: fromApplied, onMigration: (e) => log(formatEvent("base", e)) });
  neutralised.push(...base.neutralised);

  let loaded;
  try {
    loaded = await loadExport(db, exp);
  } catch (e) {
    await db.close();
    throw e;
  }
  for (const l of loaded) {
    log(`loaded  ${l.table}: ${l.rows} rows${l.placeholders.length ? `, left-out columns filled with "${PLACEHOLDER}": ${l.placeholders.join(", ")}` : ""}`);
  }
  const before = await rowCounts(db);

  let pending;
  try {
    pending = await applyMigrations(db, {
      dir: opts.dir,
      from: padded(lastApplied + 1),
      upTo: opts.upTo,
      skip,
      onMigration: (e) => log(formatEvent("pending", e)),
    });
  } catch (e) {
    log("row counts before the failed migration:");
    for (const line of formatCounts(before)) log(line);
    for (const r of neutralised) log(`NEUTRALISED ${r.file}: ${r.statement}`);
    await db.close();
    throw e;
  }
  neutralised.push(...pending.neutralised);

  const after = await rowCounts(db);
  log("row counts:");
  for (const line of formatCounts(before, after)) log(line);
  for (const r of neutralised) log(`NEUTRALISED ${r.file}: ${r.statement}`);
  if (neutralised.length === 0) log("neutralised statements: none");

  return { db, applied: [...base, ...pending], neutralised, before, after };
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const USAGE = `usage:
  node test/migrations/harness.mjs --data <export folder> [--from-applied 0055] [--skip 0061[,0062]] [--upto 0065]
  node test/migrations/harness.mjs --catalog [--upto 0055] [--names <table>]

  --data          folder holding manifest.json, auth-users.json and one <table>.json per table
  --from-applied  the newest migration production already has (default 0055); later ones are rehearsed
  --skip          pending migration(s) to leave out; repeatable or comma separated
  --upto          stop after this migration (default: the newest file)
  --catalog       apply migrations on an empty database and print two JSON arrays (constraint
                  and policy fingerprints per table), nothing else; --upto defaults to 0055
  --names         with --catalog: print that table's constraint and policy names instead`;

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = { data: undefined, fromApplied: undefined, skip: [], upTo: undefined, catalog: false, names: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--data") args.data = value();
    else if (a === "--from-applied") args.fromApplied = value();
    else if (a === "--skip") args.skip.push(...value().split(",").filter(Boolean));
    else if (a === "--upto" || a === "--up-to") args.upTo = value();
    else if (a === "--catalog") args.catalog = true;
    else if (a === "--names") args.names = value();
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} the exit code
 */
export async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  if (args.catalog) {
    if (args.data) {
      console.error(`--catalog does not take --data\n${USAGE}`);
      return 2;
    }
    try {
      const db = await createDatabase();
      const applied = await applyMigrations(db, { upTo: args.upTo ?? "0055" });
      for (const r of applied.neutralised) console.error(`NEUTRALISED ${r.file}: ${r.statement}`);
      const result = args.names ? await catalogNames(db, args.names) : await catalog(db);
      console.log(JSON.stringify(result.constraints));
      console.log(JSON.stringify(result.policies));
      await db.close();
      return 0;
    } catch (e) {
      console.error(`catalog failed: ${e.message}`);
      return 1;
    }
  }

  if (args.names) {
    console.error(`--names only works with --catalog\n${USAGE}`);
    return 2;
  }
  if (!args.data) {
    console.error(`missing --data <export folder>\n${USAGE}`);
    return 2;
  }
  try {
    const result = await runRehearsal({
      data: args.data,
      fromApplied: args.fromApplied,
      skip: args.skip,
      upTo: args.upTo,
    });
    await result.db.close();
    return 0;
  } catch (e) {
    console.error(`rehearsal failed: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
