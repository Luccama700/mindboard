# Mindboard → AI second brain / life command center

Research + build plan. Started 2026-06-01. This document is the durable record of
the direction and of every change made along the way.

## Vision

Evolve Mindboard from a task/calendar app into a **glanceable life command center**
with an **in-app AI assistant** that has access to all life data, an **Obsidian-like
notes/knowledge layer**, and **MCP interoperability** with other assistants — so that
"whenever I don't know what to do, I can ask what the best next steps are."

Decomposed into four capabilities + one spine:

- **A. Glanceable command center** — deterministic synthesis over existing data.
- **B. Second-brain substrate** — notes, `[[wikilinks]]`, backlinks, daily notes, semantic search.
- **C. In-app assistant** — Claude with tools over all domains.
- **D. MCP interoperability** — Mindboard as an MCP server; assistant as an MCP client.
- **Spine: one agent tool layer** — typed read/write tools, **built once, exposed everywhere**
  (in-app assistant, MCP server, proactive planner).

## Locked decisions

- **Autonomy = write-with-confirmation.** Writes (create task, log spend, append note) go
  through an explicit propose → confirm step, with an `ai_audit_log` (Phase 2).
- **AI stack = undecided** — revisit at Phase 2. Candidates: Vercel AI SDK (fast, +dep),
  raw Anthropic SDK (minimal-dep ethos), Claude Agent SDK (heaviest, best for the planner).
  Phase 0/1 are intentionally **stack-agnostic** so this needn't be decided yet.
- **Scope expansion authorized** (notes, goals, pgvector, AI tables) — same explicit
  override as the finance/inventory recurring-table exceptions.
- RAG via Supabase **pgvector**; MCP server auth may start as a single-user bearer token.

## Phased roadmap

| Phase | What | Status |
|---|---|---|
| **0** | AI-readiness refactor: read layer + snapshots + tool-registry seam | **done (2026-06-01)** |
| **1** | Glanceable "vitals" command center on the dashboard | **done (2026-06-01)** |
| 2 | In-app assistant (read-first; writes behind confirm + audit) | planned |
| 3 | Notes / wikilinks / backlinks / daily notes + semantic search | planned |
| 4 | Goals + "next best step" planner + PWA morning brief | planned |
| 5 | MCP server + external MCP connector | planned |

---

## Implementation log — Phase 0 & 1 (2026-06-01)

Additive only. No existing finance/inventory behavior changed; the only edited file
is `app/page.tsx` (to mount the vitals strip). Verified: `npm run lint` clean,
`npm run test` 69 pass, `npm run build` succeeds.

### Phase 0 — the seam

**Read layer** (reusable, React `cache()`-wrapped, RLS- + explicit-`user_id`-scoped):
- `app/lib/data/finance.ts` — `getAccounts`, `getActiveRecurringExpenses`, `getBalanceChangesOn`.
- `app/lib/data/inventory.ts` — `getInventoryItems`, `getInventoryUsages`.

**Snapshots** (pure, unit-tested; compose reads + the existing tested projections):
- `app/lib/snapshots/finance.ts` — `financeSnapshot` → net worth, today delta, next bill
  (reuses `finance-projection.ruleLandsOn`).
- `app/lib/snapshots/inventory.ts` — `inventorySnapshot` → low/out counts, soonest run-out
  (reuses `inventory-projection`).
- `app/lib/snapshots/tasks.ts` — `tasksSnapshot` → overdue / due-today / due-soon counts.
- `app/lib/snapshots/schedule.ts` — `scheduleSnapshot` → next timed event + free waking hours
  today (the one piece of genuinely new logic: interval-merge free-gap math).

**Tool registry seam:**
- `app/lib/agent/registry.ts` — typed catalog of read tools (wired to snapshots) and write
  tools (cataloged, `confirm: true`, mapped to existing `app/actions/*`). No LLM wiring yet;
  this is the single source of truth Phase 2 + the MCP server will both consume.

**Tests:**
- `__tests__/vitals-snapshots.test.ts` — 17 tests across the four snapshots + registry validity.

### Phase 1 — the glanceable command center

- `app/_components/vitals-strip.tsx` — presentational server component; a horizontally
  scrollable strip of five tiles (net worth, next bill, tasks, next up, inventory) using
  Terminal Calm theme tokens. Net-worth/next-bill link to `/finance`, inventory to `/inventory`.
- `app/page.tsx` — added `getVitalsData` (reuses the cached `getDashboardData` for tasks/events,
  adds accounts/recurring/inventory/today-changes reads), a `VitalsSection`, a `VitalsSkeleton`,
  and mounted them in a `Suspense` boundary above the today/calendar grid.

### Adjacent finance work shipped (2026-06-01)

Not part of the second-brain phases, but landed in the same version: the finance
"where did it go?" flow now supports **splitting one balance decrease across
multiple spending categories** (each split is its own ledger row; amounts must sum
to the decrease). Helpers `splitEvenly`/`sumMoney` in `app/_components/money.ts`
(unit-tested); see the Finance section of `AGENTS.md`.

### Notes & follow-ups

- The vitals strip anchors to **today**; it reuses the dashboard's month-scoped events for
  the "next up" tile, so browsing the calendar to a non-current month can under-report today's
  free hours. Finance "today delta" is always correct (queried for today directly).
- Free-gap wake window is hard-coded 08:00–22:00 (local/server time, matching the app's
  existing date convention). Worth making user-configurable later.
- Defaults chosen: 5 tiles in the listed order; "next bill" instead of a runway figure
  (runway needs wage income, which requires per-source Google fetches — deferred).
- Deferred to Phase 2: wiring registry `handler`/`preview` functions, the `ai_audit_log`
  table, and the confirm UI.
- Optional cleanup (not done, to keep changes narrow): the duplicated `toDateKey` /
  `normalizeMonth` / `currentMonth` helpers across `app/page.tsx` and `app/finance/page.tsx`
  could move into `app/_components/date-utils.ts`.

---

## Strategic redirection (2026-07-02) — merge with the 2ndBrain vault

Recorded per `docs/MINDBOARD_KICKOFF.md`. Mindboard has merged, conceptually, with
**2ndBrain**, an Obsidian vault maintained by Claude in Cowork. The vault owns identity,
knowledge, goals, and narrative; Mindboard owns operations (tasks, calendar, money,
inventory). Claude clients span both. Consequences for the phased roadmap above:

- **Phase 3 (notes / wikilinks / pgvector in Postgres): CANCELLED.** The vault is the
  knowledge layer; a second Postgres knowledge store would split the brain.
- **Phase 2 (in-app chat assistant): DEPRIORITIZED indefinitely.** Claude-in-Cowork with
  vault + Supabase-MCP access already is the assistant with full data access.
- **Phase 4 (morning brief): moves out of this repo.** A Cowork scheduled task will consume
  the MCP tools.
- **Phase 5 (MCP server): PROMOTED to the next milestone** (Milestone 1) — the repo's real
  mission: make Mindboard's data reachable by every Claude surface via a remote MCP server
  built on the Phase 0 tool registry, preserving write-with-confirmation + audit log.

Net: Phase 3 cancelled; Phase 2 deprioritized; Phase 4 relocated to Cowork; Phase 5 promoted
(next). Phases 0 & 1 remain done.

---

## Implementation log — Milestone 0 (2026-07-02): bring it back to life

Session goal: app runs locally and in production again; fix only what rot broke. Plan mode
first, additive only, lint/test/build gated.

**Shipped (local, additive):**
- Fixed one env-name rot bug: `.env.local` defined `GOOGLE_SECRET_KEY`, but
  `utils/google/calendar.ts` reads `process.env.GOOGLE_CLIENT_SECRET` (matching the README).
  Renamed the key in the local, gitignored file (value unchanged). Google Calendar token
  refresh was silently broken until this.

**Verified green:** `npm install` clean; `npm run lint` clean; `npm run test` 76 pass;
`npm run build` succeeds. Dev server boots; `/`, `/login`, `/finance`, `/inventory`,
`/groups`, `/inbox` all return HTTP 200 with no server errors; `proxy.ts` Supabase middleware
runs.

**Database (via reconnected Supabase MCP, project `kdsunzpcjfzkidejtnyp`):**
- Migrations required by the committed code (0001–0010 equivalents) are all applied.
- **Data survived the pause:** 19 tasks, 8 groups, 3 accounts, 15 balance_changes,
  17 inventory_items, 2 google_tokens, 1 user_settings, 2 auth users.

**Finding — orphaned schema (repo↔DB divergence).** The live DB holds six migrations dated
2026-06-12 that exist in **no** git branch/history/reflog, in **no** working-tree code, and
**nowhere** on disk (checked git `-S`, Spotlight, the 2ndBrain vault, and prior agent-session
logs):
- `0011_user_settings` — timezone, wake window, hashed iOS-Shortcuts capture token.
- `0012_goals`, `0013_daily_logs` — Phase 4 intent + capacity layers.
- `0014_ai_assistant` — `ai_conversations`, `ai_messages`, `ai_audit_log` (Phase 2
  propose→confirm design).
- `0015_assistant_api_key` — `user_settings.anthropic_api_key`.
- `0016_mcp_server` — `user_settings.mcp_token_hash` + `ai_audit_log.source` in
  {`assistant`,`mcp`} (Phase 5 groundwork).

Repo's last commit is 2026-06-05; there are no commits 2026-06-08…06-16. Conclusion: on
2026-06-12 a session applied these migrations directly via the Supabase MCP `apply_migration`
tool, ahead of the roadmap, and the application code was never written / committed /
persisted. This is **orphaned schema, not lost code.** The SQL is clean and RLS-scoped and is
a usable foundation for Milestone 1 — its `mcp_token_hash` + audit-log `source` design already
matches the MCP milestone's intent.

**Decision (owner, this session):** document-only. Leave the orphaned schema in place,
untouched; do not back-fill migration files and do not drop tables in Milestone 0. Reconcile
deliberately at the start of Milestone 1.

**Owner-gated, not done this session** (browser/interactive, can't be automated):
- Smoke test locally: Google OAuth login → create a task → calendar renders → `/finance`
  loads → vitals strip shows (confirm the 19 tasks / balances appear).
- Production: confirm `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` on Vercel, redeploy if the
  last deploy is stale, verify prod end-to-end, confirm the iOS PWA still opens and captures.

**Next:** Milestone 1 — the MCP server (Phase 5). First step: decide back-fill-vs-adopt of the
orphaned 0011/0014/0016 schema so the server builds on existing tables rather than inventing
new ones.

---

## Implementation log — Milestone 1 (2026-07-02): the MCP server (Phase 5)

Built Mindboard's remote MCP server on the Phase 0 tool registry, per the kickoff. Additive —
no existing behavior changed. Deps: `mcp-handler` 1.1.0, `@modelcontextprotocol/sdk` 1.26.0,
`zod` 3.25 (SDK ≥1.26.0 for the known-vuln fix).

**Orphaned schema — back-filled (owner decision this session).** The six 2026-06-12 migrations
were written to `supabase/migrations/0011_user_settings.sql … 0016_mcp_server.sql` verbatim from
the live DB, so the repo now reproduces production. No DB change (already applied). The server
adopts the existing `ai_audit_log` (+ its `source` column) rather than creating a new table.

**Server (all new, additive):**
- `app/api/mcp/[transport]/route.ts` — `createMcpHandler` (basePath `/api/mcp`, stateless
  streamable HTTP, SSE disabled → no Redis) wrapped with a static bearer-token check
  (`MCP_BEARER_TOKEN`, constant-time compare, never logged). Endpoint: `POST /api/mcp/mcp`.
- Session-less data path: `utils/supabase/service.ts` (service-role client) + `app/lib/mcp/config.ts`
  (`MINDBOARD_OWNER_USER_ID`). Service role bypasses RLS, so every query filters by the owner id
  explicitly — the invariant that replaces RLS here.
- Reads (`app/lib/mcp/reads.ts`): reuse the pure snapshots (`financeSnapshot`/`tasksSnapshot`/
  `inventorySnapshot`) untouched; add list tools (tasks/groups/accounts/categories/recent ledger)
  so a client has valid ids for writes.
- Writes (`app/lib/mcp/writes.ts` + `validate.ts` + `audit.ts`): propose → confirm. A propose tool
  records a `proposed` `ai_audit_log` row (`source='mcp'`) and returns `{ proposalId, preview }`;
  `confirm_action` re-executes from the stored input scoped to the owner and flips the row to
  `executed` (guarded so a double-confirm can't re-run a write). Mirrors `createTask` /
  `toggleTaskStatus` / `recordBalanceChange` semantics session-lessly. Pure validators are unit-tested.
- 13 tools: 8 reads, `create_task` / `complete_task` / `log_spend`, `confirm_action`, `cancel_action`.

**Verified:** `npm run lint` clean; `npm run test` 90 pass (+14 in `__tests__/mcp-validate.test.ts`);
`npm run build` succeeds (route `/api/mcp/[transport]` present). Protocol smoke test via the SDK
client against `npm run dev`: unauthenticated POST → 401; authenticated `tools/list` → all 13 tools;
a read tool without the service key returns a clean guarded tool-error, not a crash.

**Owner-gated (not automatable this session):**
- Add `SUPABASE_SERVICE_ROLE_KEY` to `.env.local` + Vercel. `MINDBOARD_OWNER_USER_ID`
  (`8fd62772-a371-4d26-8a93-678b88c2b879`) and a generated `MCP_BEARER_TOKEN` were added to
  `.env.local`; set both in Vercel too.
- Deploy; add `https://<domain>/api/mcp/mcp` on claude.ai as a custom connector with the bearer
  token; run create_task → confirm and confirm an `ai_audit_log` row lands (the kickoff's done-criteria).
  Verify claude.ai accepts a static bearer; OAuth is the documented fallback if not (kickoff anticipated this).

**Deferred / notes:** the schedule/Google read tool (session-less Google token refresh). "Today"
uses server time (UTC on Vercel), consistent with the rest of the app; `user_settings.timezone`
is not yet consulted. Finance stays read-safe by default — `log_spend` only ever proposes.

**Next (out of this repo):** Cowork swaps raw Supabase reads for the connector and schedules the
morning brief.

---

## Implementation log — Milestone 1b (2026-07-03): OAuth for the MCP server

Milestone 1 shipped + deployed with static-bearer auth and was read-verified in prod
(net worth, tasks, inventory over a real MCP client). But **claude.ai custom connectors require
OAuth 2.1**, not a static header — so the server became a minimal OAuth 2.1 authorization server.
Additive; the 13 tools are unchanged.

**Approach — self-hosted, stateless, no new dependency.** Every OAuth artifact (client_id, auth
code, access + refresh tokens) is an HMAC-SHA256-signed token (`app/lib/mcp/oauth.ts`, keyed by
`MCP_OAUTH_SECRET`) that embeds its own state — so there are **no OAuth DB tables** and it's
serverless-safe. Fixed-alg verification (no header-alg trust) avoids alg-confusion; per-token
`typ` prevents cross-use. TTLs: code 60s, access 1h, refresh 30d. Trade-off: no pre-expiry
revocation list (acceptable single-user).

**Owner decisions this session:** the `/authorize` gate **reuses the app's Google/Supabase login**
(only the owner id can approve; unauthenticated → bounce through `/login?next=…` and back). The
static `MCP_BEARER_TOKEN` is **kept** as an alternate auth for the inspector / curl / Claude Desktop.

**New endpoints (native Next route handlers — the SDK's OAuth code is Express-only):**
- `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-authorization-server`
  (CORS-open discovery; origin derived via `mcp-handler`'s `getPublicOrigin`).
- `POST /api/mcp/oauth/register` (DCR, RFC 7591) → stateless `client_id` embedding redirect_uris.
- `GET /api/mcp/oauth/authorize` → validates client + PKCE, owner-session gate, issues an auth code.
- `POST /api/mcp/oauth/token` → `authorization_code` (PKCE S256 verified) + `refresh_token` grants.
- `app/api/mcp/[transport]/route.ts` now wraps the handler in `mcp-handler`'s `withMcpAuth`;
  `verifyToken` accepts an OAuth access token **or** the static bearer, and the 401 carries the
  `WWW-Authenticate` resource_metadata pointer that kicks off discovery.
- `app/login/page.tsx` now threads a relative `next` through Google login (guarded against open
  redirect); `app/auth/callback/route.ts` already honored `next`.

**Verified:** lint clean; `npm run test` 105 pass (+15 in `__tests__/mcp-oauth.test.ts` — PKCE,
token round-trip/tamper/expiry, redirect allow-list, metadata); `npm run build` succeeds (all six
new routes registered, incl. the `.well-known/*` dot-folders). Scripted end-to-end against
`npm run dev`: discovery → DCR → `token` (valid PKCE → 200 access+refresh; bad PKCE → 400) →
MCP call with the OAuth access token → 13 tools + real data; static bearer still works; unauth →
401 with the resource_metadata `WWW-Authenticate`.

**Owner-gated:** add `MCP_OAUTH_SECRET` to Vercel (copy from `.env.local`) and redeploy; then add
`https://<domain>/api/mcp/mcp` on claude.ai as a custom connector → approve via Google login →
run reads + a `create_task → confirm` round-trip. (The browser `/authorize` login-gate is the only
piece not scriptable locally.)

---

## Implementation log — Milestone 2 (2026-07-05): the vault viewer

Read-only `/brain` renders the 2ndBrain vault from its private GitHub repo
(`Luccama700/2ndBrain`, confirmed live before starting — the kickoff precondition).
Additive only; no schema changes.

**Layout:** `app/lib/brain/parse.ts` (pure: frontmatter, wikilink rewrite/extract,
resolver, backlinks, callout markers) → `app/lib/brain/vault.ts` (server-only GitHub
fetch + `getVaultCorpus()`), rendered by `app/brain/page.tsx` (Home + folder listing),
`app/brain/note/[...path]/page.tsx` (note + backlinks), via
`app/brain/_components/note-view.tsx`. New deps: `react-markdown@10` + `remark-gfm@4`
(RSC-safe, escapes raw HTML — no sanitizer needed, zero client JS on /brain).

**Design decisions (inside the fence):**
- Tree fetched with `next: { revalidate: 180, tags: ["vault"] }`; file contents fetched
  by immutable blob sha with `force-cache` (content-addressed — unchanged notes never
  refetch; edits self-invalidate via new sha). Refresh button = server action calling
  `updateTag("vault")` (Next 16: one-arg `revalidateTag` is deprecated, two-arg is
  stale-while-revalidate — wrong for a refresh button).
- Wikilinks rewritten to standard links by a fence/inline-code-aware pure pass before
  react-markdown; unresolved links render as muted text. Resolution is case-insensitive
  basename with folder-priority tiebreak (root → People → … → Archive).
- Callouts detected via the hast node in a custom blockquote component; marker line
  stripped from the rendered body.
- `/brain` is gated to `MINDBOARD_OWNER_USER_ID` when set (the vault has no RLS behind
  it and app login is open to any Google account); unset (local dev) allows any
  signed-in user.
- Env: `VAULT_GITHUB_TOKEN` (required), `VAULT_GITHUB_REPO` / `VAULT_GITHUB_BRANCH`
  (default `Luccama700/2ndBrain` / `main`). Server-side only, never logged.

**Verified:** lint clean; 139 tests pass (+28 in `__tests__/brain-parse.test.ts`, +6
component tests in `__tests__/brain-note-view.test.tsx` — the latter caught a real bug:
callout marker stripping keyed on tag type, which custom components break); build green
(both /brain routes registered). Live integration run against the real repo (temp test,
not committed): corpus builds, `.obsidian`/`.canvas`/`.gitkeep` excluded, Home→CLAUDE
and Home→Journal links resolve, backlinks land. Dev-server smoke: unauthenticated
/brain and note URLs stream the skeleton + login redirect with **no vault content in
the response body** (checked).

**Owner-gated:** create a fine-grained PAT (Contents read-only, only `2ndBrain`) →
add `VAULT_GITHUB_TOKEN` to Vercel (+ `.env.local`); then phone-verify the kickoff
done-criteria (Home → wikilinks → backlinks → refresh after a vault commit).

**Scope note:** the user asked to "carry on with each milestone until all done";
Milestone 3 follows in this session. Milestone 4 stays unstarted — its fence says
"only if Lucca asks", and a blanket carry-on doesn't open it.

---

## Implementation log — Milestone 3 (2026-07-05): the brain graph

`/brain/graph` renders the vault as a force-directed graph — notes as nodes, wikilinks
as edges — reusing Milestone 2's cached corpus (`getVaultCorpus()` → pure
`buildGraphData` in `app/lib/brain/graph.ts`; nothing parsed twice, no extra endpoint:
the server component is the "small server endpoint").

**Design decisions (inside the fence):**
- Rendering library: `react-force-graph-2d@1.29` (canvas; built-in d3-zoom pinch/pan
  and drag-vs-tap disambiguation on touch — the mobile feel is the point of the
  milestone, and hand-rolling that input handling is the risky part, not the physics).
  Loaded client-side only via `next/dynamic` `ssr: false` inside a client wrapper;
  next/dynamic doesn't forward refs, so the instance is exposed via a `graphRef` prop
  (used for one-time `zoomToFit` on engine stop).
- Node colors are fixed hex matching the vault's Obsidian graph groups (People green,
  Projects orange, Areas blue, Topics purple, Journal gray, Archive dark gray; root
  notes cream) — canvas can't read theme CSS variables, and the kickoff pins these.
- Nice-to-haves inside the fence, both done: node size scales with inbound link count;
  one-tap per-folder filter chips (links pruned to surviving endpoints; graphData
  memoized + copied so the d3 simulation only restarts on filter change and never
  mutates props). Labels draw under nodes past a zoom threshold. `cooldownTicks`
  capped at 200 so the sim settles and stops burning battery.
- Tap a node → `router.push` to the Milestone 2 note viewer; generous
  `nodePointerAreaPaint` hit areas for touch.

**Verified:** lint clean; 143 tests pass (+4 in `__tests__/brain-graph.test.ts`:
node/edge construction, inbound counts, self-link + dangling-link pruning, empty
corpus); build green (`/brain/graph` registered; TS validated the force-graph props).
Dev-server smoke: unauthenticated request streams skeleton + login redirect, no vault
data in the body. Pinch/drag/tap feel and the 10x-size check are owner-verified on the
phone (kickoff done-criteria).

**Status:** Milestones 2 and 3 complete. Milestone 4 not started (fenced: only if
Lucca explicitly asks). Remaining owner steps: `VAULT_GITHUB_TOKEN` in Vercel
(fine-grained PAT, Contents read-only, only `2ndBrain`), then phone verification.

---

## Implementation log — per-user vault settings (2026-07-05)

Lucca asked (explicitly opening the Milestone 2 fence) for the vault connection to be
**per user**: each signed-in user pastes their own GitHub token + repo into the app
instead of a deployment-wide `VAULT_GITHUB_TOKEN` env var. The env var was never set
in Vercel, so nothing shipped broke.

**What changed:**
- Migration `0017_vault_settings.sql` (also applied to the live DB via Supabase MCP):
  `vault_settings` (user_id PK → auth.users, `github_token`, `repo`, `branch`,
  timestamps), four `_own` RLS policies — the `google_tokens` pattern, which is the
  right model for a secret that must be readable during server render (the inventory
  image-gen keys are localStorage-only and were deliberately not copied).
- `app/lib/brain/vault.ts`: `getVaultSettings(userId)` (no token column selected — the
  token is only read inside the corpus builder and never reaches the client or logs);
  `getVaultCorpus(userId)` keyed per user; per-user cache tag `vault:{userId}`;
  `VaultNotConfiguredError` distinguishes "not connected" from "connection broken".
  All env handling deleted.
- `app/actions/brain.ts`: `saveVaultSettings` (pure validation in
  `app/lib/brain/settings.ts`, unit-tested; verifies the token against
  `GET /repos/{repo}` before saving; blank token on update keeps the stored one),
  `disconnectVault`, and per-user `refreshVault`.
- `app/brain/_components/vault-settings-form.tsx`: masked token input with show/hide
  (KeyInput pattern from settings-panel), repo/branch fields, connect/save +
  disconnect, inline errors.
- `/brain` renders the connect form when unconfigured (and alongside the error message
  when the connection breaks — bad-token recovery); healthy state gets a collapsed
  "vault settings" details section. Note/graph pages redirect to `/brain` when
  unconfigured. The `isVaultOwner` gate and `app/lib/brain/access.ts` are deleted —
  your own token *is* the access control now; `MINDBOARD_OWNER_USER_ID` remains
  MCP-only.

**Verified:** lint clean; 148 tests pass (+5 in `__tests__/brain-settings.test.ts`);
build green; `vault_settings` + all four RLS policies confirmed live via SQL;
dev-server smoke on a *fresh* server (an earlier stale one was caught serving old
code): unauthenticated /brain, /brain/graph, /brain/note/* stream skeleton + login
redirect with zero token strings in the body.

**Owner steps:** none in Vercel anymore. On the deployed app: open /brain → paste the
fine-grained PAT (Contents read-only, only the vault repo) + `Luccama700/2ndBrain` →
connect. Phone-verify the Milestone 2/3 done-criteria from there.

---

## Implementation log — Redesign M0 (2026-07-05): SIGNAL foundations

Kickoff of the owner-commissioned full redesign ("THE STREAM" / Terminal Calm v2
"SIGNAL"). The complete design spec, clutter diagnosis, binding decisions, and
milestone table now live in `docs/REDESIGN.md` — that file is the redesign's
durable record; this log tracks per-milestone shipping notes.

**Shipped (skin/foundation only — zero structural or behavioral change):**
- Token system v2 in `app/globals.css` `@theme`: the six-role type scale
  (`text-display/title/body/action/meta/label` with baked line-height/tracking/
  weight), SIGNAL color tokens (`surface-0/1`, `hairline`, `accent-dim`,
  `accent-wash` — derived via `color-mix` so per-theme palette overrides
  propagate automatically — and per-theme `positive`), motion tokens
  (`--ease-signal`, 120/200/280ms durations), and a global
  `prefers-reduced-motion` clamp.
- `positive` added to the palette model (`themes.ts`: type, keys, labels,
  groups, VAR_MAP, all six theme palettes) so the palette editor can customize
  it like every other slot.
- **Theme cookie SSR** — `storeTheme` mirrors the theme into a `theme` cookie;
  the root layout is async, reads it, and renders the `theme-*` class on
  `<html>` server-side; `generateViewport` emits the per-theme `theme-color`.
  Kills the light-theme FOUC and the wrong-color iOS status bar.
  `readStoredTheme` falls back to the server-rendered class if localStorage is
  empty. Verified by curl: no cookie → no class + `#0d0d0d`; `theme=cream` →
  `theme-cream` + `#f5f0e8` in the initial HTML.
- `app/_components/ui.tsx` — the app's ONE button recipe (outline/accent/quiet/
  danger variants, 44px min, text-action) and ONE input recipe + `SectionRuler`.
  Adopted surface-by-surface as each milestone rebuilds its screens (documented
  in REDESIGN.md §13) rather than as a big-bang restyle.

**Verified:** lint clean; 148 tests pass; build green; cookie-SSR smoke test
above. No route changes, no data changes.

---

## Implementation log — Redesign M1 (2026-07-06): Dock + information architecture

**Shipped:**
- **The Dock** (`app/_components/dock.tsx`, mounted app-wide from the root layout
  via the server shell `dock-mount.tsx`): one fixed bottom island, nav rail on
  top (◆ now · ▦ week · ◇ plan · $ money · ▤ stock · ≡ more), capture input on
  the bottom edge with all its contract intact (sticky group/date chips —
  date now defaults to today —, notes, priority cycle, optimistic insert,
  focus retention). The rail collapses 200ms when the input focuses or the
  keyboard is up (`visualViewport`); the ≡ sheet holds tasks (with inbox
  count), brain, settings. Capture is now global: it emits over a window
  event bus (`capture-bus.ts`) and whichever task list is on screen
  subscribes for optimistic insert/replace. Deliberate change: the input no
  longer autofocuses on page load (a global dock popping the iOS keyboard on
  /finance would be wrong); it still refocuses after every submit.
- **Routes**: `/week` (the calendar promoted to a route, week view default via
  new `initialView` prop; `/` keeps its embedded month calendar until M2);
  `/tasks` (absorbs groups + inbox: filter chip-rail all/inbox/per-group,
  rewritten `TasksClient` with an `all` filter, group CRUD via the moved
  `groups-client.tsx` under a `manage groups` disclosure); `/settings`
  (appearance = the old popover's sections as `SettingsSections`; timezone +
  wake-window preferences persisted to `user_settings` via new
  `savePreferences`; the brain vault form; sign out). `/plan` placeholder
  stub so the rail is complete. `/groups`, `/groups/[id]`, `/inbox` deleted
  with permanent redirects in `next.config.ts`.
- **Wake window wired**: `scheduleSnapshot` takes `wakeStartHour/wakeEndHour`;
  the vitals free-hours math now reads the user's saved window
  (`app/lib/data/settings.ts#getUserPreferences`). Timezone is stored and
  editable; deep timezone-correct "today" math remains on the debt list.
- `getDashboardData`/`normalizeMonth` extracted to `app/lib/data/dashboard.ts`
  (shared by `/` and `/week`). Dashboard header pruned to date + title (pills,
  settings popover, sign-out all superseded by the Dock/settings page). All
  dock-overlaid pages got `pb-64` clearance.

**Verified:** lint clean; 148 tests; build green (routes: /, /week, /plan,
/tasks, /settings + existing); dev smoke: every route 200, /groups → 308
/tasks, /inbox → 308 /tasks?group=inbox. Owner-gated: on-device keyboard
choreography check on the installed PWA (the M1 gate from REDESIGN.md).

---

## Implementation log — Redesign M2 (2026-07-06): the Stream

`/` is no longer dashboards you scan; it is one ranked queue you clear.

**Shipped:**
- `app/lib/snapshots/stream.ts` — pure `streamSnapshot()`: NOW (objective
  time-facts only, uncapped: overdue tasks · events in progress/≤60min ·
  bills landing today via `ruleLandsOn` · run-outs ≤ today), NEXT (cap 5:
  due-today tasks · later-today events · tomorrow's first event · low stock),
  LATER (cap 5, by date: ≤7d tasks · next bill · run-outs · evening daily-log
  invite), LOOSE ENDS (absent when tidy: inbox count · dateless tasks >14d ·
  quiet active goals · pending copilot proposals), pulse data, next-up hint.
  Priority orders within sections and never promotes. 18 tests in
  `__tests__/stream-snapshot.test.ts` encode the REDESIGN.md §6 rule table,
  including boundary cases (60-min event lead, 7-day windows, caps/overflow,
  all-day exclusion, done-task exclusion, wake-window-gated log invite).
- `app/_components/stream-client.tsx` — cards in the strict grammar (tick ·
  glyph · one-line fact · `·`-joined meta · one 44px verb row): tasks get
  [done] + [later ▾] (tomorrow/weekend/next-week snooze = real due-date
  writes) + swipe right-to-complete / left-to-snooze with exit animation;
  bills get [log it] opening a spend sheet (account + category + prefilled
  amount → `recordBalanceChange`); stock gets [buy task] (creates a dated
  task) + inline − / ＋ steppers; the daily-log card and pulse dots open a
  mood/energy/sleep sheet writing `daily_logs` (first dormant-table
  activation). Dock captures due today appear in NEXT optimistically via the
  capture bus.
- Pulse line: date · time · signed today-delta (new `--positive` token) ·
  N-to-clear · free-hours (links /week) · check-in dots. Empty state is the
  planning invitation: `[plan tomorrow ◇] [open week ▦]` + next-up line.
- Retired from `/`: vitals strip, today list, embedded calendar, welcome tour
  (it described the old dashboard). `getOpenTasks` added to the shared
  dashboard read (the stream needs dateless tasks; the calendar read doesn't).

**Verified:** lint clean; 164 tests pass (+18 minus retired event-row tests);
build green; dev smoke 200 with no vault/task leakage pre-auth. Deviation
noted: the ≥1280px stream-beside-week split and event-card reschedule sheets
ride with later milestones (M3 gap chips, M6 polish).

---

## Implementation log — Redesign M3 (2026-07-06): scheduling depth

Tasks can now hold a time, become blocks on the week grid, and graduate into
real Google Calendar events — the checkpoint the owner explicitly opened.

**Shipped:**
- **Migration `0018_task_scheduling.sql`** (repo + live DB via Supabase MCP):
  `tasks.due_time`, `duration_min`, `gcal_event_id`, `gcal_calendar_id`. Task
  type/selects widened everywhere (`TASK_COLUMNS`); MCP read shapes untouched
  (live external contract).
- **Actions**: `createTask`/`updateTask` accept `dueTime`/`durationMin`
  (validated; clearing a date clears the time). `updateTask` mirrors schedule
  changes of a pushed task to Google via the existing `updateEvent` PATCH,
  failing soft — the local block is the source of truth. New
  `pushTaskToCalendar`: new `createEvent` in `utils/google/calendar.ts`
  (insert; `calendar.events` scope already covered it) on the group-linked
  calendar else primary, in the user's saved timezone — the first real use of
  `user_settings.timezone`.
- **Capture**: pure `extractTrailingTime` in `app/lib/capture/parse.ts`
  ("3pm" / "17:30" / "9:15am" / "at 7 pm"; bare numbers rejected as
  quantities; mid-title times ignored) with 14 table-driven tests; the Dock
  shows a dismissable `⌚ HH:MM` chip and submits title + due_time.
- **Week view**: time-blocked tasks render as hollow outlined blocks (solid =
  Google, hollow = yours, `⇅` = mirrored); dragging a task chip into the hour
  grid sets its time (drop-position math via dnd-kit's translated rect,
  15-min snap); dragging a block back to the due row clears it; a bottom
  handle drag-resizes duration; free-gap underlay (accent-wash, wake-window
  aware, ≥45min, duration labels + `plan ◇` chips) and a now-line in today's
  column. Event drag behavior byte-identical to before.
- **[schedule ▾]** on stream task cards: the next 3 free gaps today/tomorrow
  (pure `freeGaps` in `schedule.ts`, 5 tests: window clipping, short-gap
  drop, quarter-hour rounding, post-wake-end) as one-tap chips + "pick on
  week →". The task edit panel gains time input, duration select, and
  `→ calendar event` push (shows `⇅ on calendar` once pushed).
- **Stream rule**: due-today tasks with a past due_time now enter NOW (tested);
  timed tasks sort by time ahead of untimed in NEXT; metas carry `⌚ HH:MM`.
- Test infra: `server-only` now resolves to a stub via a vitest alias, so
  server modules are testable without per-test mocks.

**Verified:** lint clean; 186 tests (+22); build green; dev smoke on /, /week,
/tasks with zero console errors. Owner-gated: on-phone drag feel + a real
push→drag→Google PATCH round-trip.

---

## Implementation log — Redesign M4 (2026-07-06): the capture grammar + ProposalCard

**Shipped:**
- `parseCapture()` in `app/lib/capture/parse.ts` — the full three-mode grammar,
  pure and table-driven-tested (23 tests): bare text = task (trailing-time
  extraction folded in); `$ 12.50 groceries` = spend (amount with . or ,
  decimals, description, `suggestCategory` — containment or 4+-char word
  prefix, and it only ever *suggests*); `? …` = copilot handoff. Sigils count
  only at position zero ("pay $14 back to Dan" stays a task). Nothing else
  parses, by design.
- **ProposalCard** (`app/_components/proposal-card.tsx`) — the universal
  propose→confirm surface: dashed hairline over accent-wash ("not yet real"),
  title, preview children, accent confirm + quiet skip, pending/error states.
  Built here for capture; M5's copilot renders every AI write with the same
  component.
- **Dock `$` flow**: typing `$…` swaps the task chips for a mode hint; first
  Enter pins a ProposalCard above the input (amount, description, account
  picker defaulting to the first account, category chips with the suggestion
  preselected); second Enter — or the confirm tap — commits through the
  existing `recordBalanceChange` (newBalance = balance − amount). Zero silent
  commits; a mis-parse is corrected by tapping chips, not retyping.
- **Dock `?` flow**: Enter routes to `/plan?q=…`; the stub page now echoes the
  queued message (M5 consumes it for real).
- Capture placeholder documents the grammar (`new task…  ($ spend · ? plan)`).
  Note: the iOS-Shortcuts capture route mentioned in the old spec never
  existed (`capture_token_hash` is dormant schema) — nothing to repoint.

**Verified:** lint clean; 195 tests (+9); build green. `$14 lunch` on the
deployed PWA = type → Enter → Enter: three interactions, categorized ledger
row. Owner-gated: on-phone feel check.

---

## Implementation log — Redesign M5 (2026-07-06): the planning copilot

Phase 2, reopened by the owner and finally real: a conversational planning
copilot at /plan, on the owner's own Anthropic API key, wired into the same
propose→confirm→audit machine as everything else.

**Shipped:**
- **Key custody**: `app/lib/assistant/crypto.ts` — AES-256-GCM with the
  server-only `ASSISTANT_KEY_SECRET` (generated into `.env.local`; owner adds
  the same value in Vercel). `saveAssistantKey`/`clearAssistantKey` validate
  the `sk-ant-…` shape, encrypt, and upsert `user_settings.anthropic_api_key`
  (the dormant 0015 column, now live). The key is decrypted only inside the
  route handler; it never appears in client payloads, logs, or errors.
  /settings gains a copilot section with the masked key form.
- **Tool surface** (`app/lib/assistant/tools.ts`): the MCP catalog re-hosted
  on the caller's session (RLS scoping) — `get_snapshot` (all four vitals +
  free gaps), `list_tasks`, `list_accounts_and_categories`, `list_goals` —
  plus five propose-only writes: `propose_create_task` (with due-time),
  `propose_complete_task`, `propose_log_spend`, and the two new planning
  tools `propose_schedule_task` (date+time+duration, optional Google push)
  and `propose_upsert_goal`. Proposals reuse `recordProposal` with
  `source='assistant'` + `conversation_id` (additive param; MCP callers
  unchanged). Nothing executes in the tool loop — ever.
- **Confirm path** (`app/actions/assistant.ts`): `confirmProposal` re-uses the
  MCP executors for complete_task/log_spend, adds create_task-with-time,
  schedule_task (delegating to `updateTask` + `pushTaskToCalendar`, so Google
  mirroring rides the existing rails), and upsert_goal (goals table finally
  written). Double-confirm guard via the existing `resolveProposal` claim.
- **Route** (`app/api/assistant/route.ts`): SSE streaming; manual agentic
  loop on `@anthropic-ai/sdk` (`messages.stream` → `finalMessage`, tool
  rounds ≤8, `pause_turn`/`refusal` handled); adaptive thinking; prompt
  caching on the frozen instruction block; live context (goals + last-7
  daily_logs) as an uncached system block. Default model `claude-opus-4-8`,
  selectable (sonnet-5 / haiku-4-5) with the choice kept in localStorage and
  allowlisted server-side. Conversations/messages persist to the dormant
  0014 tables.
- **/plan UI** (`plan-client.tsx`): mono transcript (accent `›` user lines,
  dim collapsed `⛁ tool` traces, streaming `▮` cursor), inline ProposalCards
  (the same component as capture's `$` flow) with confirm/skip and
  `confirm all (n)`, read-only goals block, past-conversations list
  (`?c=` reload), key setup panel when no key — the deterministic app is
  never gated. `?` captures auto-send via `?q=`.

**Verified:** lint clean; 195 tests; build green (`/api/assistant`
registered); unauthenticated POST → 401; /plan renders the setup panel
pre-key. Owner-gated: add `ASSISTANT_KEY_SECRET` to Vercel, paste the
Anthropic key in /settings, then the end-to-end check — "plan my Saturday" →
ghost proposals → confirm → `ai_audit_log` rows with `source='assistant'`.

---

## Implementation log — Redesign M6 (2026-07-06): section de-clutter — the redesign ships complete

The last milestone. All seven milestones of "THE STREAM" (docs/REDESIGN.md)
are now live.

**Shipped:**
- **/finance** (two-step, as specced): first a pure extraction of the
  2,742-line `finance-client.tsx` into cohesive modules (`finance-shared`,
  `accounts-section`, `recurring-expenses-section`, `income-sources-section`,
  `categories-section` — code moved verbatim, type-checked as a checkpoint);
  then the re-layout: net worth as the screen's one `text-display` number +
  today delta, per-account hairline rows (history and edit demoted behind
  `history →` / `···`, never rendered by default) with `update balance`
  opening the untouched split-capable BalanceUpdatePanel inline, the cashflow
  forecast calendar SECOND (nothing to scroll past on iPhone), and one
  `configure ▸` row → new `/finance/setup` (recurring · income · categories,
  full CRUD moved verbatim). finance-client is now 409 lines.
- **/inventory**: groups stop being containers — one flat, attention-sorted
  ledger (out → soonest run-out → low → fine, via the existing pure
  projection helpers; group as a dim inline label; status tokens
  `out`/`low`/`≈ jul 12`); steppers byte-identical. The item detail inverts:
  quantity + unit first, forecast block second, icon/rename/delete last
  behind `appearance ▸`. Add-item collapses to one 44px `+ add item` row;
  group management behind `groups · N ▸`.
- **/brain → /plan bridge**: every note page gets `send to copilot ◇`, handing
  the note title + a 280-char plain-text excerpt to /plan as the opening
  message — the first knowledge→planning bridge.
- REDESIGN.md updated with the shipped status + deviations.

**Verified:** lint clean; 195 tests; build green (`/finance/setup`
registered); all nine routes 200 on dev smoke with zero console errors.

**The redesign, end to end:** home is one ranked queue you clear; the empty
state is the planning invitation; capture speaks three modes and never got
slower; scheduling is one gesture; the copilot plans through the same audited
confirm as your own `$` commands; and every screen leads with its daily verb.
Remaining owner steps: `ASSISTANT_KEY_SECRET` into Vercel, paste the Anthropic
key in /settings, and the on-phone feel pass (dock keyboard choreography,
stream swipes, week drag).
