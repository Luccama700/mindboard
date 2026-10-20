# Research brief: why intentions get forgotten, and which cues work (2026-10-20)

Produced by a deep-research agent for the quest-log ideas (`../2026-10-20-quest-log.md`).

Evidence tags:
- **[S]** meta-analysis or many replications
- **[M]** a solid single study or small field trial
- **[W]** thin or inferred
- **[C]** contested or failed replication

## Verdict

The pattern looks more like a cueing-and-reset problem than a willpower one. That's a hypothesis, untested on Lucca's data.

A task read in WhatsApp arrives with a who but no when or where, so recall falls back on time-based memory, the weaker mode. In a two-week office study, time-cued tasks were thought about more but forgotten more than place-cued ones (Sellen et al., https://www.microsoft.com/en-us/research/?p=286043). The overdue pile likely adds noise, and nothing resets it.

- **Cheapest path:** a fresh-start triage on a Monday, a one-tap when/where chip on every agent-captured task, and showing only "Now" plus 2 next items.
- **Biggest constraint:** nudges decay. One trial's effect was gone by day 28. Field plan-prompts move behaviour a few points, not by the lab-sized d = .65.

## 1. Prospective memory

- **Event-based vs time-based [S].** Age deficits appeared on a time-based task, presumed to need self-initiated retrieval, but not on an event-based one (Einstein 1995, https://doi.org/10.1037/0278-7393.21.4.996).
- **Cue focality [S, lab].** Focal cues overlap with what you're already processing and can be detected largely automatically. Nonfocal cues require monitoring (Einstein 2005, https://doi.org/10.1037/0096-3445.134.3.327; definitions at https://www.frontiersin.org/articles/10.3389/fpsyg.2024.1279144/full).
  - Inference [W]: meeting the person a task is about should act as a focal cue.
- **Intention superiority [M].** Unfinished intentions speed related responses, and completed ones slow them (Goschke & Kuhl 1993; Marsh 1998, https://doi.org/10.1037/0278-7393.24.2.350). This argues for explicitly closing loops.
- **Zeigarnik [C].** A 2025 meta-analysis found no memory advantage for unfinished tasks. The pull to resume (Ovsiankina) held (Ghibellini & Meier, https://doi.org/10.1057/s41599-025-05000-w). Unfinished tasks won't remember themselves; they pull when re-encountered.
- **Plan-making [W–M].** Specific plans removed the intrusive thoughts that unfinished goals cause, mediated by how earnest the plan was (Masicampo & Baumeister 2011, https://doi.org/10.1037/a0024192).
  - It's a single lab, and no direct replication was found.

## 2. Implementation intentions

- **Lab size [S, lab-skewed].** d = .65 on goal attainment across 94 tests (Gollwitzer & Sheeran 2006, https://doi.org/10.1016/S0065-2601%2806%2938002-1).
- **For prospective memory specifically:** d = .445 in young adults, .59 for verbal-plus-imagery plans (Chen 2015).
- **Field reality [M].** In a flu-shot mailing (N = 3,272), a date-only prompt had no significant effect, while date + time added 4.2 points (Milkman 2011, https://pmc.ncbi.nlm.nih.gov/articles/PMC3127912). Expect single-digit points. A cue or a time matters, not just a date.
- **Cheap elicitation:** the agent drafts 3–4 chips from the message. Options are a person, a place, a routine ("after dinner"), a clock slot, or drop. One tap, plus an optional five-second "picture it" line.

## 3. Reminder efficacy

No study tests personal task-app reminders directly; the evidence below is borrowed.

- **Plain reminders work when the person already wants the behaviour [M].** Text reminders gave an adherence odds ratio of 2.11 across 16 RCTs, N = 2,742 (Thakkar 2016).
- **Interruption cost [M]:**
  - A notification alone disrupted attention about as much as using the phone (Stothart 2015, https://doi.org/10.1037/xhp0000100).
  - A week of alerts raised inattention and hyperactivity, N = 221 (Kushlev 2016, https://doi.org/10.1145/2858036.2858359).
  - Batching to 3 a day beat the status quo, and no notifications at all raised anxiety, N = 237 (Fitz 2019).
  - Clinicians accepted 30% fewer reminders per extra reminder per encounter (Ancker 2017). Analogy only [W].
- **Context-aware [M to W].** HeartSteps (n = 37): tailored suggestions raised steps 66% at first, then faded about 2% a day to zero by day 28, with users calling them "boring after 2–4 weeks" (Klasnja 2019, https://pmc.ncbi.nlm.nih.gov/articles/PMC6401341).
  - **Person-cued reminders have no direct test.** That idea extrapolates from focality theory and from place cues beating time cues.
- **Offloading [M].** People offload when they believe it's more efficient (Risko & Gilbert 2016, https://pubmed.ncbi.nlm.nih.gov/27542527/).
  - Setting a reminder predicted fulfilling the intention (Gilbert 2015).
  - Offloading barely changed later unaided ability, but raised later reminder-setting (Scarampi & Gilbert 2020). The risk is dependence, not memory decay.
  - The "Google effect" is [C]: its Stroop test failed to replicate (Camerer 2018).

## 4. Initiation and procrastination

- **Temporal motivation theory [S, correlational].** Aversiveness, delay, low self-efficacy, impulsiveness and low organization predict procrastination, across 691 correlations (Steel 2007, https://doi.org/10.1037/0033-2909.133.1.65). The levers are clearer tasks, nearer cues and smaller first steps.
- **Next-action framing [W].** No controlled test exists. The closest evidence is that unpacking a task into components gives longer, more accurate estimates (Kruger & Evans 2004).
- **Planning fallacy [M].** Thesis students predicted 33.9 days and took 55.5 (Buehler 1994). Underestimation isn't universal (Halkjelsvik & Jørgensen 2012).
- **Time of day and energy [W/C].** Synchrony effects appear in only 45% of young-adult studies (Chauhan 2025). The depleting-battery model is [C]: the multilab effect was d = 0.04 (Hagger 2016). Learn his finishing windows from data instead.
- **"What-the-hell" and overdue piles [W].** Breaking a goal can worsen later performance (Soman & Cheema 2004). No study of overdue to-do lists exists.
  - Self-forgiveness predicted less later procrastination (Wohl 2010, observational).
- **Fresh start [M].** Goal activity rises after week, month and semester starts (Dai, Milkman & Riis 2014, https://doi.org/10.1287/mnsc.2014.1901).
  - Fresh-start framing gave about +25% savings in a field RCT of N = 6,082 (Beshears 2021).
  - In a 61,293-person gym megastudy, the top intervention rewarded returning after a missed workout (+27%). Only 8% of interventions persisted after the program ended (Milkman 2021, https://doi.org/10.1038/s41586-021-04128-4).

## 5. ADHD-informed design (no diagnosis assumed)

- **Time-blindness** differences are real: medium-sized deficits across 55 studies (Marx 2021).
- **Visible timers:** vendor claims only.
- **Body doubling:** a positive survey, but no controlled trials.
- **Skills-based CBT** for adult ADHD: g = .65 on symptoms (Knouse 2017).

## 6. Ten mechanics, mapped to the ideas doc

| # | Mechanic | Expected effect | Ideas-doc mapping |
|---|---|---|---|
| 1 | Plan chip at capture | lab d = .65; field +4.2 pts | idea 14 |
| 2 | Person, place and time cues | person cue untested [W] | ideas 10, 14 |
| 3 | Next-action titles | unknown [W] | idea 1 (`objective`) |
| 4 | Monday fresh-start triage | about +25% in one field RCT, other domain | idea 8 |
| 5 | Show Now + 2 | unknown [W]; choice overload is [C] | idea 3 (tracked quest + loadout) |
| 6 | Notification budget (about 3 a day) | batching beat status quo, N = 237 | cross-cutting rule; ideas 4, 7 |
| 7 | Closed-loop reminders (Done / Re-cue / Drop) | text-reminder OR 2.11 | cross-cutting rule |
| 8 | Reference-class duration estimates | planning fallacy correction | future (needs history) |
| 9 | Learned energy windows | weak [W] | future, with task-energy |
| 10 | Countdowns, optional co-work | unknown [W] | future |

**Suggested rollout from the brief:**
- 1st Monday: mechanics 1 + 4.
- Next week (month start): mechanics 5 + 6.
- Then: mechanics 2 + 7.
- Two weeks later: review the data and cut what didn't move done-per-week.

Metrics: planned within 24h of capture, done within 7 days, overdue count, and pushes acted on within 30 minutes.

## Open questions for Lucca

1. Which of the overdue items are external obligations (clients, tutoring, club) and which are self-set?
2. Where does he actually act: phone push, watch, or the morning brief?
3. Is he OK with agents rewriting titles and linking WhatsApp senders to calendar attendees?
4. What's the success metric: done per week, overdue count, or WhatsApp-to-plan delay?
