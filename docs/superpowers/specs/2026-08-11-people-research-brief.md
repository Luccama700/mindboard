# People section — creative + research brief

Date: 2026-08-11. Author: Fable 5 (advisor session), approved by Lucca.
You are the research/creative session for Mindboard's new **People** feature. Your job is research and design, **not implementation**.

## Mission

Design the best possible People section for Mindboard: a social layer that helps Lucca keep track of the people in his life, notice when he's losing touch, and get concrete, personal suggestions ("you haven't talked to Davi in 3 weeks — you owe Denise an update on his writing practice"). It must integrate with what already exists — the 2ndBrain vault (`People/` notes), **mindspace** (the ingested-AI-sessions layer), the dashboard stream, and the assistant/MCP tool layer — and be *as informative as possible* without becoming nagware.

## What's already decided (v1 baseline — expand on it, don't relitigate)

Lucca approved this v1 shape in conversation on 2026-08-11:

- Own `/people` page (not a subsection of `/brain`). Reachable from the dock's "more" menu; the dock rail stays `now · money · inventory · brain` (a parallel session is shipping that trim now).
- **Doctrine split**: the vault `People/*.md` note is the WHO (identity, narrative — AI chats already maintain these). Mindboard owns the WHEN (recency, cadence, interaction log). Never write transient numbers into vault notes.
- **Hybrid recency**: `lastTouch = max(latest explicit logged interaction, vault note frontmatter 'updated')`, fallback `created`, else unknown (sorted last). Derived values computed at read time, never stored (no sync drift).
- Proposed tables (migration 0036, RLS, user-scoped): `people` (name, vault_path unique per user, checkin_days nullable = opt-in cadence, archived) lazy-upserted from vault on page load; `person_interactions` (person_id, summary, occurred_at date). Vault rename = new row, accepted v1 limitation.
- Nudges are **opt-in**: only a person with `checkin_days` set and exceeded surfaces attention. Same philosophy as inventory ("have-first, attention is opt-in, running out is an exit not an alarm").
- Assistant/MCP: `list_people` read, `log_interaction` propose→confirm write, people folded into `get_snapshot` wide mode.

Your design may propose changing these if research shows something clearly better — but flag every deviation explicitly in one place.

## Research track 1 — inside the codebase (do this first)

`graphify query "<question>"` exists in this repo (graphify-out/graph.json) — orient with it before reading raw files; this applies to your subagents too.

1. **Mindspace deep-dive** (the likely gold mine): `app/mindspace/`, `app/lib/mindspace/`, the `mindspace_ingest_sessions` MCP tool, and `__tests__/mindspace*`. What exactly gets ingested from AI sessions, what structure does it have, and can *interactions with people* (or mentions of people) be derived from it — so recency and "recent context about this person" come for free instead of only from note timestamps? Answer concretely: what field/shape would a people-mentions read need, and does the current ingestion already carry it?
2. **Vault pipeline**: `app/lib/brain/vault.ts`, `parse.ts`, the `/brain` page + NoteView, `capture_to_brain`, and the vault-gardener conventions (People notes carry `type: person`, dated bullets, `## Open questions`). What can the app render per-person beyond a link — note body? backlinks? recent-bullets extraction?
3. **Existing seams to reuse**: `app/lib/data/*` cached reads, `app/lib/snapshots/*` pure rollups (people snapshot should follow this pattern, unit-tested), `EXECUTORS` in `app/lib/mcp/writes.ts` for the shared propose→confirm write path, `get_snapshot` wide mode in `app/lib/snapshots/planning.ts`, the stream (`stream-client.tsx`) if you propose a stream surface.
4. **Read `AGENTS.md` in full** before any of the above; also `docs/second-brain-plan.md` and `docs/inventory-redesign-plan.md` (the attention-model precedent).

## Research track 2 — outside prior art

Personal-CRM landscape: Monica, Dex, Clay, Garden, Obsidian relationship-management workflows, and anything credible on "personal CRM" design. The question is NOT feature lists — it's **what makes these informative rather than naggy or creepy**, what makes people abandon them (data-entry burden is the classic killer — Lucca's edge is that his AI conversations already generate the data), and which 2-3 ideas are actually worth stealing for a single-user, AI-fed tool.

## Design questions your doc must answer

1. **Interaction derivation**: best mechanism for deriving interactions/mentions from mindspace + vault, beyond frontmatter timestamps. Precision matters: a note *edited* is not a person *talked to* — how does the design keep "informed about" separate from "in touch with"?
2. **The per-person view**: what does a maximally informative person page look like, composed only from data that already exists (vault note, backlinks, mindspace mentions, interaction log, shared tasks/events if linkable)? Think dossier: who they are, state of the relationship, open loops ("Open questions" bullets are right there), last interactions, upcoming relevant dates.
3. **Suggestion engine**: how "what can I do?" produces "reach out to X, here's why + a concrete idea". How much is deterministic (recency × cadence math, surfaced open loops) vs assistant-improvised at ask-time? Lean deterministic-data + assistant-composes; no new AI infra.
4. **Overview page**: sort/group model for ~20–100 people that stays calm (Terminal Calm aesthetic, quiet/dense/utilitarian, 44px touch targets, mobile-first PWA).
5. **Data model**: does the v1 two-table model hold, or does research justify more (e.g., person aliases for mention-matching, relationship tags, important dates)? YAGNI ruthlessly — every table must earn its migration.
6. **Privacy/safety**: this is data about third parties. Any surface where that demands care (e.g., MCP exposure granularity)?

## Hard invariants (design within these; non-negotiable)

- Multi-tenant MCP: every tool threads authenticated `userId` first-param on the service client; never env-based scoping.
- Timezone law: all wall-clock math takes a resolved `today`/`timeZone` (see AGENTS.md "Timezone convention" — read it; `todayISO(timeZone)` requires its argument; no bare `new Date()` day math in lib/actions/api).
- Assistant/MCP writes are propose → confirm, never silent. RLS on every table.
- No new dependencies. No UI library. Tailwind v4 tokens (`bg-page`, `text-fg`, etc.), Geist Mono, existing glass kit.
- Vault reads that verify writes stay uncached (read AGENTS.md "Vault read-freshness invariant" before touching vault code paths).

## How to work

- You run as orchestrator. Cap total subagent spawns at **8**. Route: Sonnet-tier subagents for codebase archaeology and web research fan-out; `claudex -p "..."` (gpt-5.6-sol via the local proxy, see ~/.claude/CLAUDE.md "claudex") for ONE adversarial critique of your near-final design; keep synthesis yourself.
- Scope pin: do what this brief asks at the scope intended; flag disagreements in one sentence rather than expanding scope.
- Work only in this worktree, on branch `people-research`. Commit this brief plus your deliverables here. Never push to or merge main. Never apply migrations. Never edit files outside `docs/`.

## Deliverables (commit both to this branch)

1. `docs/superpowers/specs/2026-08-11-people-research-report.md` — findings: mindspace/vault facts (with file:line receipts), prior-art conclusions, what to steal / what to avoid.
2. `docs/superpowers/specs/2026-08-11-people-expanded-design.md` — the expanded design: options with trade-offs where genuinely open, ONE recommendation per question above, data model, page composition, suggestion-engine mechanics, phasing (what ships first). Written so a build session can implement from it without re-deriving context.

When both are committed, print a short summary ending with the literal line `RESEARCH COMPLETE` so the advisor session can pick it up.
