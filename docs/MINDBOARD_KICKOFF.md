# Mindboard revival: Claude Code kickoff

How to use this file: commit it to the repo as `docs/MINDBOARD_KICKOFF.md`, open Claude Code in the repo, and start with:
"Read docs/MINDBOARD_KICKOFF.md, then enter plan mode for Milestone 0."
One milestone per session. Do not skip plan mode.

## Context

- Owner: Lucca (GitHub luccama700). Mindboard is his personal life dashboard PWA. Orient via `README.md`, `docs/second-brain-plan.md`, `AGENTS.md`, `CLAUDE.md`.
- Strategic change (2026-07-02): Mindboard has merged, conceptually, with "2ndBrain", an Obsidian vault maintained by Claude in Cowork. The vault owns identity, knowledge, goals, and narrative. Mindboard owns operations: tasks, calendar, money, inventory. Claude clients span both.
- Consequences for this repo, to be recorded by appending to `docs/second-brain-plan.md` (it is the durable record; append, never rewrite its history):
  - Phase 3 (notes, wikilinks, pgvector in Postgres): CANCELLED. The vault is the knowledge layer.
  - Phase 2 (in-app chat assistant): DEPRIORITIZED indefinitely. Claude in Cowork already is the assistant with full data access.
  - Phase 4 (morning brief): moves out of this repo. A Cowork scheduled task will consume the MCP tools.
  - Phase 5 (MCP server): PROMOTED. It is the next milestone and the repo's real mission: make Mindboard's data reachable by every Claude surface (Cowork, claude.ai web, Claude mobile apps via custom connector).

## Operating rules (non-negotiable)

1. Plan mode before touching code, every session.
2. One milestone per session, maximum. Finish, log, stop.
3. Additive changes only; existing behavior stays intact unless the milestone says otherwise.
4. Every commit gated on: `npm run lint && npm run test && npm run build`, all green.
5. Append a dated entry to the implementation log in `docs/second-brain-plan.md` at session end: what shipped, what was tried, what's next.
6. Small descriptive commits. Never force-push.
7. Blocked more than ~20 minutes on one thing: write up what was tried in the log and stop. No thrashing.
8. Do not invent scope. The "What NOT to do" list below is binding.

## Milestone 0: bring it back to life

Goal: the app runs locally and in production again.

- Owner action first: restore the paused Supabase project `mindboard` (ref kdsunzpcjfzkidejtnyp) from the Supabase dashboard.
- Verify `.env.local` per README (Supabase URL and publishable key, Google OAuth client ID and secret).
- `npm install`, then `npm run dev`. Smoke test: Google login, create a task, calendar renders, finance page loads, vitals strip shows.
- Confirm migrations 0001 through 0010 are applied; apply any that are missing.
- `npm run lint && npm run test && npm run build`.
- Check the Vercel production deployment still works end to end; redeploy if needed. Confirm the iOS PWA still opens and captures.
- Fix only what rot broke (expired tokens, dependency drift, API changes). Nothing else.

Done when: local and prod both work, tests green, log updated.

## Milestone 1: the MCP server (Phase 5, pulled forward)

Goal: expose the Phase 0 tool registry (`app/lib/agent/registry.ts`) as a remote MCP server, so external Claude clients can read Mindboard and propose writes.

Implementation guidance (verified current as of 2026-07):

- Use Vercel's `mcp-handler` package: `npm i mcp-handler @modelcontextprotocol/sdk@^1.26.0 zod@^3`. SDK must be 1.26.0 or later (earlier versions have a known security vulnerability). It drops an MCP server into an App Router route, e.g. `app/api/mcp/[transport]/route.ts`.
- Read tools first, one per existing snapshot: finance, inventory, tasks, schedule, plus list tools (tasks by group, upcoming events, recent ledger rows). Wire them to the existing read layer; no new business logic.
- Auth: single-user static bearer token from env, validated in the handler wrapper. HTTPS only. Never log the token. OAuth can come later if this ever becomes multi-user.
- Data scoping: single user or not, keep RLS honored. If the service role key is unavoidable server-side, it lives only in Vercel env vars and every query still filters by the owner's user id explicitly.
- Write tools second, and only after read tools are verified from a real client: `create_task`, `complete_task`, `log_spend`, mapped to the existing `app/actions/*`. Each write is two-step: a propose call returning a human-readable preview, then an explicit confirm call that executes. Every executed write inserts a row into a new `ai_audit_log` table (new migration, RLS on, user-scoped). This is the plan's locked write-with-confirmation decision; do not weaken it.
- Test locally with the MCP inspector, then deploy and add it on claude.ai as a custom connector (Settings, Connectors, Add custom connector; the URL must be publicly reachable).

Done when: from a fresh claude.ai chat with the connector enabled, Claude can report today's tasks and current net worth, and a create_task proposal round-trips through confirm and lands an audit row. README and plan log updated.

## After Milestone 1 (not this repo's work)

- Cowork Claude swaps raw Supabase reads for the MCP connector, sets up the scheduled morning brief, and keeps maintaining the vault.
- Lucca adds the connector on claude.ai web so his phone's Claude app can see live tasks and money.
- Only then, if wanted: runway tile, configurable wake window, a read-only vault viewer in the app.

## What NOT to do

- No Phase 2 chat UI. No notes tables or pgvector. No new features outside the two milestones. No refactors for taste. No framework upgrades unless the build is actually broken. No touching finance/inventory behavior.
