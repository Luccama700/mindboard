# Research brief: what games do to make objectives legible (2026-10-20)

Produced by a deep-research agent for the quest-log ideas. Sections 1–3 are sourced; section 4 is the researcher's inference.

## Verdict

Copy what games do to **guide** you, not what they do to **reward** you.

- **Strongest adjacent evidence:** cues, visible steps, one clear objective, and a forgiving reset.
- **Mixed evidence, well-documented backfire modes:** points, streaks, XP, overdue penalties and social damage. Duolingo is the best pro-streak case, and even it added Freezes.
- **No study tests a quest-style task UI directly.**

## 1. Game objective UX

- **Log vs marker.** A log says what and why; a marker says where.
  - Elden Ring has no quest log: "There's no list in your UI which tells you your progress so far, and where you should go next", and NPC steps are easy to miss (Savant, Game Developer 2022, https://www.gamedeveloper.com/game-platforms/narrative-design-in-elden-ring). Miyazaki designs for "the player who is completely blind" while expecting guide use. Stripping guidance shifts the cost onto the player ("buy a notebook").
- **Diegetic, on-demand guidance.**
  - Ghost of Tsushima's wind is "a single vector pointing from the hero towards a current goal", summoned by a swipe (GDC 2021 via Game Developer).
  - Breath of the Wild pulls the player along a "chain of interest" (hill, bridge, tower) and lets them choose which quest to mark.
- **Guidance as a setting.**
  - AC Odyssey offers Guided (markers always, objectives automatic) or Exploration.
  - Baldur's Gate 3 patch 1 turned "several precise map markers" into "general area markers".
- **Givers, tiers, chains, caps.**
  - WoW's "!" came from Metal Gear Solid's alert. Its quest-log cap went 20 → 25 → 35.
  - Skyrim groups quests as Main/Faction/Daedric/Side/Misc, with a separate misc journal.
  - Chains unlock sequentially. No sourced designer rationale was found for exactly-one tracked objective; treat it as convention.
- **Dailies and bounties.**
  - Destiny 2 removed bounties to cut "chores", called that "an over-correction", then restored them as expiring and costing currency to stop hoarding. Seasonal challenges later replaced weekly bounties to fight "bounty fatigue and FOMO" and "reduce the penalties for missing a given week".
  - Animal Crossing's Nook Miles+ gives renewable daily goals that players use to set their own goals.

## 2. Apps that borrowed game mechanics

- **Habitica.**
  - Pause Damage stops HP loss from missed dailies, but party members' misses still hurt you.
  - The best study found seven themes of counterproductive effects, including penalties during productive stretches and relabelling tasks to dodge punishment. Perceiving the reward system as inappropriate predicted motivation change over time (Diefenbach & Müssig 2019, https://epub.ub.uni-muenchen.de/77668).
- **Todoist Karma.** "You lose Karma points when you have tasks that are five or more days overdue." Vacation mode keeps streaks. No outcome data.
- **Duolingo** (first-party, correlational).
  - 7-day streakers are 3.6× likelier to finish a course.
  - Two equipped Freezes gave +0.38% DAU; streak animations gave +1.7% new-learner retention.
  - It concedes a broken streak can "feel quite demotivating".
- **SuperBetter.** An RCT (n = 283) showed large depression effects, with high attrition. It doesn't measure productivity.
- **Finch, Forest, Amazing Marvin:** thin evidence.
  - Finch has no punishment for missed days. One autoethnography describes drift into reward-driven engagement.
  - Forest's tree withers if you leave the app.
  - Marvin has "Super Focus" (one task at a time) and a Procrastination Count. No outcome data.

## 3. Academic evidence

- **Reviews.**
  - 819 studies "lean towards positive… the amount of mixed results is remarkable" (Koivisto & Hamari 2019).
  - In learning: g = .49 cognitive, .36 motivational, .25 behavioral, and the motivational and behavioral effects are less stable in rigorous subsets (Sailer & Homner 2020).
- **Overjustification.** Across 128 experiments, engagement-, completion- and performance-contingent rewards undermined intrinsic motivation (d = −0.40, −0.36, −0.28), while positive feedback enhanced it (d = +0.33) (Deci, Koestner & Ryan 1999). Games' pull tracks autonomy, competence and relatedness (Ryan et al. 2006).
- **Streaks.**
  - Highlighting intact streaks raises later engagement, and people treat the streak itself as a goal. Self-attributed breaks amplify the effect, and repair attenuates it (Silverman & Barasch 2023).
  - Missing one opportunity "did not materially affect the habit formation process" (Lally 2010).
- **Cues, progress, resets.**
  - If-then plans: d = .65 (Gollwitzer & Sheeran 2006).
  - Specific plans end the intrusion of unfinished goals (Masicampo & Baumeister 2011).
  - Endowed progress: pre-stamped loyalty cards were completed 34% vs 19% (Nunes & Drèze 2006).
  - Fresh-start landmarks (Dai, Milkman & Riis 2014).
  - Choice overload's mean effect is about zero, with high variance (Scheibehenne 2010).

## 4. Ranked mechanics (researcher's inference)

Mapping to Mindboard: people roster = givers, groups = tiers, energy cost = "recommended level", subtasks = chain steps, daily brief = HUD line, calendar = when/where cue.

Tags: [V] = view-layer on existing fields; [S] = schema change.

| # | Mechanic | Main risk | Ideas-doc mapping |
|---|---|---|---|
| 1 | **Camp + overdue triage** [V/S]: drop / move / do (max 3); the watch shows "CAMP until Mon 08:00" | permanent camping becomes avoidance; timebox it | idea 8 |
| 2 | **One tracked Now quest with a when/where cue** [V]: one-tap swap; after two deferrals, ask "split it?" | a wrong pick erodes trust | ideas 3, 14 |
| 3 | **Quest chains, one step visible, honest head start** [V] | planning as procrastination; fake credit; cap at 5 steps | idea 3 + subtasks |
| 4 | **Quest-giver attribution** [V once source and people link exist]: "From Marina · BRASA chat · Oct 14" | guilt; never show "waiting X days" | idea 2 |
| 5 | **Tiers: Main / Side / ≤2 dailies; only Main can be overdue** [V] | dailies become chores; everything labelled Main | idea 15 |
| 6 | **Guidance dial: Guided / Open / Off** [V]; deadline safety net always on | Off hides hard deadlines | idea 16 |
| 7 | **Weekly chronicle, not XP** | inflated trivia | idea 17 |
| 8 | **Rolling window, never a streak**: seven dots, no counter that resets | "0/7" shames | idea 17 |
| 9 | **Energy-matched suggestions**: on low-energy days, Now swaps to the lightest eligible task | no evidence found; keep energy self-set | idea 3 picker |
| 10 | **Timed/failable quests only for real deadlines**, with a no-penalty "missed" outcome; countdown only inside 72h | penalties breed avoidance | idea 4 |

**Backfire list:** XP or loot for completions, streak counters, overdue penalties, social damage, pinning everything.

## Risks

- **Order matters.** A Now line switched on before triage surfaces stale items and loses trust.
- **Agents propose; they never delete or mark tasks missed.**
- **The evidence is borrowed** from learning, health and consumer settings, and novelty fades. Measure completions per week.
- **Counting completions invites trivial tasks and relabelling.**

## Open questions for Lucca

1. Should the agent pick the Now quest, or only propose it?
2. Is a schema flag (tracked, camp_until) acceptable?
3. Can the watch write back (tap to complete)? Server-side it already can: `/api/watch/complete`.
