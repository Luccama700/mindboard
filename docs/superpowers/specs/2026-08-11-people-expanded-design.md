# People — expanded design

*Design session, 2026-08-11. Findings and receipts live in
`2026-08-11-people-research-report.md`; the mission is `2026-08-11-people-research-brief.md`.
This doc is written so a build session can implement from it without re-deriving context — the
conventions it needs are quoted inline, not cited.*

**Status: design only. Nothing implemented. No migration applied.**

---

## 1. The reframe

The category this feature belongs to has a decade-long failure record, and both failure modes have
the same root: **personal CRMs have metadata but no memory.** They know you last emailed Bob 30 days
ago; they do not know what you talked about, so the best nudge they can generate is
*"follow up with Bob"* — a content-free task that accumulates into what one practitioner calls the
**guilt aquarium**. And because filling that gap requires the user to type what happened, the tools
die of data-entry burden instead.

Mindboard is in the inverse position. The vault already holds who these people are — including a
literal per-person list of open loops, since **17 of 20 person notes carry an `## Open questions`
section that nothing in the app currently renders**. And `mindspace_sessions.user_text` already holds
Lucca's own words about them, generated as a by-product of work he does anyway.

So the reframe:

> **People is a memory surface, not a pipeline.** The vault says who they are. Mindboard says how it's
> going — and when it speaks, it brings the reason with it.

Three consequences, deliberately parallel to inventory's "the shelf":

1. **Losing touch is a fact, not a failure.** A person who has gone quiet is not a red row at the top
   of a list. They are simply a person you have not talked to in a while, stated plainly, with no
   score attached. *(Inventory: "running out is an exit, not an alarm.")*
2. **The user never types a date.** Every interaction is either logged by the assistant in the flow of
   a conversation he was already having, or promoted from a candidate with one tap. The moment this
   feature asks him to type "last talked to X on Y," its entire advantage is gone.
3. **Every claim carries its provenance.** "Last talked" is never a black-box number. It says how it
   knows — you logged it, you confirmed it from a mention, or it does not know.

---

## 2. The doctrine: three signals, never merged

This is the load-bearing decision, and it is the answer to design question 1.

Nothing in Mindboard can currently distinguish *"I talked to Davi"* from *"I talked about Davi"* —
the mindspace classifier asks the model only for topical aboutness and emotional charge
(`llm.ts:35-82`), the fast path is pure string matching (`classify.ts`), and no column exists that
could hold such a verdict. No competing product has solved it either: Clay auto-creates contact
entries from any calendar meeting with no discrimination for group invites or declines, and Dex
shipped with the same gap flagged on its launch thread.

That is not a gap to paper over with a heuristic. It is the thing the feature exists to be honest
about, and the fastest way to destroy trust in it — **a wrong "you're overdue to talk to your friend"
is resented immediately, because it is about a person, not a number.**

So Mindboard tracks three signals with three names, shows all three, and lets only one of them drive
attention:

| Signal | Means | Written by | Drives nudges? |
|---|---|---|---|
| **talked** | you were actually in contact | `person_interactions` rows only — assistant-logged or user-confirmed | **Yes, exclusively** |
| **noted** | you revised what you know about them | vault frontmatter `updated` (present on 20/20 notes) | No |
| **on your mind** | they occupied your attention | name/alias matches in `mindspace_sessions.user_text` + vault bodies | No |

**The confirm tap is the boundary.** A mention is evidence that a person was on your mind. It becomes
evidence of contact only when a human says so. That single interaction — one tap, pulled not pushed —
is what buys precision without buying data-entry burden, and it is the thing no product in the
category does.

### Why not `lastTouch = max(interaction, vault updated)`

The v1 baseline proposed a hybrid. It is a good **display** rule and an unsafe **cadence** rule:
editing a note about Davi is being *informed*, not being *in touch*, so a hybrid max() lets a
non-contact event silently satisfy "last talked" — precisely the failure documented above. The
resolution is to split it by consumer rather than discard it:

- **Cadence / attention math: `talked` only.** Precision-critical.
- **Overview display and sort: both, labelled.** Informational, so a hybrid is honest as long as each
  line says which signal it is.

This creates a cold-start problem — on day one `person_interactions` is empty, so anyone with a
cadence set would fire immediately. Solved at the point of opt-in: **setting a check-in cadence
prompts one backfill question** ("when did you last talk?" → `today · this week · this month · longer
ago · not sure`). One tap, one row, and every nudge after it is correct. "Not sure" sets no row and
suppresses nudges until there is one.

---

## 3. Design principles

Derived from the research; each traceable to a finding in the report.

1. **No streaks, no counters, no persistent "days since" number on the overview.** Quantifying an
   activity reliably increases output and *decreases* enjoyment (Etkin 2016, six experiments) — it
   makes the activity feel like work. Recency is shown as a qualitative band. The specific number
   appears only inside a suggestion, where it is a *reason*, not a score.
2. **Attention is opt-in.** A person surfaces only if the user set a `checkin_days` for them. Default
   is silence. Exactly the inventory rule (`reorder_threshold`), for exactly the same reason.
3. **Every suggestion is a specific person plus a specific hook.** Concrete if-then plans are acted on
   roughly 2–3× more than bare intentions (Gollwitzer). "Reach out to someone" is worse than nothing.
4. **Invitation, never indictment.** Guilt appeals backfire hardest on someone who already feels the
   guilt — which is exactly who "you've been neglecting Davi" targets. Copy is autonomy-supportive and
   dismissible.
5. **Hand over a draft; never send anything.** People substantially underestimate how much reaching out
   is appreciated (Liu, Rim, Min & Min 2023, 13 preregistered studies, ~6,000 participants) — which
   licenses the nudge. But the same paper shows the effect *shrinks when contact feels obligatory*,
   which forbids automating it. Mindboard drafts; Lucca sends.
6. **No product-imposed cadences.** The statistical basis for precise Dunbar-derived tiers does not
   survive reanalysis (Lindenfors et al. 2021 found CIs of 4–520 and 2–336: *"specifying any one
   number is futile"*). The user sets a cadence per person or there is none. Ship no defaults by
   relationship type.
7. **Show the inputs, not just the output.** Clay ships "Network Strength" (high/medium/low) and its
   own help docs never explain the methodology. This is the finance module's estimate stance (`~`
   prefix, muted rendering, honest denominators) applied to people instead of money.
8. **At most one suggestion at a time.** One quiet row, never a modal, never red — the inventory
   "stop tracking?" precedent exactly.

---

## 4. Deviations from the approved v1 baseline

Every departure, in one place, as the brief requires.

| # | v1 baseline | Change | Why |
|---|---|---|---|
| 1 | "migration 0036" | **0047** | Directory ends at `0046_recurring_slot_events.sql`. Purely factual. |
| 2 | `lastTouch = max(interaction, vault updated)` | Split by consumer: interactions-only for cadence, both (labelled) for display | §2. Precision requirement + the documented trust failure. |
| 3 | `people` columns as listed | **`+ aliases text[] not null default '{}'`** | Mention matching needs "Lucca" to match the note "Lucca Martins de Andrade". Rejected alternative: join `mindspace_topics.aliases` via `seed_ref->>'vaultPath'` — but person topics default *unchecked* at seeding unless the note has backlinks (`seed.ts:55`), so that join covers only a user-curated subset and would make matching silently incomplete. A column on a table already being created is cheaper than a fragile join. |
| 4 | `person_interactions(person_id, summary, occurred_at)` | **`+ source text check in ('logged','confirmed')`** | Provenance is a design principle (§3.7), not decoration — the page must be able to say *how* it knows. One column, no new table. |
| 5 | `vault_path` unique per user | Unique per user **and nullable** | A person can exist without a note. `Davi.md` names "His mom is **Denise**" in plain prose — she is the brief's own motivating example and has no note of her own. |
| 6 | (unstated) | Overview is **flat alphabetical**, not attention-sorted | Have-first, per inventory. An attention-sorted list is a problem list. |
| 7 | Nudges from `checkin_days` alone | Cadence opt-in **also triggers a one-tap backfill** | Kills the cold-start false-positive burst (§2). |

Everything else in the baseline holds: own `/people` route reachable from the dock "more" menu
(the rail is confirmed frozen at four items — `RAIL_TABS`, `dock.tsx:50-65`, commented "Trimmed to the
lived-in surfaces (2026-08-11)"); the WHO/WHEN doctrine split; derived values computed at read time
and never stored; opt-in nudges; `list_people` read plus propose→confirm `log_interaction`; people
folded into `get_snapshot` wide mode. Vault rename → new row remains an accepted v1 limitation.

---

## 5. The data model

Two tables. Every column below is used by a shipped surface in M1–M3; nothing is speculative.

**Rejected outright, on YAGNI and the field-bloat evidence** (Salesforce ships 47 default contact
fields, HubSpot 94, and fewer than 20% of implementations hide the unused ones): relationship-type
tags (the vault carries this in prose — "Lucca's cousin", "clubbing friend" — and a structured facet
would need a migration pass plus a vault convention change for no surfaced benefit), important
dates/birthdays (nothing in the vault carries them; adding the field means asking the user to type,
which is the one thing this design refuses), a separate aliases table, and a person-to-person
relationship graph (wikilinks already are one, computed free by `computeBacklinks`).

### `supabase/migrations/0047_people.sql`

House style verified against `0031_spend_limits.sql` and `0004_inventory.sql`: no `updated_at`
triggers exist anywhere in the codebase (application code sets the column), and there are no explicit
`GRANT`s — RLS plus four policies is the entire access-control story.

```sql
-- People: the relationship layer.
-- The vault's People/*.md note is the WHO (identity, narrative, maintained by AI chats).
-- Mindboard owns the WHEN: recency, cadence, and an explicit interaction log.
-- Derived values (days since contact, overdue-ness) are computed at read time, never stored.
-- RLS scoped by auth.uid().

create table public.people (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  -- Nullable: a person can exist without a vault note (e.g. someone named only in
  -- another person's prose). Unique per user when present, so the lazy upsert from
  -- the vault is idempotent.
  vault_path text,
  -- Name variants for mention matching ("Lucca" for "Lucca Martins de Andrade").
  -- Seeded from the note basename's tokens; user-editable.
  aliases text[] not null default '{}',
  -- Opt-in cadence. NULL means this person never generates attention.
  -- No defaults are ever shipped by relationship type.
  checkin_days int check (checkin_days is null or checkin_days > 0),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index people_user_vault_path_key
  on public.people (user_id, vault_path)
  where vault_path is not null;

create unique index people_user_name_key
  on public.people (user_id, lower(name));

create index people_user_active_idx
  on public.people (user_id)
  where not archived;

alter table public.people enable row level security;

create policy "people_select_own"
  on public.people for select
  using (auth.uid() = user_id);

create policy "people_insert_own"
  on public.people for insert
  with check (auth.uid() = user_id);

create policy "people_update_own"
  on public.people for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "people_delete_own"
  on public.people for delete
  using (auth.uid() = user_id);

create table public.person_interactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  person_id uuid not null references public.people (id) on delete cascade,
  -- What happened, in the user's terms. Records what the USER did or said,
  -- never an inference about the other person's state. See the privacy section.
  summary text not null,
  -- Date only: this is a day-grain fact, and storing an instant would invite
  -- UTC-slicing bugs downstream. Always written from a resolved user-zone day.
  occurred_at date not null,
  -- Provenance. 'logged' = stated outright by the user (or the assistant on their
  -- behalf); 'confirmed' = promoted from a mindspace mention by an explicit tap.
  -- The page shows this; it is not decoration.
  source text not null default 'logged'
    check (source in ('logged', 'confirmed')),
  created_at timestamptz not null default now()
);

create index person_interactions_user_person_idx
  on public.person_interactions (user_id, person_id, occurred_at desc);

alter table public.person_interactions enable row level security;

create policy "person_interactions_select_own"
  on public.person_interactions for select
  using (auth.uid() = user_id);

create policy "person_interactions_insert_own"
  on public.person_interactions for insert
  with check (auth.uid() = user_id);

create policy "person_interactions_update_own"
  on public.person_interactions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "person_interactions_delete_own"
  on public.person_interactions for delete
  using (auth.uid() = user_id);
```

### The lazy upsert

**Mechanism — do not mutate during render.** The sync runs in `after()`, exactly as the mindspace
classification pass does (`app/mindspace/page.tsx:113`), and inside it **must use
`createServiceClient()`, not the cookie client** — the reason is spelled out at
`app/lib/mindspace/pipeline.ts:232-234`:

> "Service client, not the cookie client: `after()` runs outside the request context, where
> `cookies()` throws. Every query below is explicitly userId-scoped, per the multi-tenant invariant."

So every query in the sync filters `.eq("user_id", userId)` explicitly, since the service client
bypasses RLS. The first render of `/people` shows whatever rows already exist; a brand-new vault
person appears on the next visit. That is the same "sharpens visit over visit" contract mindspace
already ships, and it is why M1 must not depend on the sync having run.

**Matching, and the collision that will otherwise bite.** For each `People/*.md` note, resolve an
existing row in this order:

1. by `vault_path` — already linked, nothing to do;
2. else by `lower(name)` — **adopt**: set `vault_path` on that existing row.

Step 2 is not optional. Without it, a person created by hand from the search field (§8, the Denise
case) whose note later appears in the vault would hit `people_user_name_key` and the insert would
throw. Adoption is also what makes the sync idempotent across renames-back-and-forth.

**Accepted limitations of this scheme**, both consequences of keying on the name and both fine at
one user's scale:

- A vault **rename produces a new row**; the old row keeps its interaction history and has to be
  archived by hand. (Carried over from the v1 baseline.)
- **Two distinct people who share a first name get conflated** by the `lower(name)` unique index and
  the adoption step. Same class of limitation as the rename case. The escape hatch already exists —
  rename one of them to something distinguishing, exactly as the vault itself would have to.

Name comes from `noteTitle(path)`. Aliases seed as the distinct tokens of the name with length ≥ 3
(so "Lucca Martins de Andrade" seeds `{lucca, martins, andrade}`) — the same `MIN_TERM_LENGTH = 3`
floor the mindspace matcher uses, for the same reason. Never delete rows for notes that disappeared;
a rename produces a new row, the accepted v1 limitation.

**Filters.** Skip anything whose `frontmatter.type` is not `person` (this drops `type: pet` — Taiga)
and skip the user's own self-note. Both are one-line filters, and getting either wrong makes the very
first screen look broken.

**The no-vault case is normal, not an error.** `/people` must work when `vault_settings` has no row
at all: the roster then shows only hand-created people, every person renders without a note block,
and the page shows a quiet "connect a vault to pull in your people notes" line rather than the
`VaultNotConfiguredError` banner. `getVaultCorpus` throwing must never take the page down —
`app/brain/page.tsx` already models catching `VaultConnectionError` for a friendly banner.

**Cost note.** The roster's secondary lines and the open-loops block both need note *bodies*, so
`/people` pays for `getVaultCorpus` (every blob, batched 25 at a time). It is `cache()`-deduped per
request and `/brain` already pays it, so this is acceptable — but it means `/people` is a
corpus-weight page, not a Postgres-only one, and the roster should render from `people` rows first
with vault-derived text filled in around it.

---

## 6. The per-person view (design question 2)

The dossier. Composed **entirely from data that already exists**. Ordering is deliberate: the research
is unanimous that context beats fields, so context is on top and the field-like material is at the
bottom.

```
┌──────────────────────────────────────────────┐
│  davi                                        │  ← name, lowercase per house voice
│  cousin, 14, writes short stories            │  ← first sentence of the note's intro
│  ·  it's been a while                        │  ← qualitative band, never a number
├──────────────────────────────────────────────┤
│  TALKED         aug 3 · "coffee, he's        │  ← provenance-tagged, three lines,
│                 writing again"  (you logged) │     the anti-Clay panel
│  NOTED          aug 9 · note updated         │
│  ON YOUR MIND   4 times in the last 30 days ›│  ← tappable
├──────────────────────────────────────────────┤
│  OPEN LOOPS                                  │  ← from the note's ## Open questions
│  · does he still want the writing feedback?  │
│  · denise asked for an update — send one     │
├──────────────────────────────────────────────┤
│  RECENT                                    ⊕ │  ← interaction log, newest first
│  aug 3   coffee, he's writing again          │
│  jul 21  called, mostly about school         │
├──────────────────────────────────────────────┤
│  ON YOUR MIND                                │  ← mention snippets, deep-linked
│  aug 7   claude code · "…davi's story…"      │
├──────────────────────────────────────────────┤
│  THE NOTE                                    │  ← <NoteView>, full fidelity
│  …rendered markdown, wikilinks, callouts…    │
├──────────────────────────────────────────────┤
│  CONNECTED     emma · isabella · luciano     │  ← backlinks + outgoing People links
└──────────────────────────────────────────────┘
```

Every block maps to something that exists:

| Block | Source | Cost |
|---|---|---|
| Name, intro line | `noteTitle` + first sentence of the note body | free |
| Recency band | `person_interactions` + `frontmatter.updated` | free |
| **Open loops** | `## Open questions` section of the note | **needs a small section extractor** |
| Recent | `person_interactions` | free |
| On your mind | `mindspace_sessions.user_text` matches | new read (M4) |
| The note | `<NoteView>` from `app/brain/_components/note-view.tsx` | free, reused verbatim |
| Connected | `note.backlinks` + `note.outgoing`, already computed by `computeBacklinks` | free |

**The open-loops block is the highest-value, lowest-cost item in the entire design.** A per-person
list of open loops already exists, hand-written, in 17 of 20 notes, and nothing renders it. It is
also exactly the payload the suggestion engine needs. It requires one pure function:

```ts
// app/lib/brain/parse.ts — new export, unit-tested alongside the existing parse tests.
// Extracts the bullets under a named H2, stopping at the next heading.
// Skips fenced code (reuse the existing walkEligible helper) and strikethrough
// bullets, which the vault ritual uses to mark resolved questions:
//   ~~…~~ Overtaken by events: … (resolved 2026-07-20)
export function extractSectionBullets(markdown: string, heading: string): string[]
```

Two robustness notes for the implementer, both from reading the real notes: three of twenty notes
have **no** `## Open questions` section (Luciano, Luis, Vini), so the empty case is normal and must
render as nothing rather than an empty box; and headings beyond `## Open questions` are ad hoc
(`Emma.md` has nine, most notes have zero or one), so the extractor must target the one known heading
by name rather than assuming a schema.

**What is deliberately not on this page:** a contact-frequency score, a relationship-strength meter,
an editable field grid, and any "last contacted" number rendered as a headline. All three are the
documented anti-patterns.

---

## 7. The suggestion engine (design question 3)

Split cleanly: **deterministic data, assistant-composed prose.** No new AI infrastructure.

### The deterministic half — `app/lib/snapshots/people.ts`

Pure, no fetching, `today` injected — the house snapshot pattern (`app/lib/snapshots/tasks.ts:14-32`).

```ts
export type PersonAttention = {
  personId: string;
  name: string;
  vaultPath: string | null;
  daysSinceTalked: number | null;   // null = never logged
  checkinDays: number;
  overdueBy: number;                 // daysSinceTalked - checkinDays
  lastInteraction: { summary: string; occurredAt: string } | null;
  openLoops: string[];               // from extractSectionBullets
};

export type PeopleVitals = {
  total: number;
  tracked: number;                   // have a checkin_days
  attention: PersonAttention[];      // sorted by overdueBy desc
};

export function peopleSnapshot(input: {
  people: PersonRow[];
  interactions: PersonInteractionRow[];
  openLoops: Record<string, string[]>;   // vaultPath -> bullets
  today: string;
}): PeopleVitals
```

Rules, all of them boring on purpose:

- A person is eligible for attention **only** if `checkin_days is not null` and not archived.
- `daysSinceTalked` uses `person_interactions` **only**. Vault `updated` never enters this math.
- Eligible **and** `daysSinceTalked === null` → suppressed (the backfill covers this; a person with a
  cadence but no logged interaction is a setup gap, not an overdue relationship).
- Surfaced when `daysSinceTalked > checkin_days`.
- The UI takes `attention[0]` and shows **one** row. The rest of the array exists for the assistant
  and for the `/people` page's own strip, never as a notification queue.

### The assistant half

`get_snapshot` wide mode already carries per-domain sections; `people` slots in beside `signals`
(`planning.ts:204-207`), with the fetch added to the `Promise.all` in `buildPlanningSnapshot`
(`planning-read.ts:95-184`) so MCP and the in-app assistant share one read.

**Assemble it in two steps, and do not drag the corpus in.** `peopleSnapshot` takes `openLoops` as an
input, so the naive assembler would call `getVaultCorpus` — which downloads *every* blob in the vault
— on every `get_snapshot` wide call from every MCP client. That is unacceptable for a tool the
assistant hits on routine planning turns. Instead:

1. Compute `attention[]` from Postgres rows alone (`people` + `person_interactions`). This is the
   whole cadence calculation; it needs no vault data.
2. **Then** hydrate `openLoops` for only the people that survived — at most three — via
   `readVaultNoteRaw(credentials, vaultTag(userId), vaultPath)`, which is a single-note fetch and
   fresh by default (`vault.ts:288-302`).

So the vault cost is bounded by the number of people the user actually opted into tracking, not by
the size of the vault. `peopleSnapshot` stays pure and unchanged; this is purely the assembler's job.

**Scope of what leaves the app.** `get_snapshot` carries open loops **only for the people in
`attention[]`** — never for the whole roster — and carries no mindspace mention snippets at all. See
§9; the bound is the same one the two-step assembly already imposes, which is why this costs nothing
extra to honour.

The payload it carries is the whole trick. When Lucca asks *"what can I do?"*, the assistant already
holds: the name, the days, the last interaction summary, and **the open-loop bullets straight out of
the vault note**. It composes the sentence; it does not compute anything.

That is how the brief's target output gets produced:

> **"you haven't talked to Davi in 3 weeks — you owe Denise an update on his writing practice"**

The first clause is `overdueBy` arithmetic. The second clause is a bullet that was already sitting in
`People/Davi.md` under `## Open questions`. Neither half is invented, which is precisely why this is
achievable without new AI infrastructure — and precisely what every product in the category has been
faking with generic templates for a decade.

**Copy contract for whatever composes the line** (assistant system prompt, and the static UI string):
invitation not indictment; name the concrete hook or say nothing; never more than one person at a
time; always a draft to edit, never a send. State the Liu et al. finding once, in first-run copy —
"people almost always appreciate hearing from you more than you expect" — and never again, because
repeating it turns it into nagging.

---

## 8. The overview page (design question 4)

Route `/people`. Terminal Calm: quiet, dense, utilitarian, mobile-first, 44px touch targets.

### The genuinely open trade-off

**Option A — flat alphabetical roster.** Everyone, one list, a muted recency chip only on people with
a cadence set. Mirrors the shelf exactly.
**Option B — grouped by qualitative recency band** ("in touch · a while · quiet").

**Recommend A.** B is an attention-sorted list wearing a qualitative disguise: it puts the people you
have neglected at the top of the screen every time you open it, which is the guilt aquarium rendered
as page structure. A is the direct analogue of the rule that already worked for inventory — have-first,
grouped, alphabetical, attention opt-in — and it makes the page usable as a *directory*, which is what
someone with 20–100 people actually opens it for most days.

```
┌──────────────────────────────────────────────┐
│  [ search or add…                          ] │  ← filter + capture (also fixes /brain's gap)
├──────────────────────────────────────────────┤
│  ✎ worth a message                           │  ← at most ONE, dismissible
│    davi · 3 weeks · you owe denise an        │
│    update on his writing practice            │
│    [ open ]  [ not now ]                     │
├──────────────────────────────────────────────┤
│  PEOPLE                                   20 │  ← SectionRuler
│  avalon      emma's friend                   │
│  carla                                       │
│  carson      hytale, mage tower              │
│  davi        cousin · a while                │  ← band only when opted in
│  …                                           │
├──────────────────────────────────────────────┤
│  not tracking · 3                          › │  ← collapsed archive, per inventory
└──────────────────────────────────────────────┘
```

- The secondary line is the note's intro sentence, truncated — free context, zero new fields.
- The recency chip appears **only** for people with a cadence. Everyone else is just a name. This is
  what "attention is opt-in" looks like on a list.
- The search field doubles as capture: typing a name that matches nobody offers `add "denise"` — which
  creates a `people` row with `vault_path = null`. This is how the Denise case gets solved without a
  vault write.
- Archive (`stop tracking`) mirrors inventory: hidden, restorable, hard delete only inside the
  collapsed section.

---

## 9. Privacy and safety (design question 6)

An honest accounting rather than an invented permission system.

**What is genuinely new exposure.** The vault's `People/*.md` notes are *already* MCP-reachable in
full via `list_brain_notes` and `read_brain_note`. So the new third-party surface is narrower than it
first appears: (a) `person_interactions.summary` rows, (b) the aggregated dossier as a single view,
and (c) mention snippets drawn from `mindspace_sessions.user_text`.

**(c) deserves specific care.** `docs/mindspace-plan.md` claims sessions are reduced to a "≤300-token
local summary" and that long transcripts are "summarized to ≤500 tokens". **Neither shipped** — what
shipped is a 6,000-character truncation of the user's raw turns (`sessions.ts:63`). No summarization
pass has ever scrubbed that text. A People feature that surfaces snippets from it is surfacing
unedited raw writing about third parties, and should be designed knowing that.

**Proportionate mitigations, all cheap:**

1. **Tool granularity.** `list_people` returns metadata only — name, vault path, recency band, cadence,
   counts. Not note bodies, not interaction summaries, not mention snippets. A separate `get_person`
   returns the dossier. This means the common agent call cannot bulk-export a social graph with
   commentary.
2. **What `get_snapshot` may carry, stated exactly.** This tool flows to any connected MCP client on
   every routine planning call, so it is the widest surface and deserves a precise rule rather than a
   slogan:
   - **Mention snippets: never.** Mention *counts* and recency, yes; raw `user_text` excerpts, no.
     Those require an explicit `get_person` call.
   - **Open loops: yes, but only for the people in `attention[]`** — never the whole roster.

   The second point is a deliberate narrowing of an earlier draft of this doc, which said "raw text
   does not" go in the snapshot at all. That was too blunt: open loops are the entire payload that
   makes a suggestion concrete rather than a content-free nudge (§7), and withholding them would
   reduce the assistant to exactly the "follow up with Davi" failure this design exists to avoid.
   The honest accounting is that open loops are vault prose, and **the vault is already fully
   MCP-readable** through `read_brain_note` — so this is not new exposure, it is the same exposure
   arriving without a second round-trip. The bound that keeps it proportionate is that it covers only
   people the user explicitly opted into tracking, and it is the same bound the two-step assembly in
   §7 imposes for performance reasons.
3. **A content rule for `summary`.** Interaction summaries record **what the user did or said**, not
   inferences about the other person's state. "coffee, he's writing again" is fine; a characterisation
   of someone's mental health is not. This goes in the `log_interaction` tool description, where the
   composing model will actually read it.
4. **The disclosure heuristic as a tone rule**, not a feature: would this line be acceptable if the
   person it is about read it? Applied to assistant-written summaries.

**What does not need building.** The anxiety this category actually generates — visible unprompted and
repeatedly in the Monica and Dex threads — is about *custody*, not note-taking. Nobody objects to
having notes about people; they object to hosted, third-party-stored notes about people
("if the data ever gets leaked / hacked that I've just 1000% fucked everyone I've spoken to").
Mindboard is structurally better placed than every product reviewed: single-tenant Supabase with RLS
on every table, the vault in the user's own GitHub repo, no relationship-data broker in the loop. That
is the answer; no encryption scheme or consent system needs to be invented on top of it.

---

## 10. Milestones

### M1 — the roster and the dossier

No nudges, no cadence, no assistant writes. Two things make this milestone useful on its own rather
than inert: it is the first time the vault's per-person open loops are visible anywhere, and it ships
**one-tap interaction logging from the person sheet** so the `talked` signal starts accumulating from
day one instead of waiting on M2's assistant path. That direct write is not a proposal — the user
typing their own row is the same exemption the inventory omnibox's structured fast path already has.
Without it M1 would show an empty `TALKED` line for every person, which is the fair criticism of the
three-signal doctrine and is answered by sequencing, not by weakening the doctrine.

- `supabase/migrations/0047_people.sql` (§5). **Flag to Lucca; never auto-apply.**
- `app/lib/data/people.ts` — `getPeople(userId)`, `getPersonInteractions(userId, personId)`, React
  `cache()`, module-level `PEOPLE_COLUMNS` string mirrored by every other reader of the table.
- `app/lib/brain/parse.ts` — add `extractSectionBullets` (§6) + tests in `__tests__/brain-parse.test.ts`.
- `app/people/page.tsx` — server component. Resolve `timeZone` then `today` and pass **only `today`**
  across the client boundary, following `app/finance/page.tsx:95-104,273-288`. **Do not copy
  `app/inventory/page.tsx` for this** — it is one of the four known `todayISO(null)` debts.
- `app/people/people-client.tsx` — the roster (§8) and the person sheet (§6), using `Sheet` from
  `app/_components/stream-sheets.tsx`, `SectionRuler`/`Button`/`INPUT_CLASS` from
  `app/_components/ui.tsx`, and `<NoteView>` from `app/brain/_components/note-view.tsx`.
- `app/actions/people.ts` — lazy upsert from the vault (§5, via `after()` + service client), create
  person, archive/restore, edit aliases, and `logInteraction(personId, summary, occurredAt)`.
  `occurredAt` defaults to the page's resolved `today` prop — never a bare `new Date()`, and never
  `todayISO(null)`, since this value reaches a `date` column and so persists instead of healing on
  hydration (AGENTS.md, "a day that reaches a date column is never display-only").
- Dock: add `{ href: "/people", label: "people" }` to the "more" array (`dock.tsx:497-500`). The rail
  stays four items.

### M2 — logging without typing

- `app/lib/mcp/people-ops.ts` — pure, unit-tested, mirroring `inventory-ops.ts`: a `PersonOp` union
  (`log_interaction`, `create_person`, `set_checkin`, `archive`, `restore`), `validatePeopleOps`,
  `resolvePeopleOps` (name → id: exact, then unique substring; ambiguity fails the whole batch with
  candidates), `renderPeopleReceipt`. **The resolved op union stores ids, not names** — the
  `inventory-ops.ts:5-9` invariant, so a rename between propose and confirm cannot retarget a write.
- `writes.ts` — `proposePeopleUpdateFor(supabase, userId, raw, options)` + the thin service-client
  wrapper, `executePeopleUpdate`, registered in `EXECUTORS`. `confirm_action` / `cancel_action` and
  the in-app `confirmProposal` then work unchanged, because both dispatch through that same map.
- `reads.ts` + MCP route — `list_people` (metadata only) and `get_person` (dossier). Both via
  `scoped(userId)`, both filtering `.eq("user_id", ownerId)` explicitly, since the service client
  bypasses RLS. **`get_person` returns no mention snippets until M4** — the mention read does not
  exist yet, so the field is simply absent rather than empty, and M4 adds it.
- `app/lib/assistant/tools.ts` — mirror both reads plus `propose_people_update`, calling the `*For`
  variant with the session client.
- `occurred_at` on the MCP path resolves through `todayKey(supabase, userId)`
  (`app/lib/mcp/config.ts:56-67`) when the caller omits a date — one of the two blessed boundary
  resolvers. The assistant must never be allowed to pass an unresolved "today".

### M3 — attention

- `checkin_days` UI on the person sheet, with the **backfill prompt** on first set (§2).
- `app/lib/snapshots/people.ts` + `__tests__/people-snapshot.test.ts` (§7).
- `people` section in `planning.ts` / `planning-read.ts` (§7).
- The single "worth a message" card on `/people`, and at most one row on the dashboard stream.
- `tours.ts` (`TOUR_KEYS`, `ROUTE_TOURS`, a `people` step list anchored to chrome via `data-tour`)
  and a `whats-new.ts` entry.

### M4 — candidates from mindspace

The precision layer. Deferred deliberately: M1–M3 are correct without it, and it is the only part
that touches the classifier.

- A mention read over `mindspace_sessions.user_text` (+ vault bodies), reusing `termPattern`
  (`classify.ts:35-43`) against `name + aliases`. Not bounded by the 30-day gather window or the
  45-day `mindspace_items` purge — it queries the raw table, which is retained indefinitely.
- Candidate review on the person sheet: a quiet "N unreviewed mentions" count, **pull not push**,
  never a per-mention prompt. Confirming writes `person_interactions` with `source = 'confirmed'`.
- Optional and last: an `interaction_type: 'with' | 'about' | null` axis on the classifier tool schema
  (`llm.ts:35-82`) plus a column, to pre-sort candidates. Only worth it if manual review proves
  tedious in practice.
- Optional: Google Calendar **attendees**. `CalendarEvent` (`utils/google/calendar.ts:8-21`) does not
  carry them and the mapper drops them; the existing `calendar.readonly` scope already returns them,
  so this is a type + mapper change with no OAuth change. It is the only *deterministic* co-presence
  signal available — but per §2 it must feed **candidates**, never `talked` directly. Clay's mistake
  was treating a calendar entry as contact.

---

## 11. Explicitly out of scope

Contact-detail storage (phone, email, address), message sending or drafting into any channel, social
imports (LinkedIn, Google Contacts), birthday/anniversary tracking, relationship-strength scoring,
multi-user or shared notes, and any write path into `People/*.md`. That last one is worth stating
plainly: **nothing in Mindboard can create or edit a person note today** — `capture_to_brain` writes
`Inbox/` only, create-only, never overwriting (`capture.ts:124-131,160-244`). Person notes stay
Claude-in-conversation territory, per the vault's own ritual. Adding a fenced `People/` writer is a
separate decision that reopens the WHO/WHEN doctrine, not an implementation detail.

---

## 12. Verification

- **Unit (Vitest):** `extractSectionBullets` (incl. the missing-section and struck-through-bullet
  cases seen in the real notes); `peopleSnapshot` (opt-in gating, never-logged suppression, overdue
  ordering, DST/zone boundaries via the `__tests__/timezone-sweep.test.ts` table pattern);
  `people-ops` validate/resolve/receipt, including ambiguous-name failure and the
  resolved-ops-store-ids invariant.
- **Gates:** `npm run lint && npm run test && npm run build` before each milestone lands. The ESLint
  `no-restricted-syntax` backstop (`eslint.config.mjs:32-51`) automatically covers
  `app/people/page.tsx`, `app/lib/mcp/people-ops.ts`, `app/lib/snapshots/people.ts` and
  `app/actions/people.ts` — but it is a tripwire on two idioms, not coverage, so resolve
  `today`/`timeZone` explicitly rather than trusting it.
- **M2 end-to-end:** drive `log_interaction` through the connected Mindboard MCP server —
  propose → receipt → `confirm_action` → row check — and the same batch through the in-app assistant,
  confirming both paths land through the one `EXECUTORS` entry.
- **M1 in-browser:** a person with no `## Open questions` renders no empty box; the self-note and
  `type: pet` (Taiga) are absent from the roster; a person with no vault note (created via search)
  renders without a note block instead of erroring.
- **The standing check for every milestone:** does any surface ask the user to type a date? If yes,
  the design has drifted.
