# Mindboard kickoff 2: the brain becomes visible

How to use: commit as `docs/MINDBOARD_KICKOFF_2.md`, open Claude Code (Fable 5) in the repo, start with:
"Read docs/MINDBOARD_KICKOFF_2.md, then enter plan mode for Milestone 2."
One milestone per session. Plan mode always.

## Where things stand (2026-07-02)

Milestones 0 and 1 are DONE and verified: the app is restored and the MCP server is live; Claude in Cowork confirmed it with real tool calls (tasks_snapshot, finance_snapshot) against production. The operations assistant, the daily morning brief, and all vault/knowledge work now live in Cowork and are NOT this repo's concern. What remains for this repo is presentation: making Lucca's knowledge layer, the "2ndBrain" Obsidian vault, visible inside Mindboard, especially on his phone.

Precondition for everything below: the vault is pushed to a private GitHub repo (Lucca's action; ~10 minutes). Do not start Milestone 2 until Lucca confirms the repo exists and provides its name.

## Rules (unchanged and binding)

1. Plan mode before code, every session. One milestone per session.
2. Additive only. `npm run lint && npm run test && npm run build` green before every commit.
3. Append a dated entry to `docs/second-brain-plan.md` at session end.
4. Fable-specific: you may make design decisions INSIDE a milestone's fence (library choice, caching, rendering approach). You may not widen the fence. If you believe the fence itself is wrong, write the argument in the plan log and stop for Lucca's call.
5. Blocked more than ~20 minutes: log what was tried, stop.

## Milestone 2: the vault viewer

Goal: a read-only `/brain` section in Mindboard that renders the 2ndBrain vault from its private GitHub repo.

- Access: GitHub REST API with a fine-grained personal access token, read-only Contents permission, scoped to the single vault repo. Token lives in Vercel env vars only. Never expose it client-side; fetch server-side.
- Render markdown with: YAML frontmatter shown as a compact header (type, created, updated, status), `[[wikilinks]]` resolved to in-app links (match by filename without extension), and `> [!warning]` / callout blocks styled distinctly.
- Navigation: folder listing (People, Projects, Areas, Topics, Journal, Archive), plus a backlinks list on each note (computed from the fetched corpus).
- Start at `Home.md` as the landing note.
- Cache the repo tree and file contents server-side with a short TTL (a few minutes is fine); add a manual refresh button.
- Strictly read-only. No editing, no writing, ever, from the app. The vault has one writer (Claude in Cowork, plus Lucca in Obsidian). This is a hard rule from the merged architecture.
- Exclude `_import/` and `.obsidian/` from listing and rendering. (`_import/` is gitignored and shouldn't be in the repo anyway; treat its absence as expected, its presence as something to skip.)

Done when: on the deployed PWA, Lucca can open /brain on his phone, land on Home, tap through wikilinks across at least People/Projects/Areas/Topics, see backlinks, and pull fresh content after a vault commit. Tests for the wikilink parser and backlink computation.

## Milestone 3: the brain graph

Goal: the thing Lucca actually asked for on day one: "visualize my own brain digitally."

- A force-directed graph view at `/brain/graph`: notes as nodes, wikilinks as edges.
- Node colors by folder, matching the vault's Obsidian graph groups: People green, Projects orange, Areas blue, Topics purple, Journal gray, Archive dark gray.
- Tap a node: open that note in the Milestone 2 viewer. Pinch/drag friendly; this must feel good on a phone, that is the point of it.
- Data: a small server endpoint that returns nodes and edges parsed from the cached corpus (reuse Milestone 2's parser; do not parse twice).
- Rendering library is Fable's call (d3-force, react-force-graph, or hand-rolled canvas); optimize for a few hundred nodes, not thousands.
- Nice-to-have inside the fence: node size by inbound link count; a one-tap filter per folder. Nothing else.

Done when: the graph renders the live vault on mobile, is smooth at the vault's current size (~35 notes) and at 10x that, and tapping through to notes works.

## Milestone 4 (optional, only if Lucca asks)

Runway tile on the vitals strip (requires income modeling), configurable wake window for the free-hours math, week-ahead view. Do not start this unprompted.

## What NOT to do

- No writes to the vault from the app, no vault editing UI, no sync engines.
- No notes tables, no pgvector, no chat UI (still cancelled).
- No rebuilding of anything Cowork already does: briefs, journaling, goal tracking, interviews.
- No framework upgrades, no refactors for taste.
