# Mindspace — design & implementation plan

*Drafted 2026-07-22. Research-grounded design for the "what's been on my mind" section.*

## What it is

A new section that shows, for the past **3 days / week / month**, what share of the user's
recorded attention went to each of their life topics ("Emma", "Mindboard", "Best Buy",
"SPAN 202", …), computed from everything they generate: brain captures, journal notes,
tasks, in-app AI chats, Claude Code sessions, claude.ai conversations, calendar events,
daily-log notes, spend notes.

## The psychology (what the research says, and how it shaped the design)

Three subagent research passes ground this design. The load-bearing findings:

1. **Current Concerns theory (Klinger 1971–2013) is the theoretical spine.** Thought
   content is organized around *current concerns* — unresolved goals/commitments — and
   concern-related material is measurably over-represented in spontaneous thought
   (2× recall, 3× dream incorporation in cue studies). Mindspace topics ARE current
   concerns. This is why topic inference from personal traces is defensible at all,
   and why the taxonomy should read as *concerns* (a person, a project, a job, a course),
   not abstract subject tags.

2. **"% of mind" is a metaphor, not a measurement.** No method in cognitive science
   assigns literal percentages of mind to topics (attention-as-resource is a contested
   metaphor — Navon 1984). What researchers actually quantify: *frequency* of topic
   occurrences, *duration*, *intrusiveness*, *valence* (Killingsworth & Gilbert's landmark
   2010 EMA study only managed 3 valence buckets across 250k samples). **Design rule:**
   the denominator is always visible and honest — "of what you captured this week", whole
   numbers only, never decimals, always backed by tappable evidence counts ("12 captures,
   3 sessions").

3. **Written traces are a *directionally biased* proxy.** Availability heuristic,
   peak-end rule, negativity bias (Tversky & Kahneman 1973; Kahneman et al. 1993;
   Baumeister 2001): people write about problems and novelty, not routine contentment —
   and an aversive concern can dominate cognition while being *avoided* in writing.
   **Design rule:** UI copy says "as reflected in what you captured"; a quiet footnote
   notes that calm topics are under-counted. Never claim to read the mind.

4. **Rumination amplification is the main ethical risk.** Self-focus splits into
   *reflection* (curiosity-driven, healthy) and *rumination* (threat-driven, harmful)
   — Trapnell & Campbell 1999. Perseverative cognition has physiological costs
   (Brosschot 2006), and quantifying an activity can drain its intrinsic enjoyment
   (Etkin 2016, *JCR*). "Emma = 34%" rendered as an alarming live meter is close to the
   worst case. **Design rules:**
   - reflective, lowercase-calm framing (fits Terminal Calm anyway); observations are
     written as noticing, never judgment ("emma's share doubled this week, mostly
     late-night entries")
   - **mute control per topic** — collapse a topic from view without deleting data
     (an off-switch for loops the user doesn't want fed)
   - every high-share heavy topic pairs with a *forward* affordance (Klinger: concerns
     are goals — link to related open tasks / "want to set an intention?"), converting
     re-exposure into agency
   - no leaderboard framing of people; computed nightly, not live — a daily-cadence
     mirror, not a stock ticker to refresh

5. **Frequency × charge beats one number.** The literature's defensible intensity axes
   are frequency and emotional charge, so the blended score (user's choice) is computed
   as `volume × salience`, and the expanded topic view shows both raw components
   ("high volume, low charge" vs "low volume, high charge" are different facts).

## Topic model

New cross-domain entity (the gap in the current schema — every existing categorization
is domain-local: task groups, spending categories, vault folders).

```sql
create table mindspace_topics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  name text not null,
  kind text not null check (kind in ('person','project','work','course','area','emergent')),
  description text,                -- 1-2 lines, fed to the classifier
  aliases text[] not null default '{}',
  seed_ref jsonb,                  -- {vaultPath} | {groupId} | {courseId}
  status text not null check (status in ('active','muted','archived')) default 'active',
  pinned boolean not null default false,
  color text,
  taxonomy_version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

**Seeding (one-time + suggested onboarding):** derive candidates from what already exists —
vault `People/` `Projects/` `Areas/` `Topics/` pages, task groups (`Best Buy Shifts`,
`HIST204`, `SPAN201/202`, `Mindboard`, `Taiga`…), active courses. Present as a check-list
("these look like your current concerns — keep, rename, merge"). User edits freely:
rename (metadata-only), merge (mapping row, no re-classification), mute, pin, delete.

**Emergent discovery:** items that fit no topic go to an unclassified pool with a
`novelty_hint`. A weekly pass asks Haiku to propose 0–3 candidate topics *only if a
coherent recurring theme exists*; surfaced as one-tap suggestions ("looks like
'AI video editor' keeps coming up — track it?"). Human-in-the-loop always; no silent
taxonomy drift.

## Item ingestion & attention mass

Every countable trace becomes a `mindspace_items` row with a **mass** in a common
currency: *estimated minutes of engagement*. This is what makes a 2-hour Claude Code
session and a one-line spend note commensurable.

| Source | Where it lives today | Mass |
|---|---|---|
| Brain captures / journal / note edits | vault (GitHub) via `capture_to_brain` | reading-time from word count (~200 wpm), min 2 |
| In-app AI chats (`/plan`) | `ai_messages` | session span (first→last msg), capped 120 min |
| Claude Code sessions | local `~/.claude/projects/*.jsonl` | session duration, capped 120 min |
| claude.ai conversations | manual data-export import | session span, capped 120 min |
| Tasks (created/completed) | `tasks` | flat 3 (+`estimated_minutes` when completed) |
| Calendar events (attended) | Google Calendar | event duration |
| Daily-log notes | `daily_logs.note` | word-count reading time |
| Spend notes | `balance_changes.note` | flat 1 |
| Goals touched | `goals` | flat 3 |

```sql
create table mindspace_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  source text not null,           -- 'capture','journal','task','ai_chat','cc_session','claude_export','event','spend','daily_log','goal'
  source_ref text not null,       -- vault path / row id / session id / event id
  occurred_at timestamptz not null,
  mass numeric not null,          -- minutes of engagement
  word_count int,
  excerpt text,                   -- what the classifier saw (truncated/summary)
  meta jsonb not null default '{}',
  unique (user_id, source, source_ref)
);

create table mindspace_labels (
  item_id uuid not null references mindspace_items on delete cascade,
  topic_id uuid not null references mindspace_topics on delete cascade,
  weight numeric not null,        -- fraction of item's content, sums ≤ 1 per item
  salience smallint not null default 1,  -- 0 routine ·1 engaged ·2 charged ·3 intense
  valence smallint,               -- -2..+2, stored but not in the headline number
  model_version text,
  taxonomy_version int,
  created_at timestamptz not null default now(),
  primary key (item_id, topic_id)
);
```

Per-item labels (not just aggregates) are kept for **explainability** — "what drove
Emma to 34%?" opens the actual items — and so taxonomy edits and window changes are
recomputations, not re-classifications.

## Classification

**LLM-only v1** (Haiku 4.5, forced tool use, strict schema — no embeddings pipeline yet;
at this scale the LLM is ~$0.20–0.40 per 1,000 items ≈ **$0.30/user/month**, and the
vault is pre-labeled anyway). Runs on the user's own encrypted Anthropic key, same as
every other LLM feature in the app.

- **Cached system prefix** = the user's active taxonomy (id, name, kind, description,
  aliases) + rules. ~500 tokens, 90% cache discount.
- **Batches of 15–25 items** per call. Per item returns: `labels[{topic_id, weight}]`,
  `salience 0–3`, `valence -2..+2`, `unclassified` + `novelty_hint`.
- **Free classification fast-path:** capture notes already carry `topics:` frontmatter
  and `[[wikilinks]]`, and tasks carry `group_id`. When frontmatter topics/links map
  cleanly onto taxonomy aliases, skip the LLM entirely and assign directly (salience
  defaults to 1; a nightly sweep can LLM-score salience for mapped items cheaply).
  A large share of the stream classifies for $0.
- Long transcripts are summarized to ≤500 tokens before classification (also the
  privacy minimization step).

**Salience rubric (the "weight on mind" half):** 0 routine/logistical · 1 engaged ·
2 emotionally charged or personally significant · 3 intense/distressed-or-elated.
Multiplier applied to mass: ×0.5 / ×1.0 / ×1.6 / ×2.2. A raw 2am Emma entry
outweighs an equal-length changelog; a grocery note fades.

## The math

For window W (3/7/30 days, user's timezone via `user_settings.timezone`):

```
score(topic, W) = Σ over items in W:  mass(item) × salienceMult(item) × weight(item, topic)
share(topic, W) = score(topic, W) / Σ all scores in W
```

- **Hard windows** for the headline bars (users trust "last 7 days" literally).
- **Trend arrows** from a fast-vs-slow comparison: share in last 3d vs share in last 30d
  → ↑ rising / ↓ fading / → steady.
- Display: whole percentages; topics under 3% fold into "everything else";
  subtext shows the honest evidence base ("34% · 12 captures · 3 sessions · ↑").
- Aggregates are computed at read time from labels (a materialized rollup only if it
  ever gets slow — it won't at one user's volume).

## Pipeline & infrastructure

No new infra primitives — reuse the three that exist:

1. **Classify-on-write** for in-app sources: after `capture_to_brain`, task writes,
   assistant sessions closing, spend logs — enqueue into the existing `jobs` table
   (new kind `mindspace_classify`); a light runner drains the queue in batches.
   (Fallback v1: nightly-only, see 2 — ship faster, add on-write later.)
2. **Nightly pass** (overnight agent, which already runs on the PC every night):
   sweep any unclassified backlog, ingest the day's calendar events, run salience
   scoring for fast-path items, recompute trends, and write the day's **reflective
   observations** (below).
3. **Claude Code sessions** (local-only data): a step in the overnight agent scans
   `~/.claude/projects/*/*.jsonl` for sessions since last sync, computes duration,
   produces a ≤300-token local summary per session, and posts `{summary, duration,
   project, timestamps}` through a new MCP tool `mindspace_ingest_sessions`. Raw
   transcripts never leave the machine — only summaries are classified.
4. **claude.ai exports**: an import page under settings accepts the data-export zip,
   parses `conversations.json`, dedupes by `unique(user_id, source, source_ref)`
   (conversation uuid). Known acceptable double-count: a conversation that also
   produced a capture note counts twice, but the capture's mass is small
   (reading-time of a summary) so distortion is minor; revisit only if it shows.

**Taxonomy edits:** rename = metadata-only; merge = `UPDATE labels SET topic_id`;
mute = filtered at read time (data keeps accruing); add/split = re-classify only the
unclassified pool + last 30 days of items (one cheap batch), older history keeps its
labels with the old `taxonomy_version`.

## The gentle reflective layer

Nightly, after aggregation, one Haiku call gets the window deltas (numbers only — no
raw content) and writes at most 2–3 one-line observations, stored in
`mindspace_observations (user_id, topic_id nullable, text, window, created_at)`.

Tone contract (in the prompt): noticing, not judging; no advice unless a clear forward
step exists in the user's own open tasks; lowercase-calm; examples —
- "emma's share doubled this week — mostly late-night entries."
- "mindboard is at its lowest share in a month; span 202 took the space."
- "best buy barely registered this week despite 3 shifts — logged but not on your mind."

Heavy-topic pairing: if a `person`-kind topic exceeds ~30% with mean salience ≥2, the
topic's expanded view offers the mute control and links any related open tasks/goals —
never a warning banner.

## UI (Terminal Calm, no new libraries)

Route `/mindspace`, added to the Dock "more" menu (dock stays 6 primary tabs).
All viz hand-rolled Tailwind/SVG like `finance-calendar` — no chart libs, consistent
with the design system tokens (`--color-accent`, text scales).

- **Header:** window toggle `3d · week · month` (segmented, like existing toggles).
- **Headline:** one full-width stacked horizontal bar — the mind at a glance, topic
  colors from the topic entity (seeded from group colors where mapped).
- **Topic rows** sorted by share: name, whole-number %, thin bar, trend arrow,
  evidence subtext. Pinned topics always visible even under 3%.
- **Expanded row:** the two components (volume vs charge) as small paired bars, the
  driving items (tappable → note/task/session), this topic's observation line,
  mute + merge + rename actions.
- **Footer note** (small, muted): "based on what you captured — quiet things are
  under-counted."
- Empty/sparse states: under ~10 items in window → show counts, not percentages
  ("not enough captured for shares yet").

## Build order

- **M1 — foundation:** migrations (3 tables + observations), taxonomy seeding flow,
  fast-path classifier (frontmatter/wikilinks/groups only — zero LLM), read-time
  aggregation, `/mindspace` page with bars over vault + tasks + ai_messages +
  daily logs + spend notes. *Already useful.*
- **M2 — LLM classification:** Haiku batch classifier + salience, jobs-queue
  classify-on-write, calendar ingestion, trends, observations.
- **M3 — external streams:** overnight-agent Claude Code session sync
  (`mindspace_ingest_sessions` MCP tool), claude.ai export import page.
- **M4 — discovery & polish:** weekly emergent-topic suggestions, add/split scoped
  re-classification, MCP read tool `mindspace_snapshot` (so the assistant and agents
  can see it), sparse-state tuning.

## Costs & privacy

- Classification ≈ $0.20–0.40 / 1k items on the user's own key; at ~30 items/day
  that's **~$0.30/month**, less with the fast-path. Observations: pennies.
- Raw Claude Code transcripts stay local (summaries only). Long transcripts truncated/
  summarized before any API call. All new tables RLS'd per user like everything else;
  MCP tools take `userId` first-param per the multi-tenant invariant.

## Open questions

- Does `/mindspace` deserve a primary dock slot eventually (swap with `/week`?) —
  decide after living with it.
- Should observations also land in the vault journal (a weekly "mindspace digest"
  note) so the 2ndBrain sees its own mirror? Cheap to add in M2 if wanted.
