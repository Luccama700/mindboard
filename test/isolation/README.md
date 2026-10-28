# The two-tenant isolation probe

Mindboard's MCP tool layer runs on an **RLS-bypassing service client**. Tenant
isolation there is not enforced by the database — it is an invariant held up by
an explicit `.eq("user_id", …)` on every query (the "Multi-tenant MCP invariant"
in `AGENTS.md`). One future query missing it is a full cross-tenant breach.

This directory is the regression net for that invariant. It creates two
throwaway tenants, seeds identifiable data in every domain, and then has tenant
A attack tenant B through every surface the app exposes.

> **It writes to whatever Supabase project you point it at**: two real auth
> users and rows in ~45 tables. Run it against a local stack or a Supabase
> branch. It refuses to run against production — see **Safety rails**.

---

## Running it

```bash
npm ci
npm run test:isolation
```

Two things must be true before that is more than an RLS check:

1. the Supabase project you point it at is **not** production;
2. a dev server is running against that same project, and `MCP_URL` points at it.

Without `MCP_URL` it runs the app-path (RLS) and URC-table checks only and says
so. That is a legitimate, much cheaper mode — it just does not touch the
service-client layer, which is the whole reason this exists.

### Against a local stack (`supabase start`)

Needs Docker and the Supabase CLI.

```bash
# 1. bring up the local stack; it prints the API URL, anon key and service_role key
supabase start

# 2. apply the schema (every migration, in order)
supabase db reset

# 3. point the app at the local stack and run it in another terminal.
#    Use a separate env file so your real .env.local is never involved.
#    .env.local.probe  (gitignored — see below)
#      NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
#      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<anon key from supabase start>
#      SUPABASE_SERVICE_ROLE_KEY=<service_role key from supabase start>
#      ASSISTANT_KEY_SECRET=<any 32+ random bytes>
#      MCP_OAUTH_SECRET=<any 32+ random bytes>
#      URC_OWNER_USER_ID=00000000-0000-4000-8000-000000000000
npx next dev

# 4. run the probe
MINDBOARD_PROBE_TARGET=local \
MINDBOARD_PROBE_ENV=$PWD/.env.local.probe \
MCP_URL=http://localhost:3000/api/mcp/mcp \
npm run test:isolation
```

On Windows PowerShell, set the three variables with `$env:NAME = "value"` first,
then `npm run test:isolation` — there is no inline `VAR=x cmd` form.

`.env.local.probe` matches `.env*` in `.gitignore`, so it is not committable.
Confirm with `git check-ignore -v .env.local.probe` before putting a key in it —
this repo is **public**.

### Against a Supabase branch

```bash
supabase branches create probe      # or create it in the dashboard
# take that branch's URL + anon + service_role keys into .env.local.probe
MINDBOARD_PROBE_TARGET=branch \
MINDBOARD_PROBE_ENV=$PWD/.env.local.probe \
MCP_URL=http://localhost:3000/api/mcp/mcp \
npm run test:isolation
```

A branch is a real hosted project with real auth users. Delete it afterwards.

Pointing `MCP_URL` at a deployed Vercel **preview** also works, but that
deployment's own env decides which database is written to — not
`MINDBOARD_PROBE_ENV` — so the rails cannot protect you there. If you do it,
the preview needs `MCP_OAUTH_SECRET` set (or the whole OAuth section fails at
the first `/authorize`) and deployment protection off, or every request is a
401 HTML page.

---

## Environment

| Variable | Required | What it is |
|---|---|---|
| `MINDBOARD_PROBE_TARGET` | **yes** | `local` or `branch`. No default: naming it is how you confirm you know which database this writes to. The host is checked against the word. |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | The target project's API URL. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes | Anon key. The probe uses it for each tenant's own session client, so a seed failure is itself an RLS finding. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Creates and deletes the throwaway users, seeds the service-role-only tables, and takes the before/after snapshots of the victim. |
| `MCP_URL` | no | e.g. `http://localhost:3000/api/mcp/mcp`. Without it the MCP, executor and OAuth sections are skipped. |
| `MINDBOARD_PROBE_ENV` | no | Absolute path to a dotenv-style file to read the above from. Explicit process variables still win. |
| `MINDBOARD_PROBE_FORBIDDEN_REFS` | no | Extra comma-separated project refs to refuse. It can only add; the production ref cannot be removed. |

The probe never reads `.env.local`. On a normal Mindboard checkout that file
holds the single live project, so a default that reads it is a default that
writes to production.

Server-side env that changes what gets tested:

| Variable on the dev server | Effect |
|---|---|
| `URC_OWNER_USER_ID` | The four URC tools register only when this is set. Set it to **any UUID that is not tenant A or B** — the probe asserts both tenants are refused, which is the gate URC actually enforces. Unset, those four are reported as "NOT REGISTERED" and are not tested. |
| `MCP_OAUTH_SECRET` | Required for the OAuth section. |
| `MCP_BEARER_TOKEN` + `MINDBOARD_OWNER_USER_ID` | Adds one check that the legacy static bearer still maps to the owner and not to a probe tenant. |

---

## Safety rails

`assertSafeTarget` (`harness.mjs`) runs **before the first auth user is
created**, and is unit-tested in `__tests__/isolation-probe.test.ts`:

- **Production is refused outright**, whatever `MINDBOARD_PROBE_TARGET` says,
  and whatever the scheme or port — the check is on the project ref, which is
  what identifies the database. The ref is hardcoded on purpose: a rail that has
  to be configured before it protects you is not a rail. (It is not a secret —
  it is the host in `NEXT_PUBLIC_SUPABASE_URL`, which ships in every browser's
  JS bundle, and it already appears in several committed docs.)
- **`MINDBOARD_PROBE_TARGET` is required**, and the host is checked against it.
  `local` must be a loopback or private address; `branch` must be a
  Supabase-hosted host. "`local`" pointed at someone else's hosted project is
  the mistake the ref check alone would miss.

Teardown is registered before anything else can throw, `SIGINT`/`SIGTERM` are
handled, and the deletion of each user is verified (gone from auth, rows
cascaded). Nothing in the output is ever a real user's data: only ids and
per-run marker strings the probe created itself. Tokens, PATs, service-role keys
and `Authorization` headers are never printed.

---

## What it proves

With `MCP_URL` set and the server configured as above:

- **Every one of the 69 registered MCP tools** is called with tenant A's token
  and tenant B's object ids and names (`tool-matrix.mjs`, 83 calls). Every
  response is scanned for any of B's strings that A did not supply in the
  request — per occurrence, so an echoed id is not mistaken for a disclosure
  and a sent superstring does not blind the scanner to the rest.
- **Coverage is checked against the live `tools/list`**, so registering a tool
  without adding an entry fails the probe instead of silently shrinking
  coverage. The same claim is additionally enforced statically in
  `npm run test`, by parsing `route.ts` — so it gates a PR with no database.
- **All 24 `confirm_action` executors** are driven across the boundary
  (`forged-proposal.mjs`). Propose-time resolution refuses a cross-tenant id,
  which means the executors' own `.eq("user_id", ownerId)` guards are otherwise
  unreachable; the probe forges the missing `ai_audit_log` row. Every entry is
  paired with a **control** on A's own scratch row that must reach the executor,
  because a forged shape that has drifted from the executor's validator fails
  *before* the ownership check and still reads as "refused".
- **Nothing of B's moved.** A full before/after fingerprint of all 44
  user-scoped tables is compared byte-for-byte across the whole attack sweep,
  and a table that cannot be read is reported rather than silently skipped.
- **Proposals are caller-scoped** in both directions: neither tenant can
  confirm, cancel or list the other's.
- **The OAuth authorization server**, over real HTTP (`oauth-probe.mjs`):
  the registration host allowlist, that a bare `GET /authorize` never mints a
  code, redirect equality at both ends, PKCE S256 enforcement, consent-ticket
  binding to user and challenge, and that an issued access token resolves to the
  consenting user and only their data.
- **RLS**, on the app path, for both tenants — including that
  `urc_devices`/`urc_jobs` admit *no* session client at all, that `urc_log` is
  read-own and append-only, that `claim_urc_job` is not callable by a session,
  and that neither tenant can read the other's plaintext `google_tokens` or
  `vault_settings.github_token`.

## What it does not prove

- **It is a snapshot, not a theorem.** It proves these surfaces hold *now*. The
  static check (`__tests__/tenant-scope-invariant.test.ts`) is the part that
  catches the *next* missing filter, and that one is a linter: it cannot follow
  dataflow, and it has an allowlist.
- **Two tools stay weak** (`BLIND_SPOTS` in `tool-matrix.mjs`): `lookup_prices`
  needs a provider key encrypted under the server's `ASSISTANT_KEY_SECRET` and a
  real lookup would spend money; `process_reel` needs
  `WORKER_ALLOWED_USER_IDS`, an env var that can never name a tenant created at
  runtime. Both fail before reaching their data path, so a scoping bug *inside*
  them would not turn this red.
- **Four executors cannot "apply"** for a throwaway tenant, so their controls
  assert something weaker and named: `generate_audio_overview` must fail only
  *after* resolving the caller's own course, and `create_event`,
  `reschedule_event` and `spawn_urc` are refused by a caller gate that fires
  before any row is resolved. The vocabulary is in the header of
  `forged-proposal.mjs`.
- **The URC four are only tested when `URC_OWNER_USER_ID` is set** on the
  server. Unset, the run prints "NOT REGISTERED" for them and the final count
  does not include them.
- **No Google or GitHub account is exercised.** The victim's seeded credentials
  are deliberately junk. The assertion is about *which* credential the code
  reaches for, not about the external API's behaviour.
- **It does not test the in-app assistant's confirm rail** (that uses the cookie
  client, so RLS backs it), the watch endpoints, or `/api/capture`.
- **It does not test authorization beyond tenancy.** "A cannot touch B's data"
  is not "A cannot do something A should not be allowed to do at all" — the
  audit's H1/H2 findings (one static bearer; model-confirmable writes) are a
  different boundary and are untouched by this.
- **The row counts are hand-maintained.** `OWNED_TABLES` in `seed.mjs` is the
  snapshot's weak point: a user-scoped table missing from it is invisible to the
  strongest assertion here. `npm run test` asserts the ten newest are present,
  but it cannot enumerate the schema.

---

## Files

| File | What it is |
|---|---|
| `../isolation-proof.mjs` | The runner. Rails, tenant setup, app/RLS path, then the sections below, then verified teardown. |
| `harness.mjs` | Env loading, the rails, the reporter, and the per-occurrence leak scanner. |
| `seed.mjs` | `OWNED_TABLES`, one tenant's full row set, the victim-only decoys, and the before/after fingerprint. |
| `tool-matrix.mjs` | The attack table: one or more cross-tenant calls per registered tool, plus `BLIND_SPOTS` and `CONDITIONAL_TOOLS`. |
| `mcp-probe.mjs` | Drives the attack table and reports coverage against the live `tools/list`. |
| `forged-proposal.mjs` | Forged `ai_audit_log` rows + paired controls, one per executor. |
| `oauth-probe.mjs` | The OAuth authorization server over real HTTP. |
| `../../__tests__/isolation-probe.test.ts` | The probe's own detectors, the rails, and the static coverage claims. Runs in `npm run test`. |
| `../../__tests__/tenant-scope-invariant.test.ts` | The static scope linter. Runs in `npm run test`. |

## Adding a tool

1. Add an entry to `TOOL_MATRIX` pointing at the victim's ids **and** names
   (fuzzy-name resolution is its own attack surface).
2. If it has an executor, add a `FORGERIES` entry keyed on the **`EXECUTORS`
   key** — not the MCP tool name; they differ for `complete_recurring` — with a
   control and both verifiers.
3. If it touches a new table, add it to `OWNED_TABLES`.
4. `npm run test` will tell you if you missed any of these. It will not tell you
   whether the assertion is any good — read `BLIND_SPOTS` and the outcome
   vocabulary before deciding yours is strong.
