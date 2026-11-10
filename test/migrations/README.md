# Migration rehearsal

Runs `supabase/migrations/*.sql`, unmodified, in an in-memory Postgres
([PGlite](https://pglite.dev), already a dev dependency). No Docker, no Supabase
CLI, no network, no real database. Two uses:

1. **Tests.** `__tests__/v2-migrations-apply.test.ts` runs with the normal unit
   suite (about 15 seconds). It applies every migration to an empty database,
   applies `0056` to `0065` over a small invented two-tenant data set, and checks
   what the security release must leave behind.
2. **A command line** that rehearses the migrations production does not have yet
   on a local copy of real data.

## What is here

| File | What it is |
| --- | --- |
| `harness.mjs` | `createDatabase()`, `listMigrations(dir?)`, `applyMigrations(db, opts)`, `loadSeed(db)`, `rowCounts(db)`, `readExport` / `loadExport`, `runRehearsal(opts)`, `catalog(db)`, and the command line |
| `supabase-stubs.sql` | What Supabase gives a migration, and nothing more (below) |
| `seed-two-tenants.sql` | Invented data for two tenants, written against the schema after `0055` |

### The stubs

- Roles `anon`, `authenticated` and `service_role` (the last bypasses row level
  security), and Supabase's **default privileges** in `public`: new tables get
  all privileges, sequences `rwU`, functions execute, for all three roles. This
  is what makes the "anon holds nothing after `0065`" check mean something: the
  tests also show that anon does hold privileges before `0065`.
- `auth` schema with `users` and `uid()` (reads the `request.jwt.claim.sub`
  setting, as PostgREST sets it).
- `storage` schema with `buckets`, `objects` (row level security on) and
  `foldername()`.
- `cron`, `net` and `vault` stand-ins that only **record** what they were asked
  to do: `cron.job` (re-scheduling a name replaces it, as pg_cron does),
  `net.requests`, `vault.secrets`. Nothing is ever sent.

### The one statement that is neutralised

The migration files run unmodified with one allowed exception, listed in
`NEUTRALISED` at the top of `harness.mjs`:

| File | Statement | Why |
| --- | --- | --- |
| `0061_retention_prune.sql` | `create extension if not exists pg_cron with schema pg_catalog;` | pg_cron is a compiled extension PGlite cannot load. The `cron` schema it would create comes from the stubs. |

The rule names one file and one whole line. Only that line is replaced (by
`select 1`). If the file stops containing the line, the run stops with an error
instead of carrying on. Every neutralised statement is returned by
`applyMigrations` (as `.neutralised`) and printed by the command line.

### How a migration is applied

Each file goes in as one simple-protocol query, which Postgres runs as one
transaction. A failure rolls the whole file back, clears the aborted
transaction, and throws an error that starts with the file name followed by
Postgres's message. A file that opens its own `begin`/`commit` (0064 does) is
honoured as written.

`applyMigrations(db, { from, upTo, skip, dir })` takes migration numbers
(`"0056"`) or file names. `from` and `upTo` are inclusive. A `skip` that matches
nothing in the range is an error, so a typo cannot quietly apply a migration you
meant to leave out.

## Rehearsing on a copy of real data

```bash
node test/migrations/harness.mjs --data <export folder> [--from-applied 0055] [--skip 0061] [--upto 0065]
```

The export folder holds what the export tool writes:

- `manifest.json`: `{ "tables": [{ "table", "rows", "excludedColumns": [], "primaryKey": [] }] }`
- one `<table>.json` per manifest table: an array of row objects keyed by column name
- `auth-users.json`: `[{ id, email, created_at, last_sign_in_at, providers }]`

What it does:

1. Applies every migration up to `--from-applied` (default `0055`, what
   production has) on an empty database.
2. Loads the export. Foreign-key triggers are off during the load (the export's
   table order is arbitrary) and switched back on afterwards, so the remaining
   migrations meet real constraints. Columns the export left out
   (`excludedColumns`) that are `not null` text get the placeholder `redacted`.
   A manifest row count that differs from the file's is an error: the export is
   incomplete and a rehearsal on it would give false confidence.
3. Counts the rows of every table.
4. Applies the remaining migrations (minus any `--skip`), one line each.
5. Counts again and prints the table of before and after.

It exits 0 on success, 1 when a migration or the load fails (the failed file is
named, the "before" counts are still printed), 2 for a usage error.

**It never prints a row.** It prints file names, table and column names,
constraint names, counts, and Postgres's one-line message. The `DETAIL` line,
which quotes the failing row, is never printed, and for data exceptions
(class `22`, such as a bad uuid) the part of the message after the colon, which
quotes the value, is cut as well.

### Production runs `0061` differently

Production applies `0061` with pg_cron installed; here the `create extension`
line is neutralised. Run the rehearsal both ways: with everything, and with
`--skip 0061` (the sequence that will actually run in production if pg_cron is
not enabled first).

## Comparing constraint and policy names with production

```bash
node test/migrations/harness.mjs --catalog [--upto 0055]
node test/migrations/harness.mjs --catalog --upto 0055 --names tasks
```

`--catalog` applies the migrations up to `--upto` (default `0055`) on an empty
database and prints exactly two lines of JSON, nothing else: a fingerprint per
table of its constraints, then of its policies (`{ t, h, n }`: table, md5 of the
sorted `name:type` list, count). Run the same two queries on production
(`CATALOG_CONSTRAINTS_SQL`, `CATALOG_POLICIES_SQL` in `harness.mjs`) and compare.
Where a table differs, `--names <table>` prints that table's constraint names
with types and policy names with commands instead of the hashes.

Why it matters: `0056`-`0065` drop and re-create constraints and policies **by
name**. If production's name differs from the file's, a `drop ... if exists`
silently does nothing and the old object stays.

**One cast.** The constraints query as first written,
`c.conname || ':' || c.contype`, fails with `operator is not unique: text ||
"char"` (it is the same in any Postgres: `text || text` through an implicit cast
competes with `text || anynonarray`). `CATALOG_CONSTRAINTS_SQL` has
`c.contype::text`. The string being hashed is identical, so the two sides are
comparable, but run the cast version on production.
