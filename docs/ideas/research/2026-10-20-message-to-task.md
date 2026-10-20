# Research brief: turning conversations into tasks (2026-10-20)

Produced by a deep-research agent for the WhatsApp→Mindboard pipeline and the quest-log ideas. Linked claims are cited; **[I]** marks the researcher's inference.

## Verdict

Build it as a **precision-first nudge generator**, not a classifier you trust.

- **Microsoft retired a near-identical feature.** Viva Insights' auto-suggested tasks from email/Teams commitments and requests ended in late Feb 2024, with no reason given (MC713042, https://mc.merill.net/message/MC713042).
- **Published detectors are only moderately precise.** They reach about 0.80–0.85 precision on English enterprise email, falling to 0.74 cross-corpus (Lampert 2010, https://aclanthology.org/N10-1142.pdf; Azarbonyad 2019, https://microsoft.com/en-us/research/uploads/prod/2019/01/AzarbonyadWSDM2019.pdf).
- **No evaluation exists for PT-BR personal chat.**

Recommended shape:
- a high threshold and a small daily cap
- tasks closed by *behaviour* (he sent something) rather than by reading text
- a reason recorded on every dismissal
- ideally a log-only week before writing tasks [I]

## Research

- **Requests in email** (Lampert et al., 664 Enron messages, κ 0.681).
  - Accuracy rose from 72% to 84% (P/R about 0.83–0.85) once quoted and forwarded text was stripped.
  - Errors: quoted text read as a new ask, formulaic "let me know if you have questions" (~5% of errors), and asks hidden in forwards.
  - Speech-act work: request F1 ~0.69 (Cohen et al. 2004, https://aclanthology.org/W04-3240/); n-gram selection cut errors ~26% (Carvalho & Cohen, https://aclanthology.org/W06-3406/).
- **Commitments** (the Cortana lineage; Azarbonyad et al.).
  - Sentence-level, α 0.73, in-domain P 0.79–0.82 / R 0.77–0.84; cross-corpus precision 0.82 → 0.74.
  - The authors call the task "inherently difficult, even for humans".
- **Chat** (Kalia et al., HP Labs).
  - Commitment spotting F ~0.90 in email and ~0.80 in IT chat.
  - Detecting *fulfilment* from text was poor in email.
  - In meeting dialogue (Purver et al.), humans agreed at only κ 0.36 and classifiers reached F ~0.3.
- **Reply prediction** (Yang et al., SIGIR'17).
  - 92–93% of enterprise emails got no reply; best AUC 0.72.
  - **Sender–recipient history was the strongest feature (0.69 alone).** Request/commitment scores were weaker (0.60) and bag-of-words ~0.51.
  - Asks doubled the reply rate.
- **Gmail Smart Reply's trigger** over-triggers on purpose, because a wasted suggestion is cheap (Kannan et al., https://arxiv.org/pdf/1606.04870). A wrong *task* is not cheap, so invert that trade-off.
- **To-do generation** (Smart To-Do, https://arxiv.org/pdf/2005.06282): ROUGE 0.63. Annotators docked items for missing context ("Which database?"). Candidates were filtered at commitment confidence ≥ 0.9.
- **LLM-era evidence.** No rigorous public benchmark exists for action items from personal chat. A Microsoft recap study (n=7, https://arxiv.org/abs/2307.15793) found people deleted tasks for three different reasons (done / redundant / wrong) and hesitated to delete at all. So "deleted untouched" alone is a noisy metric.

## Shipped products

| Product | Trigger | How it closes |
|---|---|---|
| Gmail nudges | unanswered received mail, and sent mail with no reply; on by default since 2018 | undocumented in the sources read |
| Superhuman | user picks AI-detected follow-ups, all external mail, or none | "Remind me" defaults to "if no reply" and cancels when a reply lands |
| Spark | user sets the follow-up at send time | — |
| Shortwave | you click "Add to Todo"; AI only suggests the name | — |
| Slack /remind, Motion | manual capture | — |
| Clay | reconnect reminders | resets on any interaction, messages included; suggestion count is capped |
| Monica | only what you asked: "not a smart assistant" | — |
| Dex | cadence reminders | interactions auto-logged |
| Apple priority notifications | rank existing items on-device | — (news AI summaries paused Jan 2025 after false alerts) |

**Pattern [I]:** automation survives where it *ranks existing items* or *tracks what you're waiting on*. Auto-creating tasks from other people's asks has stayed manual or been retired. Closure is nearly always "a reply or interaction arrived".

## WhatsApp practicalities

- **whatsmeow** is an unofficial Go library for the WhatsApp Web multi-device API. WhatsApp's Terms bar unauthorized or automated access.
- **Ban reports:** in whatsmeow issue #810 (2025-05 to 2026-07), operators with Brazilian clients report "Your account may be at risk" warnings and some bans even at low volume; one says idle, connected-only accounts got it too.
  - No ban rate is known. Read-only lowers the risk but doesn't remove it.
  - The bridge also sends (the failure pings to Lucca's own chat). Keep sends minimal.
- **The Business Platform can't read existing personal DMs.**
- **Privacy:**
  - Anthropic consumer plans may retain de-identified data for up to 5 years if "improve Claude" is on (https://privacy.claude.com/en/articles/10023548-how-long-do-you-store-my-data). Confirm the setting.
  - Brazil's LGPD exempts only "exclusivamente particulares e não econômicos" processing (Art. 4 I). Tutoring clients (Build Up) arguably don't qualify.
  - Friends and family haven't consented to an LLM reading their messages [I].
- **Time zones:**
  - Brazilian contacts are UTC-3 (no DST since 2019).
  - **BC adopts permanent UTC-7 on 2026-11-01** (Miss604, https://miss604.com/2026/03/bc-is-adopting-permanent-daylight-saving-time/). Stale tzdata on any machine would then shift times by an hour. Verify that the PC's Windows tz update and Python/Go tzdata pick this up.

## Design recommendations [I, basis cited]

1. **Rollout:** log-only for a week, recording candidates and whether he replied within 48h, then go live at 2 tasks/day, and raise to 5 after a week at ≥80% useful.
2. **Taxonomy:** reply-needed / you-committed / FYI / drop, plus **unsure** (no task) and a separate **waiting-on-them** list (digest only).
   - Pleasantries ("qualquer coisa me avisa") are drop.
   - Create only when the LLM says reply-needed **and** a rule fires (direct question, imperative or modal, quote-reply to his message, or @mention) **and** the sender is a known contact.
3. **Verbatim check:** the LLM returns the exact triggering sentence, and the task is discarded if that sentence isn't in the thread. This guards against hallucinated asks.
4. **Titles:** verb-first and self-contained, person + object + time ("Responder Ana: confirmar horário da aula de sexta"). Keep a one-line excerpt and a deep link.
5. **Threads:** classify the latest burst (same sender, ~15 min, plus the quoted parent) as one unit. Key = chat + open ask: update the existing task, never add a second one. **Remember dismissals by message id** so tomorrow's run doesn't resurrect them.
6. **Closing:**
   - Close on his next outbound message in that chat, only for pipeline-created tasks.
   - Downgrade deferrals ("vou ver", "depois te falo") to a snoozed follow-up; ignore reactions.
   - Auto-expire into an archive after 7–10 days.
   - Offer one-tap Done for asks handled by call or in person.
7. **Voice notes:** local Whisper turbo (~6 GB VRAM; the RTX 4070 Ti Super qualifies; Portuguese is supported). Gate to DM voice notes ≤ 90s. Images never create tasks.
8. **Priority and dates:**
   - Priority comes from relationship tier plus his reply latency to that contact (history beats text, per Yang), not from tone.
   - The LLM extracts the date *phrase*, and code resolves it against the message timestamp ("amanhã", "sexta", "semana que vem"). Python `dateparser` supports pt.
   - For an ambiguous weekday, keep the phrase and set no due date.
9. **Cadence:** a morning batch creates tasks; an optional 30–60-min sweep only closes them. Shrink the cap to 2 while 10+ tasks are overdue.
10. **Metrics:**
    - Log created, acted, edited, dismissed (wrong / done elsewhere / duplicate / not mine), and expired untouched.
    - Weekly useful rate = (acted + done elsewhere) / created.
    - Raise the threshold if wrong + expired exceeds 30% two weeks running.
    - Sample 20 dropped threads a week for misses.
11. **Prompt injection (OWASP LLM01):** message text is attacker-controlled.
    - Give the classifier **no tools**, force a JSON schema, and treat task titles as untrusted when agents later read them through MCP.

## Open questions for Lucca

1. Primary number or a spare for the bridge, and can he absorb a ban?
2. Model path for triage: subscription, API terms, or local?
3. Task titles in PT or EN?
4. Are tutoring clients in scope (LGPD)?
5. Will he hand-label about 100 threads to measure real precision?
