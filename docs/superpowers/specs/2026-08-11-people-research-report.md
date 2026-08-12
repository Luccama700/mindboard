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

<!-- PENDING: seams agent -->

---

## 4. Outside prior art — personal CRMs

<!-- PENDING: prior-art agent -->

---

## 5. Outside prior art — PKM workflows and the science of keeping in touch

<!-- PENDING: prior-art agent -->

---

## 6. Consolidated findings

<!-- PENDING -->
