# People section — research report

*Research session, 2026-08-11. Companion to `2026-08-11-people-research-brief.md` (the mission) and
`2026-08-11-people-expanded-design.md` (the design). This file is **findings only** — what is
true about the codebase and what the outside prior art actually says. Design decisions live in
the other doc.*

Every codebase claim below carries a `file:line` receipt and was read first-hand this session.
Where the shipped code contradicts an existing plan doc, that is called out explicitly — several
load-bearing assumptions in `docs/mindspace-plan.md` are **not** what shipped.

---

## 1. Mindspace — what actually shipped

Mindspace M1–M3 are live (migrations `0043_mindspace.sql`, `0044_mindspace_items.sql`,
`0045_mindspace_sessions.sql`). The brief guessed this layer was the gold mine. It is — but not
in the way the plan doc implies, and the difference decides the People design.

### 1.1 The five tables, as shipped

| Table | Migration | What it holds |
|---|---|---|
| `mindspace_topics` | `0043:9-23` | The topic taxonomy — **including `kind='person'`** |
| `mindspace_items` | `0044:10-27` | Classifier **verdict cache**: numbers + title + refs, **no text** |
| `mindspace_labels` | `0044:32-39` | item ↔ topic weights |
| `mindspace_observations` | `0044:43-50` | nightly "noticing" lines |
| `mindspace_sessions` | `0045:9-24` | **Raw user text from AI sessions** |

`mindspace_topics` (`0043:9-27`) is the important one for People:

```sql
kind text check in ('person','project','work','course','area','emergent'),
aliases text[] default '{}',
seed_ref jsonb default '{}',   -- {"vaultPath": "...", "groupId": "..."}
status text default 'active' check in ('active','muted','archived'),
```
with a unique index on `(user_id, lower(name))` (`0043:26-27`) and full own-row RLS
(`0043:29-38`).

**A person registry already exists.** `seed.ts:31-36` maps vault folders to kinds —
`FOLDER_KINDS = { People: "person", Projects: "project", Areas: "area", Topics: "area" }` — so
every `People/*.md` note is already a seed candidate for a `person`-kind topic, and
`app/actions/mindspace.ts:69-72` stores `{"vaultPath": ..., "groupId": ...}` in `seed_ref`.
That jsonb path is the join key the People feature needs; it does not have to invent one.

Two caveats on that registry, both material:

- **Person candidates default to unchecked.** `seed.ts:55`:
  `const defaultSelected = kind !== "person" || note.backlinkCount > 0;` — a person note with
  zero backlinks is listed during seeding but not pre-ticked. So the set of `person` topics is
  a *user-curated subset* of `People/`, not a mirror of it. A People page that assumes topic
  coverage will silently miss people.
- **`aliases` is never auto-populated.** `SeedCandidate` (`seed.ts:22-29`) has no alias field,
  and `seedMindspaceTopics` (`app/actions/mindspace.ts:26-80`) inserts `name, kind, seed_ref,
  color` only. Aliases arrive by hand only: the topic editor
  (`mindspace-client.tsx:78-90`) or as a side effect of merging two topics
  (`app/actions/mindspace.ts:157-203`, capped at 20). The vault has no `aliases:` frontmatter
  concept at all.

### 1.2 `mindspace_sessions` is the real asset — and it holds verbatim text

```sql
provider text check in ('claude_ai','claude_code'),
session_ref text, title text, project text,
started_at timestamptz not null, ended_at timestamptz not null,
duration_min int, word_count int, user_text text not null,
unique (user_id, provider, session_ref)
```
(`0045:9-24`, index on `(user_id, ended_at desc)`.)

Facts that matter:

- **`user_text` is the user's own words, verbatim** — `sessions.ts:63` slices at
  `USER_TEXT_CAP = 6000` chars (`sessions.ts:25`). Assistant turns are filtered out before the
  data ever leaves the machine/browser (`import.ts:137-141`, `overnight/mindspace-sync.mjs:113-115`).
- **This contradicts the plan doc.** `docs/mindspace-plan.md:202-203` claims Claude Code
  sessions are reduced to "a ≤300-token local summary", and `:163` claims long transcripts are
  "summarized to ≤500 tokens". Neither shipped. What shipped is a **hard character
  truncation of concatenated user turns**. Good for a People dossier (real text, not lossy
  summary); relevant for privacy framing (no summarization pass ever scrubbed it).
- **Retention is indefinite.** Nothing deletes from `mindspace_sessions`. Contrast with
  `mindspace_items`, which `pipeline.ts:265-272` **hard-deletes** past 45 days.
- **Timestamps are true instants, and the right ones.** `started_at`/`ended_at` are `timestamptz`
  parsed from ISO (`sessions.ts:48-49,74-75`), and the value a session contributes as its
  `occurredAt` is the session **end** (`read.ts:448`) — not ingestion time. So recency math built
  on this is robust to the overnight sync running late. This is the one signal in the stack that
  is timezone-unambiguous by construction.
- **It is content-queryable.** Plain `text` column, no FTS index, but `ILIKE`/regex works. Today
  nothing queries it for content except the in-process fast-path match.
- Sessions are split on a >1h gap (`SESSION_GAP_MS`, `import.ts:25`, `mindspace-sync.mjs:22`);
  `session_ref` is `${uuid|sessionId}:${startMs}` (`import.ts:144`, `mindspace-sync.mjs:121`).

### 1.3 `mindspace_items` cannot back a dossier

The migration says so in its own header (`0044:5-8`):

> "No trace text is persisted: classification happens in-process against gathered content, so
> Postgres holds only numbers, titles, and refs"

`persistVerdicts` (`pipeline.ts:140-160`) writes `source, source_ref, occurred_at, mass,
word_count, title` (sliced to 300 chars, `pipeline.ts:150`), `salience, valence, taxonomy_hash,
model_version, classified_at`. The `text` field on `MindspaceItem` (`types.ts:49`) is
**ephemeral in-process only**, rebuilt on every `/mindspace` load. Independent corroboration:
`share-bar.ts:51-65` reconstructs `ClassifiedItem[]` from these tables and hardcodes
`title: "", text: ""` (`share-bar.ts:54,59`) because the columns genuinely carry no content.

**Consequence:** "recent context about this person" must be re-derived from raw sources
(`mindspace_sessions.user_text`, vault bodies) at read time. It cannot come from the classifier
cache.

### 1.4 The matcher is reusable — and its false-positive profile is known

`classify.ts:35-43`:

```ts
function termPattern(term: string): RegExp {
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`,
    "iu",
  );
}
```

Lookarounds rather than `\b`, deliberately, because `\b` misbehaves around accented characters
(comment at `classify.ts:37-38`). Terms are `[name, ...aliases]` lowercased and filtered to
`MIN_TERM_LENGTH = 3` (`classify.ts:19-21,49-55`).

Scoring (`classify.ts:66-98`): structured signals score **3** (task `group_id` matches
`seedGroupId`; a frontmatter `topics:` entry exactly matches a term; a resolved `[[wikilink]]`
exactly matches `seedVaultPath`); title match scores **2**; body match scores **1**. Weights are
each topic's score over the item's total (`classify.ts:110-115`).

For a name like **"Davi"** (4 chars, clears the floor): matches standalone `davi` case-
insensitively anywhere in up to 20,000 chars of body (`MATCH_TEXT_CAP`, `read.ts:39`). Will not
match inside "davidson"; **will** match `Davi's`, `Davi,`, `Davi.`.

**False-positive risk is real and unmitigated beyond the 3-char floor**: no dictionary-word
exclusion, no capitalization requirement, no rarity weighting. Names colliding with common
words (Art, Grant, Rose, Will, May, Faith, Hope, Max, Jay) will hit in free text at the
body tier. Structured signals are immune (exact equality, not substring).

### 1.5 What is NOT there: no "talked to" vs "talked about" signal, anywhere

This was checked at every layer and the answer is unambiguous.

- The classifier tool schema (`llm.ts:35-82`) asks for exactly `labels[{topic, weight}]`,
  `salience` (0–3), `valence` (−2..2). No verbs, no addressee, no event type. The system prompt
  (`llm.ts:95-104`) asks only for topical aboutness and emotional charge.
- The fast path (`classify.ts`) is pure string matching — no sentence structure at all.
- The schema has no column that could hold such a verdict even if it were computed.
- `MindspaceSource` (`types.ts:26-36`) identifies the *stream* (`ai_chat`, `claude_code`,
  `event`…), not whether contact occurred.

So "talked to Davi about his writing today" and "thinking about whether to bring up X with Davi"
are **indistinguishable** to the current pipeline. Both score topic Davi with some weight.

**The one place genuine contact evidence already exists**: Google Calendar events, ingested at
`read.ts:473-495` as *attended* (already-ended) timed events with duration as mass. But only
`summary`/`calendarSummary` goes into the matchable text (`read.ts:490`) — **attendee lists are
never parsed**. That is an unexploited deterministic co-presence signal.

Also unexploited: **`valence` is written but never read anywhere** (grepped clean through
`mindspace-client.tsx`). Dead data today; a free tone signal.

### 1.6 Read paths and the trigger model

Three read shapes exist; **none** answers "which sessions mentioned person P":

- `gatherMindspaceItems` (`read.ts:187-499`, `cache()`-deduped per request) — the only assembler
  of full-text items across vault, tasks, `ai_messages`, `daily_logs`, `balance_changes`,
  `mindspace_sessions`, Google Calendar. **Hard-capped to a rolling 30 days**
  (`WINDOW_DAYS = 30`, `read.ts:31`; e.g. the sessions query at `read.ts:291-300` is
  `.gte("ended_at", cutoffIso)`). Re-fetches Postgres + GitHub + Google on every load.
- `getMindspaceTopics` (`read.ts:513-537`) — topics only.
- `getMindspaceShareBar` (`share-bar.ts:91-136`) — Postgres-only 3-day widget, discards text.

**Trigger:** classification is not cron. It runs via `after()` on a visit to `/mindspace`
(`app/mindspace/page.tsx:112-123`), draining at most `MAX_PASS_ITEMS = 60` (`pipeline.ts:36`) in
batches of 20 (`llm.ts:18`) against Haiku 4.5. Observations refresh at most every 20h
(`pipeline.ts:37`).

**Consequence for People:** any feature leaning on `mindspace_labels` is coupled to how often
the user opens `/mindspace`, and is bounded to a 30–45 day band. A raw-text search over
`mindspace_sessions` is coupled to neither — unbounded in time, and needs no classifier pass.

---

## 2. The vault — what a person page can render today

### 2.1 The read path and its freshness law

`app/lib/brain/vault.ts` exports, with their caching stance:

| Function | Cache | Note |
|---|---|---|
| `getVaultCorpus(userId)` | `cache()` + tagged 180s | Downloads **every** blob (batches of 25), parses, resolves wikilinks, computes backlinks. `vault.ts:208-265` |
| `listVaultNotePaths(creds, tag, {fresh=true})` | **uncached** | Tree only, no blobs. `vault.ts:275-286` |
| `readVaultNoteRaw(creds, tag, path, {fresh=true})` | **uncached** | Case-insensitive path match. `vault.ts:288-302` |
| `revalidateVaultTree(userId)` | — | Route-Handler-only (`revalidateTag`). `vault.ts:69-75` |
| `expireVaultTree(userId)` | — | Server-Action-only (`updateTag`). `vault.ts:79-85` |
| `findNote(corpus, path)` | — | Case-insensitive corpus lookup. `vault.ts:334-345` |

The invariant, verbatim from `vault.ts:267-274`:

> "These DEFAULT TO FRESH. They are how an agent checks whether its own write landed, so
> answering from a cached tree is a correctness bug, not a performance win."

and `vault.ts:62-68`: invalidation "keeps the /brain pages honest, it does NOT make a read
authoritative." `fetchBlob` (`vault.ts:188-206`) is always `force-cache` — blobs are sha-addressed
and immutable; only the tree needs invalidating.

Connection: table `vault_settings` (`0017_vault_settings.sql`) — `github_token` (fine-grained
PAT), `repo`, `branch`, full RLS. All access via the GitHub Git Data API.

### 2.2 What `parse.ts` gives, and what it does not

Gives: `parseFrontmatter` (`parse.ts:20-46`), `noteTitle`/`noteFolder` (`:48-56`), `noteHref`
(`:58-67`), `buildResolver` (`:69-98`) with
`FOLDER_PRIORITY = ["", "People", "Projects", "Areas", "Topics", "Journal", "Archive"]`
(`:10-18`), `WIKILINK_RE` (`:100`), fence- and inline-code-aware `rewriteWikilinks` /
`extractWikilinks` (`:104-153`), `computeBacklinks` (`:155-175`), `parseCalloutMarker` (`:177-187`).

`noteHref` shape: `People/Davi.md` → `/brain/note/People/Davi`.

**Does not give:** heading extraction, bullet extraction, or any date parsing from bullets.
`NoteFrontmatter` is a flat `Record<string,string>` — a hand-rolled line splitter, so a YAML
array comes back as the literal string `"[a, b]"`, not an array (`parse.ts:1,20-46`). A person
note's body is opaque markdown to the app apart from frontmatter, wikilinks, and callouts.

`buildGraphData` (`graph.ts:21-46`) is pure and whole-vault; there is no person-scoped subgraph
builder, but filtering its output needs no new vault read.

### 2.3 `/brain` UI, reusable as-is

- `app/brain/page.tsx` — `FOLDER_ORDER = ["People","Projects","Areas","Topics","Journal","Archive"]`
  (`:16-23`); People is just one generic folder bucket today. **No People-specific UI exists.**
- `app/brain/note/[...path]/page.tsx` — matches `noteHref`; also has the existing
  "send to copilot" bridge handing a 280-char excerpt to `/plan?q=…` (`copilotPrompt`, `:85-92`).
- `NoteView` (`app/brain/_components/note-view.tsx`) — `react-markdown` + `remark-gfm`, a custom
  component map (`:98-150`), Obsidian callout support (`:77-96`), frontmatter as a `<dl>` chip row
  (`:160-182`), backlinks footer (`:191-213`). **No `dangerouslySetInnerHTML` anywhere** —
  react-markdown is the sanitizer boundary. This component is directly reusable on a person page.
- **There is no search/filter anywhere in `/brain`.**

### 2.4 The actual People notes — 20 of them, and what they really look like

Read first-hand from `C:\Users\U\Documents\2ndBrain\People\`: **20 files** — 19 `type: person`,
1 `type: pet` (Taiga). Avalon, Carla, Carson, Coe, Davi, Eduarda, Emma, Fardeen, Flavio, Hailey,
Harman, Isabella, "Lucca Martins de Andrade" (the subject himself), Luciano, Luis, Mari, Maria,
Pedro, Taiga, Vini.

**Frontmatter is exactly three keys, on all 20 notes, no exceptions:**

```yaml
---
type: person      # or "pet"
created: 2026-07-01
updated: 2026-07-08
---
```

No `aliases`, no `tags`, no `birthday`, no `relationship`, no `status`. Dates are consistently
`YYYY-MM-DD`. **A parser can trust frontmatter completely.**

**The body cannot be trusted the same way.** Typical shape: `# Name` H1 → one intro paragraph
placing them relative to Lucca (often citing a source, e.g. "chat-memory export, 2026-07") → a
flat bullet list of facts → optional `## Open questions`.

- `## Open questions` appears in **17 of 20** notes (absent in Luciano, Luis, Vini).
- **No dedicated interaction-log heading exists anywhere.** Dates are inlined into bullet prose
  in at least two incompatible styles — prefix (`2026-07-27: Lucca built her a modpack…`) and
  embedded (`Fri 2026-07-17 plan: out around 10–11pm…`) — and most bullets on simple notes carry
  no date at all.
- Provenance edits are marked inline per the vault ritual:
  `(updated 2026-08-06, was: "hasn't started yet")` (Luis.md); resolved questions get
  `~~…~~ Overtaken by events: … (resolved 2026-07-20)`.
- Heading vocabulary beyond Open questions is ad hoc — `Emma.md` has 9 H2s, the self-note has 4,
  most notes have 0–1.
- **Relationship type is prose-only** ("Lucca's cousin", "ex-girlfriend", "clubbing friend").
  There is no structured facet.

**Wikilinks between people are dense and load-bearing** — `Emma.md` → `[[Luis]]`, `[[Vini]]`,
`[[Avalon]]`, `[[Fardeen]]`, `[[Harman]]`; the twins link each other and both parents.
`Home.md:18-31` has a `## People` routing section, one bullet per person with an inline
one-liner and an `(also: keyword, keyword)` tail.

**Not everyone named has a note.** `Davi.md` mentions "His mom is **Denise**" as plain text —
never wikilinked, no note of her own. This is exactly the brief's motivating example
("you owe Denise an update on his writing practice"), and it confirms that the useful unit of
"open loop" lives in note *prose*, not in the note *graph*.

### 2.5 There is no write path into `People/`

`capture_to_brain` writes **`Inbox/` only** — `captureFilePath` is
``` `Inbox/${dateKey} ${timeKey} ${safeTitle}${suffix}.md` ``` (`capture.ts:124-131`), and the
write is **create-only**: the `PUT /contents/{path}` payload never carries a `sha`, so GitHub
can only create, never overwrite (`capture.ts:160-244`), retrying with ` -N` suffixes up to
`CAPTURE_MAX_ATTEMPTS = 10`. The MCP route comments the reasoning (`route.ts:1125-1126`):

> "No propose → confirm step: this cannot touch Mindboard data at all, and the vault's
> review-and-file flow is itself the confirmation step."

The same primitive backs the `Courses/` writer (`course-ops.ts`). Those two are the entire set of
"fenced direct-write exceptions". **Nothing in Mindboard can create or edit a person note today** —
all People/ edits happen in Claude-in-conversation vault sessions and land via ordinary git commits.

Existing MCP brain tools: `list_brain_notes` (`route.ts:430-439` → `reads.ts:983-991`, returns
`{path, folder, title}[]`, fresh) and `read_brain_note` (`route.ts:441-449` → `reads.ts:993-1005`,
returns raw markdown, **unparsed**).

### 2.6 Tests that pin this behavior

`__tests__/brain-parse.test.ts` (frontmatter, href encoding, resolver tie-breaks, wikilink
rewriting incl. fence/inline-code safety, backlinks, callouts), `__tests__/brain-graph.test.ts`
(node/link construction, self-link and dangling-target exclusion), and
`__tests__/vault-tree-freshness.test.ts` — which asserts `cache: "no-store"` and
`init?.next === undefined` on the default read path, i.e. the freshness invariant is
regression-tested, not just documented.

---

## 3. Codebase conventions to build within

Full working detail is distilled into the design doc's implementation sections so a build session
never needs this file. Recorded here are the facts and their receipts.

### 3.1 Migrations

46 files, `0001_init.sql` … `0046_recurring_slot_events.sql`. **Next free number: `0047`.**

House style is identical across `0031_spend_limits.sql`, `0012_goals.sql`, `0045_mindspace_sessions.sql`,
`0004_inventory.sql`: header comment; `id uuid primary key default gen_random_uuid()`;
`user_id uuid not null references auth.users (id) on delete cascade`; a `(user_id)` or compound
`(user_id, sort desc)` index; `enable row level security`; then **exactly four policies** named
`<table>_{select,insert,update,delete}_own`.

Two facts worth knowing before writing DDL:

- **No `updated_at` triggers exist anywhere.** Grepping `CREATE (OR REPLACE )?FUNCTION|CREATE TRIGGER`
  across all 46 migrations hits only `claim_next_job`. `updated_at` columns are set by application
  code on write.
- **No explicit `GRANT` statements anywhere.** RLS plus the four policies is the entire access-control
  story.

`0004_inventory.sql` is the parent/child template (`inventory_groups` + `inventory_items`), which is
structurally what `people` + `person_interactions` needs.

### 3.2 Cached reads (`app/lib/data/*.ts`)

React `cache()`, not `unstable_cache`/`cacheTag` — those are vault-only. `createClient()` (SSR cookie
session); RLS scopes the query but `userId` is still passed **because it is the cache key**. Column
lists are module-level `const X_COLUMNS` strings mirrored byte-for-byte across the data read, the
page's own select, and `reads.ts` (`app/lib/data/inventory.ts:14`, `app/inventory/page.tsx:30`,
`app/lib/mcp/reads.ts:74` are the same string). Always `(data ?? []) as T[]`.

Reads that need "today" take a **required** `timeZone: string | null` — `app/lib/data/finance.ts:88-96`
explains why in a comment: an omitted zone silently windows off the UTC process clock, *and* because
the read is `cache()`-keyed on its arguments, the wrong window is memoised for the rest of the request.

### 3.3 Pure snapshots (`app/lib/snapshots/*.ts`)

No fetching, no React, no server imports. `today: string` is injected, never read from a live clock
(`app/lib/snapshots/tasks.ts:14-32`). Tested with factory helpers in `__tests__/vitals-snapshots.test.ts`.

`planning.ts` — the wide `get_snapshot` — is a flat object with one top-level key per domain
(`finance`, `tasks`, `schedule`, `inventory`, `signals`, `:173-208`). A `people` key slots in
identically: add input types near `PlanningGoal` (`:72-78`), add raw rows to `PlanningInput`
(`:80-114`), add the output key beside `signals` (`:204-207`), and do the rollup inside
`planningSnapshot()`'s return (`:519-559`, mirroring the inventory block at `:483-517`). The fetch
goes in `buildPlanningSnapshot` (`planning-read.ts:33-322`) — one more promise in the `Promise.all`
at `:95-184`. That assembler is shared by MCP and the in-app assistant, so one fetch serves both.

### 3.4 Propose → confirm

Proposals live in **`ai_audit_log`**; all plumbing is `app/lib/mcp/audit.ts` — `recordProposal`,
`loadProposal` (scoped `id + user_id`, `status='proposed'`), `claimProposal` (atomic
`proposed → executing`, guards double-confirm), `finalizeClaimedProposal`, `resolveProposal`.

`confirmAction` (`writes.ts:2794-2846`) loads the proposal → looks up `EXECUTORS[tool_name]` →
claims → runs → finalizes → `revalidateWeb()`. `cancelAction` (`:2848-2860`) is just
`resolveProposal(..., "rejected")`. **The in-app assistant reuses the identical executor**:
`app/actions/assistant.ts:51-109` imports `EXECUTORS` and runs the same claim → execute → finalize
against the session client. That is the load-bearing proof that one executor serves both surfaces.

Batched writes use a three-layer shape (`proposeUpdateStockFor`, `writes.ts:438-479`): validate shape
→ fetch live rows → resolve refs to ids → render receipt → `recordProposal`. A thin
`propose*(userId, raw)` wrapper supplies `createServiceClient()` for MCP; the assistant calls the
`*For` variant with its session client and `{ source: "assistant", conversationId }`.

`app/lib/mcp/inventory-ops.ts` (1093 lines) is the reference pure-ops module — and its key invariant
(`:5-9`) is that the **resolved** op union stores ids, not names, "so renames between propose and
confirm can't retarget a write."

### 3.5 MCP registration

`uid(extra)` (`route.ts:123-129`) throws unless `extra.authInfo?.extra?.userId` is a non-empty
string. `guard(run)` converts thrown errors into `{ isError: true }`; `ok`/`fail` build the response.
Reads go through `scoped(userId)` (`reads.ts:82-84`) which returns the **service client** plus
ownerId — so **every query must filter `.eq("user_id", ownerId)` explicitly**, since RLS is bypassed.

Write-tool descriptions follow a convention: what it does, that it is propose-only ("Returns a
preview + proposalId; call confirm_action to apply"), and which read tool supplies the ids.

**`app/lib/agent/registry.ts` is a static catalog only.** It is referenced by one comment
(`route.ts:97`) and by a test block that asserts only internal consistency — unique names, every
write has `confirm: true` — and **does not assert parity with the real tool surface**. Many live
tools (`update_stock`, `complete_task`) have no entry. Adding `people.*` there is documentation, not
something a build or test enforces.

### 3.6 UI

- **Dock** (`app/_components/dock.tsx`): `RAIL_TABS` (`:50-65`) is a deliberately frozen four-item
  array — `now · money · inventory · brain`, commented "Trimmed to the lived-in surfaces
  (2026-08-11)". This confirms the brief's assumption; the parallel trim session has landed. A new
  route goes in the **"more" menu array at `:497-500`**, currently `/mindspace` and `/settings`.
- **Primitives** (`app/_components/ui.tsx`, 59 lines): `buttonClass(variant)`, `Button`,
  `INPUT_CLASS`, `SectionRuler({label, count})`. Token idioms in use: `bg-page`, `text-fg`,
  `bg-card`/`hover:bg-card-hover`, `border-line`/`border-line-strong`/`border-hairline`,
  `bg-accent`/`text-accent-fg`, `text-muted`, `text-danger`, `bg-glass-well`/`bg-glass-panel`,
  `rounded-field`/`rounded-pop`/`rounded-dock`, and the custom type scale
  `text-label`/`text-action`/`text-body`/`text-title` (not raw Tailwind sizes).
- **`Sheet`** (`app/_components/stream-sheets.tsx`) is the shared modal-panel primitive with focus
  trap, Escape/Tab handling, dialog role and focus restore — import it rather than hand-rolling.
- **`ProposalCard`** (`app/_components/proposal-card.tsx`, 51 lines) takes
  `{ title, children, confirmLabel, onConfirm, onSkip, pending, error }`; the caller supplies preview
  content as children.
- **Server → client composition**: `app/finance/page.tsx:95-104,273-288` is the correct reference —
  resolve `timeZone`, derive `today`, pass **only `today`** across the boundary.
  **`app/inventory/page.tsx` must not be copied for this**: it is one of the four known
  `todayISO(null)` debts recorded in the project CLAUDE.md.
- **Onboarding checklist**: `tours.ts` — add the key to `TOUR_KEYS` (`:12-22`), the
  `["/people","people"]` pair to `ROUTE_TOURS` (`:48-56`), a `people: TourStep[]` entry to `TOURS`
  (shape per `stock:` at `:237-263`), and stamp `data-tour` anchors on chrome, never on data rows.
  `whats-new.ts` — prepend a `NewsEntry {id, date, title, items[]}`.

### 3.7 Timezone law

```ts
export function todayISO(timeZone: string | null)            // REQUIRED arg, no default
export function safeTimeZone(tz: string | null | undefined): string | null
export async function todayKey(supabase, userId): Promise<string>   // app/lib/mcp/config.ts:56-67
```

Two blessed resolvers only. ESLint backstop at `eslint.config.mjs:32-51` (two `no-restricted-syntax`
selectors) scoped by the globs at `:58-65` — which automatically cover a `/people` `page.tsx`,
`app/lib/mcp/people-ops.ts`, `app/lib/snapshots/people.ts` and `app/actions/people.ts`. It is a
tripwire on two idioms, not coverage: it cannot follow dataflow through a variable.

---

## 4. Outside prior art — personal CRMs

**Evidence caveat up front.** Public discourse on this category is thinner than the product
landscape suggests, and much of the "review" content is written by competing vendors (Dex's blog
reviewing Monica and Covve is the worst offender). The genuinely useful user voices are in five
Hacker News threads on Monica (2017–2023) plus a handful of founder posts. Vendor-authored sources
are flagged inline below.

### 4.1 What separates "informative" from "naggy or creepy"

The objection and the rebuttal are both worth reading, because the split is diagnostic: **objectors
imagine being the *subject* of someone else's CRM; defenders are people with real memory limits
using it on their own behalf.**

From the [2023 Monica thread](https://news.ycombinator.com/item?id=33591970):

> "I'd honestly rather someone forget my name than appear to remember it because they looked it up
> in some 'relationship manager'... I don't want the fake memory." — *circular_lights*

> "If you actually cared for someone, wouldn't you take the effort to remember everything about
> them, rather than saving it in a social relationship database?" — *vonseel*

Against, same thread:

> "Not everyone has a good memory. Having a terrible memory isn't a choice someone makes." — *sneak*

> "My sister is autistic and was excited when I sent this to her. She struggles with these types of
> things." — *smt88*

The vocabulary alone triggers the reaction before any feature is discussed — from the
[2017 Show HN](https://news.ycombinator.com/item?id=14497295):

> "My first reaction to the 'CRM to manage friends...' was, what? Why do I need a business tool for
> my personal life." — *pedalpete*

And it demonstrably *can* land as pure positive ([2018](https://news.ycombinator.com/item?id=18318547)):

> "Been running it for 2+ years now... no problems whatsoever. I update when the mood strikes...
> this little piece of software made all the difference re keeping up with people." — *tomgs*

**The mechanic that separates helpful from gross is not the reminder — it is whether the reminder
carries context.** The failure mode has a name in
[one practitioner writeup](https://www.bemorerelatable.com/blog/personal-crm-follow-up-reminders-that-work):
the **"guilt aquarium"** — accumulated snoozed contact tasks that generate shame rather than action.

> "*Follow up with Jamie.* No context. No reason. No clue what Jamie cares about."
> … "'Follow up with Dana' creates work. 'Ask how the portfolio process is going' creates momentum."

[Danielle Morrill](https://ellemorrill.substack.com/p/prototyping-a-personal-crm-lessons-learned-so-far),
who built and then killed her own prototype, arrives at the same place — the tool must *be* the
memory, not remind you to go find one.

### 4.2 Why people abandon them

**No public decay-curve data exists for this category.** What exists is company-level evidence
telling the same story: the standalone personal-CRM business does not retain, and survivors flee
toward domains where "pipeline" framing is acceptable. Per Dex's own graveyard post
([vendor-authored, facts checkable](https://getdex.com/blog/personal-crm-in-2020-20-startups-apps-and-failed-attempts/)):
**Garden** abandoned (last update mid-2020); **FollowUp** pivoted to email reminders; **Nouri**
pivoted to event ticketing; **UpHabit** repositioned in 2022 to "Relationship Selling" and
"Salesforce Hygiene" — i.e. became a sales tool; **Clay** rebranded to **Mesh** in 2024.

At the individual level the cause is stated directly and repeatedly — data-entry burden:

> "the time-to-value is too much overhead having to capture all the data" — *vishyav665*, [HN](https://news.ycombinator.com/item?id=33591970)

> "it seems incredibly arduous to keep it updated. Everytime I do something, call someone, have a
> conversation, learn something new, have lunch, etc — it all has to be tracked." — *mase*, [HN](https://news.ycombinator.com/item?id=14497295)

> "I just couldn't get all of the data into the app... I just couldn't get regular value out"
> — *louisswiss*, [Launch HN: Dex](https://news.ycombinator.com/item?id=20699923)

Morrill on her own tool: "the data entry of my own prototype started to kick my ass," and on
sabbatical she "stopped using it for 2.5 weeks." **Note where abandoners land: not nowhere — a
spreadsheet.** Morrill fell back to Excel; HN's *dsalzman* describes the identical move to "a custom
excel sheet I update each weekend." The Notion/Airtable personal-CRM template genre exists for this
reason.

Two further triggers that killed adoption before value: import failure ("Monica had issues importing
my contacts. Too many it says... It always stopped me from exploring it further." — *photoGrant*)
and onboarding friction ("A 13 question survey AND a 15 minute call to review the app before I can
sign up?" — *mead5432*, [HN](https://news.ycombinator.com/item?id=25270001)).

### 4.3 Auto-capture quality — and the gap nobody has closed

**No product found makes a clean distinction between "informed about" someone and "actually in
touch with" them.** This is a real gap, verified by digging into the one company that comes closest.

The false-signal problem is exactly as the brief predicted. A detailed
[Clay review](https://muncly.com/clay-earth-review-is-this-an-end-game-personal-crm/):

> "Clay monitors your calendar and automatically creates contact entries for people you have
> meetings with"

— with no visible discrimination between a real 1:1, a group meeting where the contact is
incidental, or a declined invite. The same complaint at Dex's launch:

> "My biggest problem is that it doesn't have an awareness of when I contact people"
> — *philip1209*, [Launch HN](https://news.ycombinator.com/item?id=20699923)

On provenance, **Clay ships the one named recency concept in the category — "Network Strength"
(high/medium/low) — and its own help documentation never explains the methodology.**
[Clay/Mesh's help article](https://library.me.sh/hc/en-us/articles/21789388483099-Network-Strength-for-Teams-and-Individuals)
says only that it "leverages all of your moments from all of your accounts to understand whether
you're losing touch with someone" and is "entirely personalized to you" — which signals are counted,
how weighted, why a score landed where it did: unstated. A black box shipped as a headline feature.

The instructive detail: Clay's per-contact **Feed** *is* source-tagged (email, WhatsApp, calendar,
call) — so the raw data is legible, and the provenance disappears **only at the moment it is
compressed into one score**. That precise layering — legible raw feed, illegible summary — is the
avoidable mistake.

Covve's "news" feature is the purest *informed-about* signal in the category (articles written about
your contacts), and notably it is never presented as contact — but that is an easy call, since news
clippings obviously aren't conversations. Nobody has done the hard version.

### 4.4 The cadence model

Every product that survived long enough to document itself sets cadence **per contact**, not globally:

- **Garden** (defunct): "weekly, monthly, quarterly, or every six months, etc." per contact
  ([Product Hunt](https://www.producthunt.com/products/garden)).
- **Yujo**, per [a user's account](https://rebooting.substack.com/p/people-let-me-tell-you-bout-my-best):
  daily through every-two-months, per connection — and critically framed as **"memories" rather than
  tasks**: *"it's a reminder that this is more than just doing something actionable."* That user's own
  resolution of the guilt problem: *"Maybe you shouldn't need an app just to remember to say hello,
  but [the guilt] gets whisked away pretty quickly when you have your monthly FaceTime session."*
- Networking-oriented advice converges on **three or four tiers** instead of per-contact sliders —
  inner circle (~15–30, monthly), core sphere (60–90 days), loose ties (twice a year) — justified as:
  *"A system that admits the difference between relationships is kinder than a system that pretends
  you can deeply maintain 1,200 people."*

**No hard evidence exists on which model survives contact with reality** — nobody publishes retention
cut this way. Circumstantial reasoning favours tiers-or-silence with per-person override: setting a
frequency for every contact at onboarding is itself the data-entry trap of §4.2. Flag as inference.

**The single best-supported design claim in this whole research set** is the same source's distinction
between calendar-driven ("every 30 days, regardless") and moment-driven (job change, anniversary, a
referral sent) reminders:

> "Moment-based reminders feel less like outreach and more like noticing."

### 4.5 Privacy — the anxiety is about custody, not note-taking

The one "ethics" piece found ([Evernote](https://evernote.com/learn/the-ethics-of-keeping-notes-about-people))
is generic marketing content, not a design convention — its "would this be acceptable if disclosed"
heuristic is reasonable but nobody demonstrably built to it.

What *is* real, and appears unprompted and repeatedly in the HN threads, is anxiety about blast
radius — precisely because Monica's early pitch was **hosted and cloud-synced**:

> "Offering this as a hosted instance is tantamount to conspiracy to enable identity theft, and
> worse." — *angry_octet*

> "Stalker exes, online scammers, insurance companies... data brokers working for PIs etc."
> — *Throwaway1771*

> "if the data ever gets leaked / hacked that I've just 1000% fucked everyone I've spoken to"
> — *simonebrunozzi*, [HN](https://news.ycombinator.com/item?id=25270001)

> "I'd be much more excited about this product if it used zero-knowledge encryption for my data"
> — *caust1c*, [Launch HN: Dex](https://news.ycombinator.com/item?id=20699923)

**Nobody in this material objects to *having* notes about people.** The objection is to
centralized, hosted, third-party-stored notes about people — a meaningfully different risk, and one
Mindboard's architecture (own Supabase project, RLS per user, no relationship-data broker, vault in
the user's own GitHub repo) is structurally better positioned on than any product reviewed.

### 4.6 The dossier view

Weakest-evidenced section — no source was found discussing which profile sections users value versus
ignore. What exists is card anatomy:

- **Clay/Mesh**: Notes (primary), hashtag Tags, "Connections" (mutuals), "Sources" (channels),
  a chronological source-tagged Feed, and the black-box Network Strength in the top-right.
- **Yujo**: photo, name, phone, birthday, relationship-type label, first-meeting date, free-text
  context ("work has been frustrating them lately," "just got a new puppy").
- **Monica**: a much longer manual field set — addresses, important dates, family relationships,
  work history, food preferences, pet names, plus a journal linkable to contacts.

Transferable by analogy only: **field bloat is a documented failure mode in enterprise CRM** —
Salesforce ships 47 default Contact fields, HubSpot 94, and
[fewer than 20% of implementations hide the unused ones](https://www.everpeakpartners.com/blog-post/getting-your-crm-fields-right---and-why).
No personal-CRM-specific version of that statistic exists, but it is consistent with §4.2.

### 4.7 Three ideas worth stealing

1. **Moment-based, context-carrying nudges — never interval-based blank tasks.** Every product here
   fails at this *because they have no source of what actually happened* — only calendar and email
   metadata, so the best they can do is "you haven't emailed Bob in 30 days." Mindboard's AI
   conversations and vault are the actual moment plus the actual context. **"You haven't talked to
   Davi in 3 weeks — you owe his mom an update on his writing practice" is not UX polish; it is the
   exact thing this category has spent a decade trying to fake.**
2. **Reminders framed as resurfaced memory, with per-person cadence as an opt-in override on a
   default of silence.** Yujo's "memory, not task" framing addresses the guilt aquarium directly, and
   it maps onto a philosophy this codebase already ships: inventory's `reorder_threshold` is opt-in
   per item, never a default nag. The abandonment evidence argues hard against asking the user to set
   a cadence for 20–100 people at onboarding.
3. **Provenance-tagged recency — show "how I know," and never collapse it into an unexplained score.**
   Clay proves the anti-pattern. Because Mindboard's data comes from AI conversations and vault notes
   rather than scraped metadata, "last talked" can be genuinely auditable — "you logged this Aug 3"
   vs. "mentioned in a Claude session Aug 7" vs. "note edited Aug 9". This is also the direct fix for
   the informed/in-touch conflation nobody else has solved.

### 4.8 Four traps to avoid

1. **Any required manual step is where users bail.** Morrill killed her own prototype over her own
   data entry; *mase*, *vishyav665* and *photoGrant* all cite entry/import friction. The moment this
   section asks the user to type "last talked to X on Y," it has become Monica.
2. **Context-free interval reminders → the guilt aquarium.** A reminder without the *why now* and
   *what happened last* is worse than no reminder; it accumulates as unactioned shame until the user
   ignores the surface entirely.
3. **Black-box relationship scores erode trust fast.** Clay's unexplained Network Strength draws
   direct suspicion from its own reviewers. If anything like a decay score is computed, show the
   inputs. This is the finance module's estimate stance (`~` prefix, muted rendering) applied to
   people instead of money.
4. **Counting calendar co-occurrence, group emails, or mentions as "contact" corrupts the one number
   this feature exists to be honest about.** Clay auto-creates contacts from any calendar meeting;
   *philip1209* flagged the same gap in Dex; Cloze reportedly auto-merges contacts and drops data.
   If "last talked to Davi" can be silently satisfied by a group thread he was cc'd on, the whole
   mechanic becomes untrustworthy the first time it is visibly wrong — and unlike a wrong finance
   estimate, **a wrong "you're overdue to talk to your friend" is resented immediately, because it is
   about a person.**

---

## 5. Outside prior art — PKM workflows and the science of keeping in touch

### 5.1 What Obsidian/Logseq practitioners actually build, and what rots

The recurring shape: a **person note** (frontmatter + context) plus an **interaction log** that is
either backlinked from daily notes or kept as dated interaction notes, then queried with Dataview
to surface who is overdue.

- [Dan B's person-note template](https://dannb.org/blog/2022/obsidian-people-note-template/) —
  frontmatter (company, location, title, email, aliases) with `date_last_spoken`/`follow_up` as
  **optional** fields only for people who need them. Meetings surface automatically via a Dataview
  query over backlinks — no manual "log an interaction" step.
- [Building a Personal CRM with Obsidian and Dataview](http://oneforthecode.com/posts/2025-01-03-building-a-personal-crm-with-obsidian-and-dataview/)
  — the most complete version found: Person template (`lastContact`, `nextFollowUp`, `strength`)
  + Interaction template, joined by **one Templater command that logs the interaction and updates
  `lastContact` in a single action**. His stated design rule is the one to internalize:
  > **"If it takes more than 30 seconds to log an interaction, you won't do it."**

  Sustained by a 5-minute weekly review, not a live alert.
- [Obsidian forum: relationship/contact management with Dataview](https://forum.obsidian.md/t/relationship-and-contact-management-with-dataview-when-was-the-last-time-i-called-thought-about-my-friend/27413)
  — per-person `Contact Frequency` (7 days / 1 month / 2 years), `last-contact` computed by
  `FLATTEN` over daily-note backlinks, overdue people flagged with an emoji.
- [Logseq CRM thread](https://discuss.logseq.com/t/advanced-queries-for-use-with-crm/14379) —
  `@person` pages with a `contact` interval property. Initially praised ("saved me a subscription
  on a CRM system"), then hit numeric-interval bugs and block-reference capture gaps needing manual
  workarounds; a returning user later asked whether the setup still worked. A soft abandonment signal.

**The maintenance lesson, stated near-verbatim across sources:** anything requiring a separate
action *outside the normal communication flow* gets skipped when busy, goes stale, and the whole
system loses trust and is quietly abandoned
([RareFriend, "Why Obsidian Fails as a Personal CRM"](https://rarefriend.com/blog/obsidian-personal-crm-why-it-fails)).
Survives: capture folded into an existing habit; periodic review over live nagging. Rots: manual
separate-app entry; elaborate optional fields (attachment style, personality type) that are never
revisited
([forum thread](https://forum.obsidian.md/t/making-and-maintaining-notes-on-friends-relationships/82918/15)).

### 5.2 Two practitioners who reject cadence tracking outright

Worth taking seriously, because both are people who *built* the thing:

- [Nat Eliason](https://www.nateliason.com/blog/personal-crm) deliberately **excludes** a
  "last contacted" field: *"I hate forced check-ins. I'd rather stay in touch with people
  organically, when there's a good reason or trigger for talking to each other."* His CRM stores
  **context** (how you met, interests, location, skills) to support organic reach-out.
- [Joe Gannon](https://joegannon.substack.com/p/exploring-the-personal-crm) stays genuinely
  ambivalent — *"to what extent should relationships be intentional?"* vs. *"why are we leaving
  maintaining relationships up to chance?"* — and admits he never got his own system running.

### 5.3 The science: what is solid

| Claim | Evidence | Strength |
|---|---|---|
| Friendships decay without active contact — the default outcome is losing touch | ["Managing Relationship Decay"](https://pmc.ncbi.nlm.nih.gov/articles/PMC4626528/) — 18-month longitudinal, 25 students, 1,291 network members, closeness rated at 0/9/18mo | **Strong.** The core premise of the feature. |
| People **underestimate** how much reaching out is appreciated | [Liu, Rim, Min & Min (2023), *JPSP* 124(4):754–771](https://www.apa.org/pubs/journals/releases/psp-pspi0000402.pdf) — 13 preregistered studies, ~6,000 participants; [independent replication](https://replications.clearerthinking.org/replication-2023jpsp124-4/) | **Strong.** The single most load-bearing finding. |
| …but the effect **shrinks when contact feels obligatory** | Same paper — mechanism is the recipient's *surprise* at being thought of | **Strong**, and it is the warning attached to the licence. |
| Quantifying an activity increases output but **decreases enjoyment** | [Etkin (2016), *JCR* 42(6):967–984](https://academic.oup.com/jcr/article-abstract/42/6/967/2358309) — six experiments; makes an activity "feel more like work" | **Strong.** Directly anti-streak. |
| Dormant ties are an asset, not a failure | [Levin, Walter & Murnighan (2011), *Organization Science* 22(4):923–939](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1625543) — reconnected dormant contacts gave advice rated **more novel and more trustworthy** than active ties | **Strong.** |
| Weak ties matter and are ~60% of daily social interaction | [Sandstrom & Dunn (2014), *PSPB*](https://journals.sagepub.com/doi/abs/10.1177/0146167214529799) | **Moderate–strong.** |
| Concrete if-then plans get acted on ~2–3× more than bare intentions | [Gollwitzer & Brandstätter (1997)](https://sparq.stanford.edu/sites/g/files/sbiybj19021/files/media/file/gollwitzer_brandstatter_1997_-_implementation_intentions_effective_goal_pursuit.pdf); bare goal intentions succeed only ~20–40% | **Strong**, well-replicated. |
| Autonomy-supportive framing beats controlling language | Deci & Ryan / SDT; [health-messaging evidence](https://econtent.hogrefe.com/doi/10.1027/2512-8442/a000159) | **Moderate–strong.** |
| Call frequency tracks emotional closeness; friendships (unlike kin) need active investment | [Roberts & Dunbar (2011), *Personal Relationships*](https://onlinelibrary.wiley.com/doi/10.1111/j.1475-6811.2010.01310.x), n=251 | **Moderate** (cross-sectional). |

Cautionary analogy, not causal evidence: Snapchat streaks — converting voluntary contact into a
visible loss-averse metric produces obligation-driven rather than relationship-driven maintenance
([peer-reviewed study on streaks/FOMO in early adolescents](https://www.sciencedirect.com/science/article/pii/S2772503023000476)).
Different population; treat as illustration of the Etkin mechanism, not proof.

### 5.4 Design rules the research supports

1. **No streaks, no counters, no persistent "days since" score** on the overview. Quantification
   makes it feel like work (Etkin 2016), it is the exact convention Eliason removed, and it mirrors
   the streak failure mode. Prefer a qualitative band ("it's been a while").
2. **Every suggestion is a specific person + a specific hook**, never "reach out to someone"
   (Gollwitzer). This is precisely what a vault full of context is for.
3. **Invitation, never indictment.** Guilt appeals tend to backfire, most of all on someone who
   already feels the guilt — which is exactly who a "you've been neglecting X" line targets.
4. **Opt-in, dismissible, one calm surfacing** — matches the app's existing inventory philosophy
   and the PKM evidence that nagging systems get abandoned.
5. **Say the Liu et al. finding out loud, and hand over a draft rather than sending anything.**
   The research licenses pushing the user past reach-out hesitation *and* warns that making the
   contact feel scripted blunts the very effect that makes it work.
6. **Dormant and weak ties are legitimate candidates**, not lesser ones (Levin 2011;
   Sandstrom & Dunn 2014).
7. **Do not hardcode a product-imposed "every N days" per tier.** See 5.5.
8. **Optimize for one meaningful touch, not touch volume.**

### 5.5 Claims that did NOT survive — do not design around them

- **Any specific "contact every N days" number.** Not supported. The paper that stress-tested the
  numerics behind Dunbar's tiers —
  [Lindenfors, Wartel & Lind (2021), *Biology Letters*](https://royalsocietypublishing.org/doi/10.1098/rsbl.2021.0158)
  — found confidence intervals of **4–520** and **2–336**, concluding *"specifying any one number
  is futile."*
- **Dunbar's 5/15/50/150 as hard caps or a rigid tier UI.** The layered *pattern* has real support
  in call-frequency data ([Mac Carron, Kaski & Dunbar 2016](https://arxiv.org/abs/1604.02400)) but
  is noisy in the middle layers. Loose inspiration only.
- **"It takes 50/90/200 hours to become a friend" (Hall 2018) as a maintenance cadence.** Real
  finding, but it measures friendship *formation from near-zero*, not the contact needed to avoid
  losing an existing friendship. Reusing it would misapply the study.
- **That reminders themselves make relationships more meaningful.** No study establishes this. What
  is established is that *reaching out, once done*, is appreciated more than expected. Whether an
  app nudge corrupts that sincerity is genuinely unresolved — practitioners argue both sides.
- **Precise optimal notification timing.** Strongest alert-fatigue evidence is clinical/nursing;
  different population. "One calm dismissible surfacing" is a reasonable inference, not a tested result.

> **Note on the tension with `checkin_days`.** Rule 7 forbids the *product* prescribing a cadence
> per tier. It does not forbid the *user* declaring one for a specific person — that is an
> autonomy-supportive choice, and it is what the approved opt-in `checkin_days` already is. The
> design must not ship default cadences by relationship type.

---

## 6. Consolidated findings

### 6.1 The convergence: two independent research tracks landed on the same distinction

The codebase track found that **nothing in Mindboard can distinguish "talked to" from "talked
about"** (§1.5) — the classifier asks only for topical aboutness and emotional charge, and no column
exists to hold such a verdict.

The prior-art track found that **no product in the category has solved this either** (§4.3), that
the products which fake it with calendar metadata get visibly wrong answers, and that this is the
single fastest way to destroy trust in the feature (§4.8 trap 4).

That agreement is the design's centre of gravity. Three distinct signals exist in Mindboard's data,
they mean different things, and collapsing them is the documented failure mode:

| Signal | Meaning | Source | Precision |
|---|---|---|---|
| **talked** | you were actually in contact | explicit interaction rows only | exact, human-attested |
| **noted** | you revised what you know about them | vault `updated` frontmatter (`type`/`created`/`updated`, 20/20 notes) | exact but means *informed*, not contact |
| **on my mind** | they occupied your attention | mindspace mentions + topic share | fuzzy, false-positive-prone (§1.4) |

### 6.2 What is free, what is cheap, and what is genuinely new work

**Free — already shipped, just needs reading:**
- A **person registry**: `mindspace_topics` with `kind='person'`, `aliases[]`, and
  `seed_ref->>'vaultPath'` joining to `People/*.md` (`0043:9-27`, `seed.ts:31-36`).
- **`NoteView`** renders a person note with wikilinks, callouts, frontmatter chips and a backlinks
  footer, with react-markdown as the sanitizer boundary.
- **Backlinks** are already computed by `getVaultCorpus`/`computeBacklinks`.
- **`noteHref`** deep-links (`People/Davi.md` → `/brain/note/People/Davi`).
- The **matcher** — `termPattern` (`classify.ts:35-43`) is a tested, accent-safe, boundary-anchored
  regex builder that can be imported as-is.

**Cheap — a new read over existing rows, no new infrastructure:**
- `mindspace_sessions.user_text` is **verbatim user words** (6,000 chars/session), **retained
  indefinitely**, timestamped by true session **end** (`read.ts:448`), and content-queryable. It is
  not subject to the 30-day gather window or the 45-day items purge. A person-mentions read hits
  this table directly and is bounded only by how much has been ingested.

**Genuinely new work, in ascending cost:**
1. A `people` + `person_interactions` pair with RLS (**migration 0047**, not 0036 — see §6.3).
2. Google Calendar **attendees** — `CalendarEvent` (`utils/google/calendar.ts:8-21`) does not carry
   them and the mapper drops them; the existing `calendar.readonly` scope already returns them, so
   this is a type + mapper change, no OAuth change. This is the only *deterministic* co-presence
   signal available.
3. A "talked to vs. talked about" **inference axis** — a new field on the Haiku tool schema
   (`llm.ts:35-82`) plus a column. Real but modest incremental work on the M2 pipeline; the design
   should treat it as optional/later, not foundational.
4. A **fenced write path into `People/`** — does not exist. `capture_to_brain` writes `Inbox/` only,
   create-only, never overwriting (`capture.ts:124-131,160-244`). Editing a person note from
   Mindboard is new surface, not reuse.

### 6.3 Contradictions and corrections found

Three claims that a build session would otherwise inherit as true:

1. **`docs/mindspace-plan.md` overstates privacy processing.** It claims Claude Code sessions become
   "a ≤300-token local summary" (`:202-203`) and that long transcripts are "summarized to ≤500
   tokens" (`:163`). **Neither shipped.** What shipped is a 6,000-character truncation of
   concatenated user turns (`sessions.ts:63`). Good for the feature (real text), but it means no
   summarization pass ever scrubbed that content — relevant to §4.5's custody framing.
2. **The brief's "migration 0036" is stale.** The migrations directory ends at
   `0046_recurring_slot_events.sql`. The People migration is **0047**.
3. **The brief's `lastTouch = max(explicit interaction, vault 'updated')` should not drive nudges.**
   It is a reasonable *display* rule but a precision bug as a *cadence* rule: editing a note about
   Davi is being informed, not being in touch, and §4.8 trap 4 is precisely about what happens when
   a non-contact event silently satisfies "last talked." The design doc resolves this by splitting
   the rule by consumer rather than discarding it.

### 6.4 The unfair advantage, stated plainly

The category's universal killer is data-entry burden (§4.2), and its universal quality ceiling is
that products only have metadata, so they can only produce content-free nudges (§4.7 idea 1).
Mindboard has the inverse position: the vault holds real context (17 of 20 person notes carry an
`## Open questions` section — literally a list of open loops per person), and `mindspace_sessions`
holds the user's own words about those people, generated as a by-product of work he already does.

The corollary is a constraint, not just an asset: **the moment this feature asks the user to type
"last talked to X on Y," the advantage is gone.** Every design decision downstream should be tested
against that sentence.
