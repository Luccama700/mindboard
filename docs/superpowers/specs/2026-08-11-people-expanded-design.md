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
section**. And `mindspace_sessions.user_text` already holds Lucca's own words about them, generated as
a by-product of work he does anyway.

> *Precision, because earlier drafts of this doc overstated it:* those sections **are** already
> rendered today, as part of the note markdown at `/brain/note/People/<name>` — `NoteView` renders the
> whole note. What does not exist is a per-person **extraction** of them: nothing can read those
> bullets as data, so nothing can put them in a suggestion. The gap is machine-readability and reuse,
> not visibility. It is still the cheapest high-value item in the design, but for the right reason.

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

### The asymmetry rule — what unconfirmed evidence is allowed to do

An earlier draft said only confirmed rows could affect *anything*. The adversarial review named the
cost precisely: *"Refusing to use anything except perfect evidence does not create honesty; it creates
absence."* Under that rule passive capture produces only homework, and the feature rebuilds the very
data-entry burden it exists to avoid.

The fix is not to merge the signals. It is that the two directions of error are wildly asymmetric:

- Wrongly **claiming** contact ("you talked to Davi Aug 7") is the trust-destroying error the whole
  category fails on.
- Wrongly **staying quiet** costs one un-sent nudge. Nothing false is asserted and nobody notices.

So:

> **Evidence may quiet the system. Only the user may speak for it.**

Unconfirmed evidence — a calendar event with the person, a contact-shaped session mention — may
**suppress** a nudge for a bounded window and **surface as a reviewable candidate**, labelled as what
it is. It may **never** set or advance "last talked", appear in the interaction log, or be counted
anywhere as contact. A suppressed nudge says so out loud rather than vanishing: *"quiet for now — a
calendar event with Davi on Aug 18 hasn't been reviewed."* That is provenance-preserving inference,
not silent merging: it satisfies the research constraint (never fake contact) and the usability one
(never pretend to know nothing when strong evidence exists).

### Dates are uncertain, and the schema says so

The review's sharpest catch: a tap can establish *that* a session sentence describes contact but often
not *when*. A session ending Aug 11 may contain "I talked to Davi yesterday," "…last month," or "Davi
told me this years ago." Writing the session date and calling the cadence correct is fabricated
precision — the same failure in a new costume. The backfill chips below have the identical problem.

So `person_interactions` carries `occurred_precision` (`'exact' | 'approx'`), and **`approx` rows never
render a fabricated date** — "about a week ago", never "aug 4". Both writers that cannot know an exact
day (the backfill chips, and M4's candidate confirmation) must set it.

### Why not `lastTouch = max(interaction, vault updated)`

The v1 baseline proposed a hybrid. It is a good **display** rule and an unsafe **cadence** rule:
editing a note about Davi is being *informed*, not being *in touch*, so a hybrid max() lets a
non-contact event silently satisfy "last talked" — precisely the failure documented above. The
resolution is to split it by consumer rather than discard it:

- **Cadence / attention math: `talked` only.** Precision-critical.
- **Overview display and sort: both, labelled.** Informational, so a hybrid is honest as long as each
  line says which signal it is.

On day one `person_interactions` is empty. That is **not** a false-positive risk — §7's snapshot rule
already excludes anyone with a cadence but no logged interaction, so nothing fires. The real problem
is the opposite: silence. A cadence the user just set produces nothing at all until some conversation
happens to get logged, which can be weeks. So the backfill exists to **convert that silence into a
correct baseline**, not to prevent a burst: **setting a check-in cadence prompts one backfill
question** ("when did you last talk?" → `today · this week · this month · longer ago · not sure`).
One tap, one row, and the cadence is live immediately. "Not sure" sets no row, and the exclusion rule
keeps that person quiet until there is one.

Each option resolves to a concrete day by arithmetic on the page's resolved `today` prop — never a
device clock, never a bare `new Date()` — because the answer lands in a `date` column and therefore
persists instead of healing on hydration: `today` → `today`, `this week` → `addDaysKey(today, -3)`,
`this month` → `addDaysKey(today, -14)`, `longer ago` → `addDaysKey(today, -60)`. The server's day in
the user's stored zone is the anchor in every case. Only the `today` chip writes
`occurred_precision = 'exact'`; the other three write `'approx'`, per the rule above, so the page says
"about a week ago" rather than inventing "aug 4".

---

## 3. Design principles

Derived from the research; each traceable to a finding in the report.

1. **No streaks, no counters, no persistent "days since" number on the overview.** Quantifying an
   activity reliably increases output and *decreases* enjoyment (Etkin 2016, six experiments) — it
   makes the activity feel like work. Recency is shown as a qualitative band. The specific number
   appears only inside a suggestion, where it is a *reason*, not a score. This holds on the per-person
   page too — the "on your mind" line is a band ("often lately"), not a tally — so the principle needs
   no per-surface carve-out and the word "overview" in this rule is not a loophole.
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
| 1 | "migration 0036" | **0047** | Directory ends at `0046_recurring_slot_events.sql`. Purely factual — but several live `ai/*` branches could claim 0047 first, so re-check `ls supabase/migrations \| tail -1` at build time rather than trusting this number. |
| 2 | `lastTouch = max(interaction, vault updated)` | Split by consumer: interactions-only for cadence, both (labelled) for display | §2. Precision requirement + the documented trust failure. |
| 3 | `people` columns as listed | **`+ aliases text[] not null default '{}'`** | Mention matching needs "Lucca" to match the note "Lucca Martins de Andrade". A *live join* to `mindspace_topics.aliases` via `seed_ref->>'vaultPath'` stays rejected: person topics default *unchecked* at seeding unless the note has backlinks (`seed.ts:55`), so the join covers only a user-curated subset and would make matching silently incomplete. But the column is **seeded** from that table where a row does exist (deviation 13) — one-time copy, not a join, which takes the curated aliases without inheriting the coverage hole. |
| 4 | `person_interactions(person_id, summary, occurred_at)` | **`+ source text check in ('logged','confirmed')`** | Provenance is a design principle (§3.7), not decoration — the page must be able to say *how* it knows. One column, no new table. |
| 5 | `vault_path` unique per user | Unique per user **and nullable** | A person can exist without a note. `Davi.md` names "His mom is **Denise**" in plain prose — she is the brief's own motivating example and has no note of her own. |
| 6 | (unstated) | Overview is **flat alphabetical**, not attention-sorted | Have-first, per inventory. An attention-sorted list is a problem list. |
| 7 | Nudges from `checkin_days` alone | Cadence opt-in **also triggers a one-tap backfill** | Turns cold-start silence into a live cadence (§2). Note the rationale is *not* "kills a false-positive burst" — §7's exclusion rule already does that. |
| 8 | `person_interactions.summary` implicitly required | **`summary` nullable** | M1's one-tap log produces no prose; a `not null` column would force a text field and hand back the typing burden this design exists to refuse. §5. |
| 9 | `unique (user_id, lower(name))` | **Partial: `where not archived`** | Otherwise an archived person blocks their name forever, for both hand-created rows and the sync's adoption step. `0031_spend_limits.sql:31-38` is the house precedent for exactly this. |
| 10 | (unstated) | **`+ archived_at timestamptz`** | The "not tracking" section mirrors inventory (`0019_inventory_archive.sql`), which needs the stamp to order by. |
| 11 | Dossier as a sheet on `/people` | **Its own server route `/people/[id]`** | `<NoteView>` takes a `VaultCorpus` whose `resolve` is a *function* — it cannot cross the RSC boundary into a client component. §6. |
| 12 | (unstated) | **Dedup unique on confirmed interactions** | A double-tapped mention confirm would otherwise insert twice. §5. |
| 13 | Aliases seeded from name tokens | **Seeded from `mindspace_topics.aliases` when `seed_ref->>'vaultPath'` matches; name tokens as fallback** | Two alias registries for the same people otherwise diverge from birth. §5. |

Everything else in the baseline holds: own `/people` route reachable from the dock "more" menu; the
WHO/WHEN doctrine split; derived values computed at read time and never stored; opt-in nudges;
`list_people` read plus propose→confirm `log_interaction`; people folded into `get_snapshot` wide
mode. Vault rename → new row remains an accepted v1 limitation.

**Navigation dependency, stated plainly, because an earlier draft of this doc got it wrong.** The
"rail is frozen at four items" premise is true only on the unmerged **`nav-trim`** branch, where
`RAIL_TABS` is four entries (now / money / inventory / brain) and carries the comment "Trimmed to the
lived-in surfaces (2026-08-11)" at `dock.tsx:59`, with the "more" array at `dock.tsx:498`. On `main`
the rail still has **six** entries (now / inbox / money / inventory / learn / brain), that comment
does not exist anywhere under `app/`, and the "more" array sits at `dock.tsx:507-509`. **This design
assumes the `nav-trim` branch (PR #7) merges before M1.** If it does not, `/people` lands in a "more"
menu behind a six-tab rail and the "four lived-in surfaces" argument has to be re-made rather than
cited. Either way, **re-derive every `dock.tsx` line reference at build time** — they differ by
branch, and so will every other line receipt in this doc.

---

## 5. The data model

Two tables, one migration. Most columns are used by a shipped surface in M1–M3, and the two
exceptions are stated rather than buried: **`aliases` and the `'confirmed'` value of `source` do not
activate until M4** (mention matching and candidate promotion respectively). They ship in 0047 anyway,
because splitting a two-column addition into a second migration is more churn than the tidiness is
worth — but nobody should read them as M1 features, and nothing in M1–M3 may quietly start depending
on them.

**Scope authorization.** Lucca approved the People scope expansion 2026-08-11 (conversation); the
0047 migration itself still requires his explicit go-ahead before applying — never auto-apply.
AGENTS.md's scope note lists notes/wikilinks, goals, pgvector embeddings and AI audit logs as the
pre-authorized second-brain tables, and relationships are not among them, so this line *is* the
authorization record a future session should look for.

**Migration number.** `0047` assumes the directory still ends at `0046_recurring_slot_events.sql`.
Several live `ai/*` branches could claim it first, so **re-check `ls supabase/migrations | tail -1`
at build time.**

**Rejected outright, on YAGNI and the field-bloat evidence** (Salesforce ships 47 default contact
fields, HubSpot 94, and fewer than 20% of implementations hide the unused ones): relationship-type
tags (the vault carries this in prose — "Lucca's cousin", "clubbing friend" — and a structured facet
would need a migration pass plus a vault convention change for no surfaced benefit), important
dates/birthdays (nothing in the vault carries them; adding the field means asking the user to type,
which is the one thing this design refuses), a separate aliases table, and a person-to-person
relationship graph (wikilinks already are one, computed free by `computeBacklinks`).

### `supabase/migrations/0047_people.sql`

House style verified against `0031_spend_limits.sql` and `0004_inventory.sql`: no `updated_at`
triggers exist anywhere in the codebase (application code sets the column, and this design's writers
must actually do so — see M1), there are no explicit `GRANT`s — RLS plus four policies is the entire
access-control story — and **soft-archivable rows get *partial* unique indexes predicated on
`archived = false`** (`0031_spend_limits.sql:31-38`), which is the rule an earlier draft of this
migration broke.

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
  -- Seeded from the matching mindspace_topics row's aliases, else from the note
  -- basename's tokens; user-editable. DORMANT until M4.
  aliases text[] not null default '{}',
  -- Opt-in cadence. NULL means this person never generates attention.
  -- No defaults are ever shipped by relationship type. (A CHECK already passes on
  -- NULL, so no `is null or` branch is needed.)
  checkin_days int check (checkin_days > 0),
  -- Persisted "not now". A suggestion for this person stays suppressed until this
  -- date. Dismissal has to be state: a suggestion that reappears on reload or on
  -- another device is exactly the nagging principle 8 forbids. M3.
  attention_snoozed_until date,
  archived boolean not null default false,
  -- Stamped on archive so the collapsed "not tracking" section can order by it,
  -- per inventory_items.archived_at (0019).
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  -- No triggers exist in this codebase; every writer sets this explicitly.
  updated_at timestamptz not null default now()
);

create unique index people_user_vault_path_key
  on public.people (user_id, vault_path)
  where vault_path is not null;

-- Partial on `not archived`, per 0031_spend_limits.sql:31-38. A non-partial unique
-- would let an archived person block their name forever — breaking both the search
-- field's `add "davi"` and the vault sync's adoption step, with a raw unique
-- violation and no UI branch to catch it.
create unique index people_user_name_key
  on public.people (user_id, lower(name))
  where not archived;

-- No separate (user_id) index: people_user_name_key already leads with user_id and
-- serves the roster read, so a second one would be write cost for no read benefit
-- at 20-100 rows. 0031 ships a single plain index for the same reason.

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
  -- No composite FK tying person_id back to this row's user_id. That is the house
  -- pattern (spend_limits.category_id -> spending_categories has the same gap in
  -- 0031), and RLS still hides cross-tenant rows on read, so the exposure is orphan
  -- integrity rather than disclosure. Accepted explicitly, not by omission.
  person_id uuid not null references public.people (id) on delete cascade,
  -- What happened, in the user's terms. Records what the USER did or said,
  -- never an inference about the other person's state. See the privacy section.
  -- NULLABLE on purpose: the one-tap "talked" control (M1) writes no prose
  -- (summary null, source 'logged') and renders as a plain "talked". A not-null
  -- column would force a text field, and one tap that opens a textarea is not
  -- one tap.
  summary text,
  -- Date only: this is a day-grain fact, and storing an instant would invite
  -- UTC-slicing bugs downstream. Always written from a resolved user-zone day.
  occurred_at date not null,
  -- How much to trust that date. 'approx' is written by any path that cannot know
  -- the real day -- the backfill chips, and M4's candidate confirmation, where a
  -- session dated Aug 11 may say "I talked to Davi last month". An 'approx' row
  -- NEVER renders a fabricated exact date; the UI says "about a month ago".
  occurred_precision text not null default 'exact'
    check (occurred_precision in ('exact', 'approx')),
  -- Provenance. 'logged' = stated outright by the user (or the assistant on their
  -- behalf); 'confirmed' = promoted from a mindspace mention by an explicit tap
  -- (M4 only). The page shows this; it is not decoration.
  source text not null default 'logged'
    check (source in ('logged', 'confirmed')),
  created_at timestamptz not null default now()
);

create index person_interactions_user_person_idx
  on public.person_interactions (user_id, person_id, occurred_at desc);

-- A double-tapped mention confirm, or a retried action, must not insert twice.
-- Promoted mentions are one-per-person-per-day by construction. 'logged' rows are
-- deliberately NOT deduped: two real conversations on one day are a real thing.
create unique index person_interactions_confirmed_key
  on public.person_interactions (user_id, person_id, occurred_at)
  where source = 'confirmed';

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

**On hard delete.** `person_id … on delete cascade` means deleting a person destroys their `talked`
log — the one signal the doctrine treats as precision-critical, and the very thing the backfill exists
to seed. Archive stays the default and the only path offered outside the collapsed section, and the
delete confirm names what goes with it rather than using inventory's generic copy:
*"delete davi and 14 logged conversations?"*.

### The lazy upsert

**Where it lives — not in `app/actions/people.ts`.** Every export from a `"use server"` file is a
publicly invocable POST endpoint, so a `syncPeopleFromVault(userId)` sitting in an actions file and
running the service client would be a cross-tenant write endpoint: any authenticated session could
call it with someone else's uuid, and the service client has already bypassed RLS. The house
precedent is exact — `runMindspacePass` lives in `app/lib/mindspace/pipeline.ts`, not in actions, and
the page calls it. So the sync lives in **`app/lib/people/sync.ts`**, is invoked from
`app/people/page.tsx` inside `after()`, and takes its `userId` from that page's `auth.getUser()` —
never from an argument that crossed a network boundary.

**Mechanism — do not mutate during render.** The sync runs in `after()`, exactly as the mindspace
classification pass does (`app/mindspace/page.tsx:113`), and inside it **must use
`createServiceClient()`, not the cookie client** — the reason is spelled out at
`app/lib/mindspace/pipeline.ts:232-234`:

> "Service client, not the cookie client: `after()` runs outside the request context, where
> `cookies()` throws. Every query below is explicitly userId-scoped, per the multi-tenant invariant."

So every query in the sync filters `.eq("user_id", userId)` explicitly, since the service client
bypasses RLS, and the whole body sits in one try/catch the way `runMindspacePass` does — an `after()`
throw is silent, so an uncaught one means the sync simply stops happening with nothing in the UI to
show for it.

**Persistence must not gate visibility.** An earlier draft borrowed mindspace's "sharpens visit over
visit" contract, and it does not transfer: mindspace always has other material on screen, whereas here
the *primary entity registry* would be hidden until a second navigation — so a first-time user opens
`/people`, sees an empty page, and concludes the feature is broken, with a vault of 19 eligible notes
sitting right there. Instead the first render composes the roster from `people` rows **unioned with
eligible `People/*.md` notes that have no row yet**, keyed by path. Unpersisted entries render
read-only — no cadence control, no interaction log, since those need an id — and the `after()` sync
backfills them for the next visit. Visibility is immediate; persistence is eventual. M1 still must not
*depend* on the sync having run, which is exactly what the union guarantees.

**Credentials must be threaded, not resolved — this is the trap.** `getVaultCorpus(userId)` and the
`userId`-only convenience paths reach GitHub credentials through `getVaultCredentials(userId)`, which
is `readVaultCredentials(await createClient(), userId)` — **the cookie client**
(`app/lib/brain/vault.ts:122-126`). Calling either from inside `after()` throws for precisely the
reason the quote above gives, so "use the service client for the queries" is not sufficient advice:
the vault reads have to be given credentials explicitly.

```ts
const supabase = createServiceClient();
const credentials = await readVaultCredentials(supabase, userId);
if (!credentials) return;                        // no vault is normal, not an error
const entries = await listVaultNotePaths(credentials, vaultTag(userId));
```

Never the `userId`-only wrappers, here or in §7's assembler.

**Matching, and the collision that will otherwise bite.** For each `People/*.md` note, resolve an
existing row in this order:

1. by `vault_path` — already linked, nothing to do;
2. else by `lower(name)` **among rows whose `vault_path is null`** — **adopt**: set `vault_path` on
   that row.

Step 2 is not optional. Without it, a person created by hand from the search field (§8, the Denise
case) whose note later appears in the vault would hit `people_user_name_key` and the insert would
throw. The `vault_path is null` restriction is the subtler half and is equally non-optional: without
it, a note renamed `People/Davi.md` → `People/Davi Silva.md`, followed by a *different* Davi getting a
fresh `People/Davi.md`, would name-match the old row — whose `vault_path` still points at the
renamed-away note — and either silently retarget one person's identity onto a stranger's note or
violate `people_user_vault_path_key`. A row already holding some other `vault_path` is never adopted;
the sync inserts a new row instead.

**Concurrency.** Two tabs, or a load plus a prefetch, can enter the sync at once, both miss the same
note, and both insert — one gets a unique violation inside `after()`, where nothing catches it. So
inserts go through `.upsert(rows, { onConflict: "user_id,vault_path", ignoreDuplicates: true })`, and
the name-keyed path catches the unique violation and re-reads rather than throwing.

**Stale paths.** A rename leaves the old row pointing at a note that no longer exists. On a
*successful* tree fetch (never on a failed one), any `vault_path` absent from the tree is nulled, and
the page then treats that person exactly like a person who never had a note. A corpus miss and
`vault_path is null` are **one** case, not two — otherwise the per-person page has an unspecified
third state and renders a note block for a note nobody can fetch.

**Accepted limitations of this scheme**, all consequences of keying on the name and all fine at one
user's scale:

- A vault **rename produces a new row**; the old row keeps its interaction history, loses its
  `vault_path` to the stale-path rule above, and has to be archived by hand. (Carried over from the
  v1 baseline.)
- **Two distinct people who share a first name get conflated** by the `lower(name)` unique index and
  the adoption step. Same class of limitation as the rename case. The escape hatch already exists —
  rename one of them to something distinguishing, exactly as the vault itself would have to.
- **Accents are not folded.** `lower(name)` is case-insensitive but not accent-insensitive, so a
  hand-created "Davi" will not adopt a note titled "Daví", and `Luis` / `Luís` are two rows with a
  split history. Folding correctly would mean the `unaccent` extension — a new dependency — so this
  is stated, not fixed.

Name comes from `noteTitle(path)`. **Aliases seed from `mindspace_topics`**: if an active topic's
`seed_ref->>'vaultPath'` equals this note's path, copy that topic's `aliases`, since the user has
already curated them there. Otherwise fall back to **the first name token only** (so "Lucca Martins de
Andrade" seeds `{lucca}`), subject to the same `MIN_TERM_LENGTH = 3` floor the mindspace matcher uses
(`classify.ts:21`).

**Do not seed every token.** An earlier draft did, and it amplifies a failure mode the research report
already documents: the 3-character floor is the matcher's *only* false-positive defence — there is no
dictionary-word exclusion, no capitalisation requirement, no rarity weighting — so names colliding with
common words (Art, Grant, Rose, Will, May, Faith, Hope, Max, Jay) already match in free prose. Seeding
`martins` and `andrade` adds surnames that match relatives and unrelated people, which turns M4's
one-tap precision layer into manual cleanup. Everything past the conservative seed is user-added, and
the candidate UI shows **which term matched** so a noisy alias is diagnosable rather than mysterious.

**Two alias registries now exist and they will drift** — `people.aliases`, edited on `/people`, and
`mindspace_topics.aliases`, used by the classifier — so the per-person page's "on your mind" band can
disagree with `/mindspace`. That is an accepted limitation rather than a bug to design around, and the
reconcile rule is one line: **seeding is one-way and one-time, at row creation; after that each
registry owns its own edits.** If the divergence is ever actually felt, a later pass can reconcile
them; inventing a sync now would be speculative.

**Filters — and the self-note, which is not a one-line filter.** Skipping non-`person` frontmatter
does drop `type: pet` (Taiga) in one line. The self-note does **not** have a predicate: the vault's
own subject note ("Lucca Martins de Andrade.md") carries `type: person` exactly like the other 19, and
the vault exposes no `is_self` marker, no profile link, and no convention that distinguishes it. An
earlier draft called this a one-line filter, which is not implementable — a build session would have
to hardcode a name or guess from account metadata.

So **ask instead of guessing.** The first visit shows a seeding checklist, which is the move mindspace
already makes (`seed.ts` — *"these look like your current concerns — keep, rename, merge"*): every
eligible note listed, with non-`person` types and the note whose title best matches the account's
display name **pre-unticked** as a hint. The user corrects in one pass, and the result persists. This
doubles as the answer to "who counts as a person here", which no amount of frontmatter parsing can
settle — and it composes with the union rule above, since the checklist *is* the first render.

**The no-vault case is normal, not an error.** `/people` must work when `vault_settings` has no row
at all: the roster then shows only hand-created people, every person renders without a note block,
and the page shows a quiet "connect a vault to pull in your people notes" line rather than the
`VaultNotConfiguredError` banner. `getVaultCorpus` throwing must never take the page down —
`app/brain/page.tsx` already models catching `VaultConnectionError` for a friendly banner.

**Cost note.** The roster's secondary lines need note *bodies*, so `/people` pays for `getVaultCorpus`
(every blob, batched 25 at a time). It is `cache()`-deduped per request and `/brain` already pays it,
so this is acceptable — but it means `/people` is a corpus-weight page, not a Postgres-only one, and
the roster renders from `people` rows first with vault-derived text filled in around it. `/people/[id]`
pays it too, for exactly the reason `/brain/note/[...path]` does: `<NoteView>` needs the corpus's
wikilink resolver. The MCP path does **not** — see §7 and §9, which bound it to single-note reads.

---

## 6. The per-person view (design question 2)

The dossier. Composed **entirely from data that already exists**. Ordering is deliberate: the research
is unanimous that context beats fields, so context is on top and the field-like material is at the
bottom.

**It is its own server-rendered route, `/people/[id]` — not a sheet.** This is forced, not stylistic.
`<NoteView>` takes `{ note: VaultNote; corpus: VaultCorpus }` (`note-view.tsx:152`) and
`VaultCorpus.resolve` is a *function*, built by `buildResolver`, so the corpus cannot cross the RSC
boundary into a client component: passing it to a client `Sheet` throws on serialization, and the
version that "works" would ship every note body in the vault to the browser. Both existing call sites
(`app/brain/page.tsx:161`, `app/brain/note/[...path]/page.tsx:68`) are server components, and
`/brain/note/[...path]` is the working precedent to copy — roster row is a `<Link>`, the person page
is a server component, and only the interactive pieces inside it (the log control, the cadence input)
are client children receiving plain serializable props.

```
┌──────────────────────────────────────────────┐
│  davi                                        │  ← name, lowercase per house voice
│  cousin, 14, writes short stories            │  ← first sentence of the note's intro
│  ·  it's been a while                        │  ← qualitative band, never a number
├──────────────────────────────────────────────┤
│  TALKED         aug 3 · "coffee, he's        │  ← provenance-tagged, three lines,
│                 writing again"  (you logged) │     the anti-Clay panel
│  NOTED          aug 9 · note updated         │
│  ON YOUR MIND   often lately               ›│  ← band, not a tally; tappable
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
| Name | `noteTitle`, or `people.name` | free |
| Intro line | **`extractIntro`** | **a second new parser — not free (below)** |
| Recency band | `person_interactions` + `frontmatter.updated` | free |
| **Open loops** | `## Open questions` section of the note | **needs a small section extractor** |
| Recent | `person_interactions` | free |
| On your mind | `mindspace_sessions.user_text` matches, rendered as a band | new read (M4) |
| The note | `<NoteView>` from `app/brain/_components/note-view.tsx` | reused verbatim, **server-side only** — it needs the corpus |
| Connected | `note.backlinks` + `note.outgoing`, already computed by `computeBacklinks` | free |

**A band, not a tally.** "4 times in the last 30 days" is a counter wearing a sentence, and §3.1 bans
counters. The line renders as a qualitative band — `often lately` / `now and then` / `not lately` —
which is why §3.1 needs no per-surface exception carved into it. The underlying count still exists
inside the read; it simply never reaches the page.

**The open-loops block is the highest-value, lowest-cost item in the entire design.** A per-person
list of open loops already exists, hand-written, in 17 of 20 notes. It is rendered today only as
undifferentiated note markdown (§1); nothing can read it *as data*, which is what the suggestion
engine needs. It requires one pure function:

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

**The intro line needs a second parser, and it is not free either.** Earlier drafts costed it as
"`noteTitle` + first sentence of the note body — free", but `parse.ts` provides no prose extraction at
all: a note body is opaque markdown apart from frontmatter, wikilinks and callouts. The roster's
entire secondary column and the dossier subtitle depend on it, so it gets specified and tested rather
than left to a regex invented at build time.

```ts
// app/lib/brain/parse.ts — new export, tested with fixtures from the real notes.
// Skip frontmatter, skip the H1, skip blanks, take the first prose paragraph;
// reduce wikilinks and markdown links to their labels; collapse whitespace.
// Returns null when the note has no prose paragraph.
export function extractIntro(markdown: string): string | null
```

Fixture cases that exist in the real vault: `Emma.md` has **no blank line** between the closing `---`
and its `# Emma`, so the parser must not assume one; intros routinely open with a wikilink
(`Carla.md` → `[[Lucca Martins de Andrade|Lucca]]`), which must render as the alias text, not raw
`[[…|…]]`; and a person created from the search field has no note at all, so `null` is a normal
result the roster renders as a bare name.

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
  daysSinceTalked: number;           // non-null BY CONSTRUCTION — see the rules below
  checkinDays: number;
  overdueBy: number;                 // daysSinceTalked - checkinDays
  lastInteraction:
    | { summary: string | null; occurredAt: string; precision: "exact" | "approx" }
    | null;
  openLoops: string[];               // from extractSectionBullets
};

export type PeopleVitals = {
  total: number;
  tracked: number;                   // have a checkin_days
  attention: PersonAttention[];      // sorted by overdueBy desc
};

// TWO functions, not one. A single peopleSnapshot({ ..., openLoops }) cannot be
// assembled the way the two-step below requires: the assembler must know WHO
// survived before it fetches loops for them, but it cannot know that without
// having already called the function. Splitting resolves the circularity and is
// what makes the "at most three" bound expressible at all.

// Step 1 — Postgres rows only. Returns the COMPLETE ranked set, unbounded.
export function computePeopleAttention(input: {
  people: PersonRow[];
  interactions: PersonInteractionRow[];
  candidates: MentionCandidateRow[];     // [] before M4; drives suppression (§2)
  today: string;
}): PeopleVitals;                        // attention[] entries have openLoops: []

// Step 2 — attach vault prose to an ALREADY-BOUNDED slice.
export function hydratePeopleAttention(
  attention: PersonAttention[],          // caller passes attention.slice(0, N)
  openLoops: Record<string, string[]>,   // personId -> bullets
): PersonAttention[];
```

**The bounds are stated numbers, not "the survivors".** `computePeopleAttention` returns everyone
overdue — if thirty people are overdue, thirty survive, so "at most three" is a property of the
*caller*, not of the function. `/people` hydrates `attention.slice(0, 1)`; `get_snapshot` hydrates
`attention.slice(0, 3)`; nothing else consumes the unbounded array.

Keying `openLoops` by **`personId`, not `vaultPath`**, matters: `vault_path` is nullable, and Denise —
the brief's own motivating example — has no note, so a vaultPath-keyed map has no slot for her at all
and would make the type quietly lie about which people can carry loops.

Rules, all of them boring on purpose:

- A person is eligible for attention **only** if `checkin_days is not null` and not archived.
- `daysSinceTalked` uses `person_interactions` **only**. Vault `updated` never enters this math.
- Eligible **and** never logged → **excluded from `attention[]` entirely** (the backfill covers this;
  a person with a cadence but no logged interaction is a setup gap, not an overdue relationship).
  This is why `daysSinceTalked` is typed `number` rather than `number | null`: allowing null would
  make `overdueBy` `NaN`, silently degrade the `overdueBy desc` ordering, and force a non-null
  assertion at the exact site where the exclusion rule is supposed to be load-bearing.
- Surfaced when `daysSinceTalked > checkin_days`.
- The UI takes `attention[0]` and shows **one** row. The rest of the array exists for the assistant
  only — never as a notification queue, and never as an attention strip on `/people`, which would be
  §3.8's ban broken and §8's guilt aquarium rebuilt under another name.

### The assistant half

`get_snapshot` wide mode already carries per-domain sections; `people` slots in beside `signals`
(`planning.ts:204-207`), with the fetch added to the `Promise.all` in `buildPlanningSnapshot`
(`planning-read.ts:95-184`) so MCP and the in-app assistant share one read.

**Assemble it in two steps, and do not drag the corpus in.** A one-function design would force the
assembler to produce `openLoops` up front, and the only way to do that for an unknown set of people is
`getVaultCorpus` — which downloads *every* blob in the vault — on every `get_snapshot` wide call from
every MCP client. That is unacceptable for a tool the assistant hits on routine planning turns.
Instead:

1. Compute `attention[]` from Postgres rows alone (`people` + `person_interactions`). This is the
   whole cadence calculation; it needs no vault data.
2. **Then** hydrate `openLoops` for only the people that survived — at most three — with **one**
   `fetchTree` for the whole hydration, reading the surviving notes' blobs off that single listing.

   **Do not call `readVaultNoteRaw` per person.** It is *not* a single-note fetch, despite reading
   like one: it calls `fetchTree(credentials, tag, { fresh })` with `fresh = true` by default
   (`vault.ts:288-302`), so three people means three *uncached* tree listings on every wide
   `get_snapshot` — which is most of the cost this two-step exists to avoid, reintroduced by the fix.
   Credentials come from `readVaultCredentials(supabase, userId)` using the client
   `buildPlanningSnapshot` already holds — never `getVaultCorpus`, never a `userId`-only wrapper (§5).

So the vault cost is bounded by one tree fetch plus at most three blobs, regardless of vault size or
roster size. Both functions stay pure; this is entirely the assembler's job.

**Hydration is best-effort, per person.** A missing vault, revoked token, renamed-away note, GitHub
outage or parse failure yields `openLoops: []` for that person and nothing more — it must never fail
the snapshot. Cadence is entirely Postgres-backed, so an *optional context enhancement* taking down
routine planning calls for the assistant and every connected MCP client would be a serious
regression, and `/people` already catches these same failures (§5). Wrap the hydration step in its own
try/catch and return the unhydrated attention set on any error.

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

- Each row is a plain `<Link href={`/people/${id}`}>` to the per-person route (§6), not a sheet
  trigger. The roster client component never receives a `VaultCorpus`.
- The secondary line is the note's intro sentence, truncated — free context, zero new fields.
- The recency chip appears **only** for people with a cadence. Everyone else is just a name. This is
  what "attention is opt-in" looks like on a list.
- The search field doubles as capture: typing a name that matches nobody offers `add "denise"` — which
  creates a `people` row with `vault_path = null`. This is how the Denise case gets solved without a
  vault write.
- `[ not now ]` on the suggestion card writes `attention_snoozed_until`, not component state — a
  dismissal that comes back on reload or on the phone is the nagging principle 8 forbids.
- Archive (`stop tracking`) mirrors inventory: hidden, restorable, hard delete only inside the
  collapsed section, and the delete confirm names the interaction count it is about to cascade away
  (§5).

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
   returns the dossier, and it reads **that one person's note only** — one tree fetch plus one blob,
   never `getVaultCorpus`. That is both the privacy bound and the performance one: it keeps the MCP
   path off the corpus-weight read §7 forbids, and it means the common agent call cannot bulk-export a
   social graph with commentary.
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

### The write matrix

Listed exhaustively because a milestone-driven build omits whatever the prose only implied — an
earlier draft promised hard delete, alias editing and a stream row with no owning action between them.
**Every row that touches a `people` record sets `updated_at` explicitly**; no trigger exists to do it.

| Operation | Milestone | Path | Notes |
|---|---|---|---|
| vault sync (insert / adopt / null stale paths) | M1 | `after()` + service client | conflict-aware; never gates render |
| first-run seeding checklist | M1 | server action | resolves self-note and pets (§5) |
| create person | M1 | server action | from the search field; `vault_path` null |
| log interaction | M1 | server action | one tap; `summary` null, `precision` `exact` |
| edit / delete interaction | M1 | server action | needed the first time a tap is wrong |
| archive / restore | M1 | server action | stamps `archived_at` |
| hard delete person | M1 | server action | archived section only; cascades interactions |
| edit name / aliases | M1 | server action | trim, dedupe, drop entries under 3 chars |
| `log_interaction`, `create_person`, `set_checkin`, `archive`, `restore` | M2 | MCP + assistant, propose→confirm | one `EXECUTORS` entry |
| set cadence (+ backfill) | M3 | `setPersonCadence`, **atomic** | see M3 |
| snooze / unsnooze | M3 | server action | writes `attention_snoozed_until` |
| confirm / dismiss candidate | M4 | server action | atomic with the interaction insert |

### M1 — the roster and the dossier

No nudges, no cadence, no assistant writes. Two things make this milestone useful on its own rather
than inert: it is the first time the vault's per-person open loops are visible anywhere, and it ships
**one-tap interaction logging from the person page** so the `talked` signal starts accumulating from
day one instead of waiting on M2's assistant path. That direct write is not a proposal — the user
acting on their own row is the same exemption the inventory omnibox's structured fast path already has.
One tap means *one tap*: it writes `{ summary: null, source: 'logged', occurred_precision: 'exact' }`
and renders as a plain "talked", which is exactly why `summary` is nullable (§5). A prose summary is an
optional second gesture, never a gate. Without this M1 would show an empty `TALKED` line for every
person, which is the fair criticism of the three-signal doctrine and is answered by sequencing, not by
weakening the doctrine.

- `supabase/migrations/0047_people.sql` (§5). **Flag to Lucca; never auto-apply.** Re-check the latest
  migration number before naming the file.
- `app/lib/data/people.ts` — `getPeople(userId)`, `getPersonInteractions(userId, personId)`, React
  `cache()`, module-level `PEOPLE_COLUMNS` string mirrored by every other reader of the table.
- `app/lib/people/sync.ts` — the lazy upsert from the vault (§5): service client, **threaded**
  credentials, adoption restricted to `vault_path is null` rows, `upsert` with `ignoreDuplicates`,
  stale-path nulling, the whole body in one try/catch. **Not in `app/actions/people.ts`** — a
  `"use server"` export taking a `userId` and running the service client is a cross-tenant write
  endpoint (§5).
- `app/lib/brain/parse.ts` — add `extractSectionBullets` (§6) + tests in `__tests__/brain-parse.test.ts`.
- `app/people/page.tsx` — server component, the roster. Resolve `timeZone` then `today` and pass
  **only `today`** across the client boundary, following `app/finance/page.tsx:95-104,273-288`. **Do
  not copy `app/inventory/page.tsx` for this** — it is one of the four known `todayISO(null)` debts.
  Fires `after(() => syncPeopleFromVault(user.id))` with the id from its own `auth.getUser()`.
- `app/people/[id]/page.tsx` — server component, the dossier (§6). Renders `<NoteView note corpus />`
  directly, following `app/brain/note/[...path]/page.tsx`. The corpus never leaves the server.
- `app/people/people-client.tsx` — the roster's interactive shell only (§8): search/add field,
  filtering, archive. Rows are `<Link>`s to `/people/[id]`. Uses `SectionRuler`/`Button`/`INPUT_CLASS`
  from `app/_components/ui.tsx`. It does **not** import `<NoteView>` and never receives a
  `VaultCorpus`. Any interactive piece *inside* the dossier (the log control, later the cadence input)
  is its own small client component taking serializable props.
- `app/actions/people.ts` — user-initiated writes only: create person, archive/restore (stamping
  `archived_at`), edit aliases, hard delete behind the count-naming confirm, and
  `logInteraction(personId, summary, occurredAt)`. `occurredAt` defaults to the page's resolved
  `today` prop — never a bare `new Date()`, and never `todayISO(null)`, since this value reaches a
  `date` column and so persists instead of healing on hydration (AGENTS.md, "a day that reaches a date
  column is never display-only"). Every write sets `updated_at` explicitly; no triggers exist in this
  codebase to do it.
- Dock: add `{ href: "/people", label: "people" }` to the "more" array — **re-derive the line number
  at build time** (`dock.tsx:498` on `nav-trim`, `dock.tsx:507-509` on `main`; §4). This feature does
  not touch `RAIL_TABS` either way.
- `whats-new.ts` entry + a short `people` tour in `tours.ts` (`TOUR_KEYS`, a `ROUTE_TOURS` prefix for
  `/people`, steps anchored to chrome via `data-tour`, never to data rows). AGENTS.md requires both of
  any user-facing feature, and M1 *is* user-facing — deferring them to M3 would ship a new route and a
  new dock entry twice with no patch note and a dead `?` button on the new screen.

### M2 — logging without typing

- `app/lib/mcp/people-ops.ts` — pure, unit-tested, mirroring `inventory-ops.ts`: a `PersonOp` union
  (`log_interaction`, `create_person`, `set_checkin`, `archive`, `restore`), `validatePeopleOps`,
  `resolvePeopleOps` (name → id: exact, then unique substring; ambiguity fails the whole batch with
  candidates), `renderPeopleReceipt`. **The resolved op union stores ids, not names** — the
  `inventory-ops.ts:5-9` invariant, so a rename between propose and confirm cannot retarget a write.
- `writes.ts` — `proposePeopleUpdateFor(supabase, userId, raw, options)` + the thin service-client
  wrapper, `executePeopleUpdate`, registered in `EXECUTORS`. `confirm_action` / `cancel_action` and
  the in-app `confirmProposal` then work unchanged, because both dispatch through that same map.
- `reads.ts` + MCP route — `list_people` (metadata only) and `get_person` (dossier, **one note read**
  — one tree fetch plus one blob, never `getVaultCorpus`; §9). Both via `scoped(userId)`, both
  filtering `.eq("user_id", ownerId)` explicitly, since the service client bypasses RLS.
  **`get_person` returns no mention snippets until M4** — the mention read does not exist yet, so the
  field is simply absent rather than empty, and M4 adds it.
- `app/lib/assistant/tools.ts` — mirror both reads plus `propose_people_update`, calling the `*For`
  variant with the session client.
- `occurred_at` on the MCP path resolves through `todayKey(supabase, userId)`
  (`app/lib/mcp/config.ts:56-67`) when the caller omits a date — one of the two blessed boundary
  resolvers. The assistant must never be allowed to pass an unresolved "today". A caller-supplied
  vague date ("last month") must set `occurred_precision = 'approx'` rather than guessing a day.
- A `whats-new.ts` entry for the assistant/MCP surface — same AGENTS.md obligation as M1.

### M3 — attention

- **`setPersonCadence({ personId, checkinDays, backfill })` — one action, and it must be atomic.**
  M1's action list has no `setCheckin`, and M2's version is an assistant proposal, so without this the
  person page's most important control has no write path and a build session invents one. Atomicity is
  the load-bearing part: if the cadence update lands and the backfill insert fails, the person has a
  cadence and no interaction row — which §7's exclusion rule silently suppresses, producing a cadence
  the user set that never fires, with nothing on screen to explain it. Do both in one
  transaction-capable path and surface a failure rather than half-applying it. `backfill: "not_sure"`
  writes no row and is a legitimate terminal state, not an error.
- The **backfill prompt** on first set (§2). Each chip resolves to a day by arithmetic on that page's
  `today` prop and sets `occurred_precision` accordingly — `today` → `exact`, everything else →
  `approx`.
- `app/lib/snapshots/people.ts` + `__tests__/people-snapshot.test.ts` (§7).
- `people` section in `planning.ts` / `planning-read.ts` (§7), with the two-step assembly and threaded
  vault credentials — one tree fetch, at most three blobs.
- The single "worth a message" card on `/people`, with `[ not now ]` writing `attention_snoozed_until`.
- **The dashboard-stream row is its own work, not a free rider on the planning snapshot.** It needs a
  `people` input on `streamSnapshot` (`app/lib/snapshots/stream.ts`) and a fetch in `getStreamData`
  (`app/page.tsx`), reusing `getPeople`'s `cache()`. If that is more than M3 wants to carry, **cut the
  stream row** rather than bolting a second uncached read onto the dashboard.
- `tours.ts` copy update for the cadence step (the `people` tour itself shipped in M1) and a
  `whats-new.ts` entry.

### M4 — candidates from mindspace

The precision layer. Deferred deliberately: M1–M3 are correct without it, and it is the only part
that touches the classifier.

- **`supabase/migrations/0048_person_mention_candidates.sql` — M4 does not work without it.** There is
  nowhere in 0047 to record *which* mention produced an interaction, which were reviewed, or which were
  dismissed: `source` distinguishes only `logged` from `confirmed`. So a rescan rediscovers the same
  mentions forever and "unreviewed" is not computable. The table is deferred to here rather than added
  to 0047 so it earns its migration:

  ```sql
  create table public.person_mention_candidates (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    person_id uuid not null references public.people (id) on delete cascade,
    source_kind text not null check (source_kind in ('session', 'calendar')),
    source_ref text not null,        -- session_ref, or the calendar event id
    occurred_at date not null,       -- the EVIDENCE's date (session end / event day)
    excerpt text,                    -- matched passage, capped; null for calendar
    matched_term text,               -- which alias hit, so a noisy alias is diagnosable
    status text not null default 'new'
      check (status in ('new', 'confirmed', 'dismissed')),
    reviewed_at timestamptz,
    created_at timestamptz not null default now()
  );

  -- Makes rescans idempotent: one piece of evidence never yields a second candidate.
  create unique index person_mention_candidates_evidence_key
    on public.person_mention_candidates (user_id, person_id, source_kind, source_ref);

  create index person_mention_candidates_review_idx
    on public.person_mention_candidates (user_id, person_id, status, occurred_at desc);
  ```

  Plus the four RLS policies in house style. `occurred_at` here is the evidence's own date and is
  **not** the interaction's date — see the confirmation rule below.
- **Scan incrementally on ingest; never search on read.** An `ILIKE`/regex pass per person over an
  indefinitely-retained corpus gets permanently slower and would ship large volumes of raw session
  text to a page render. Instead keep a per-user **watermark** (the last scanned
  `mindspace_sessions.ended_at`); when new sessions arrive, scan each **once** against the whole roster
  and write candidate rows. The person page then reads candidates **by index** and never scans.
  Historical backfill is an explicit, paginated one-off, not read-path behaviour.
- `termPattern` (`classify.ts:35-43`) **cannot be reused verbatim**: it is module-private, and it
  returns `new RegExp(…, "iu")` with no `g` flag, so it answers *presence*, not *how many*. Export it
  with an optional flags argument, or build a `g`-flagged regex alongside it and count with
  `matchAll`. The scan is not bounded by the 30-day gather window or the 45-day `mindspace_items`
  purge — it reads the raw table, which is retained indefinitely.
- **Vault bodies are not mention events.** Earlier drafts scanned them alongside sessions. Sessions
  carry `ended_at`, an unambiguous instant; note bodies carry no per-sentence date, their inline date
  formats are inconsistent (two incompatible styles, most bullets undated), and no date parser exists.
  A name appearing five times in one note is not five dated attention events. The `noted` signal
  already covers the vault, so vault matches never enter the dated band or the candidate stream.
- Candidate review on the person page: a quiet unreviewed-mentions affordance, **pull not push**,
  never a per-mention prompt, and phrased as a band rather than a tally per §3.1. Confirming flips
  `status` to `'confirmed'` **and** inserts the interaction in one transaction-capable path;
  dismissing sets `'dismissed'`. Both are idempotent on re-tap —
  `person_mention_candidates_evidence_key` plus `person_interactions_confirmed_key` make a double tap
  a no-op rather than a duplicate row.
- **Confirmation asks two questions, not one.** A tap can establish *that* a mention describes contact;
  it frequently cannot establish *when* (§2.4). So the confirm control offers the same day chips as the
  backfill, defaulting to the session's day, and writes `occurred_precision = 'approx'` unless the user
  picks an exact day. Silently adopting the evidence date and calling the cadence correct would be the
  fabricated precision this doctrine exists to refuse — and would reset a cadence on the strength of a
  sentence that may have said "Davi told me this years ago".
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

Contact-detail storage (phone, email, address), **sending or scheduling a message on any channel**,
social imports (LinkedIn, Google Contacts), birthday/anniversary tracking, relationship-strength
scoring, multi-user or shared notes, and any write path into `People/*.md`.

**Where "suggest, never send" stops, precisely.** Principle 5 says "Mindboard drafts; Lucca sends",
while an earlier version of this list ruled out "drafting" outright — a flat contradiction a build
session would have had to resolve by guessing. The line: `[ open ]` on a suggestion opens the
**in-app assistant** with that person's bounded context (name, days, open loops), so the user can ask
it to help word something. Mindboard composes **in the assistant, on request**. It never generates
unprompted message text, never targets a channel, and never sends. Principle 5 and this section now
agree, and the suggestion card itself carries no draft — only `[ open ]` and `[ not now ]`.

That last scope item is worth stating
plainly: **nothing in Mindboard can create or edit a person note today** — `capture_to_brain` writes
`Inbox/` only, create-only, never overwriting (`capture.ts:124-131,160-244`). Person notes stay
Claude-in-conversation territory, per the vault's own ritual. Adding a fenced `People/` writer is a
separate decision that reopens the WHO/WHEN doctrine, not an implementation detail.

---

## 12. Verification

- **Unit (Vitest):** `extractSectionBullets` (incl. the missing-section and struck-through-bullet
  cases seen in the real notes); `peopleSnapshot` (opt-in gating, never-logged **exclusion**, overdue
  ordering, `openLoops` keyed by `personId` including a vault-less person, DST/zone boundaries via the
  `__tests__/timezone-sweep.test.ts` table pattern); the backfill chip → day arithmetic, asserting
  every chip derives from the injected `today` and that only `today` yields `'exact'`; `people-ops`
  validate/resolve/receipt, including ambiguous-name failure and the resolved-ops-store-ids invariant.
- **Gates:** `npm run lint && npm run test && npm run build` before each milestone lands. The ESLint
  `no-restricted-syntax` backstop automatically covers `app/lib/mcp/people-ops.ts`,
  `app/lib/snapshots/people.ts`, `app/lib/people/sync.ts`, `app/actions/people.ts` and — via the
  `app/**/page.tsx` glob, which AGENTS.md's summary of this rule omits — both `app/people/page.tsx`
  and `app/people/[id]/page.tsx`. It does **not** cover `app/people/people-client.tsx` or any other
  client component, and it is a tripwire on two idioms rather than coverage in any case, so resolve
  `today`/`timeZone` explicitly rather than trusting it.
- **M2 end-to-end:** drive `log_interaction` through the connected Mindboard MCP server —
  propose → receipt → `confirm_action` → row check — and the same batch through the in-app assistant,
  confirming both paths land through the one `EXECUTORS` entry.
- **M1 in-browser:** a person with no `## Open questions` renders no empty box; the self-note and
  `type: pet` (Taiga) are absent from the roster; a person with no vault note (created via search)
  renders without a note block instead of erroring; a person whose `vault_path` points at a
  since-renamed note renders the same way rather than a broken note block.
- **M1 boundary check, and it is not optional:** confirm no `VaultCorpus` is passed to any client
  component. The symptom of getting this wrong is a serialization error on `corpus.resolve`, so it
  fails loudly — but the "fix" a builder reaches for (stripping `resolve` and re-deriving it client-side)
  ships the whole vault to the browser and fails silently. `/people/[id]` renders `<NoteView>` on the
  server or it is wrong.
- **M1 concurrency check:** load `/people` twice in quick succession on a vault with an unsynced
  person and confirm one row, no unhandled unique violation in the logs, and no silently dead
  `after()`.
- **The standing check for every milestone:** does any surface ask the user to type a date? If yes,
  the design has drifted.

---

*This doc lives under `docs/superpowers/specs/` while it is a design record. **When M1 lands it
graduates to `docs/people-plan.md`** — flat in `docs/`, alongside `finance-automation-plan.md`,
`inventory-redesign-plan.md`, `education-plan.md` and `second-brain-plan.md` — and gains a pointer
from AGENTS.md, which is the only place a future session will actually look for it.*
