# Second opinion: GPT-5.6-sol critique of the quest-log ideas (2026-10-20, headless, read-only)

## 1. The 3 ideas most likely to change the owner's day-to-day behavior, and why.

1. **#3 Tracked quest.** This is the clearest expression of the north star. Mindboard already calculates urgency and presents several elevated cards, but still leaves the owner to choose among them (`app/lib/snapshots/urgency.ts`, `app/lib/snapshots/stream.ts`). One persistent objective, with a plain reason such as “fits your 40-minute gap,” removes that decision. Start with manual tracking plus a stable, explainable auto-pick; defer the three-item loadout until the single-item mechanic earns trust.

2. **#14 Plan chips.** Turning “I should do this” into “Tuesday at 10,” “after dinner,” or “when I see Carla” is more behaviorally meaningful than another priority score. Existing free-gap and advisory-placement machinery provides a strong implementation base (`app/lib/snapshots/schedule.ts`, `app/lib/snapshots/gap-plan.ts`). Keep the cue chips, but do not hide uncued work in an “Unplanned” tray; that would create another inbox capable of rotting invisibly.

3. **#1 Quest anatomy.** Stable title, current objective, and volatile intel would improve every task glance, especially on the watch. Today the watch and stream effectively treat `title` as both identity and instruction (`app/lib/watch/today.ts`, `app/_components/types.ts`). The schema matters less than changing every agent/tool description so status updates cannot keep replacing the action. Combined later with #2’s go link, this turns a report into an executable prompt.

## 2. Ideas that are weak, redundant with features that already exist in the code (cite file paths), or risky, with the specific reason for each.

- **#2’s unique `(source_kind, source_ref)` index is too strict.** One WhatsApp message can contain multiple independent asks. Deduplicate on source plus an extraction-level key, not the entire message reference.
- **#4 and #7 depend on an unreliable outbound channel.** Bridge expiry or a sleeping home PC could silently suppress the most important escalation. They should not ship before channel health is machine-readable.
- **#6 overreaches by turning every outage into a life quest.** Worker presence and job heartbeats already exist in `app/api/worker/route.ts`, `worker/worker.py`, and `supabase/migrations/0027_worker_jobs.sql`. Generalize that telemetry, but put incidents in a compact health surface; automatically creating and closing tasks bypasses propose→confirm and could pollute the HUD.
- **#7 promises `undo` without supporting infrastructure.** `app/lib/mcp/audit.ts` stores proposal inputs and results, not universal before-state or inverse operations. UI, watch, and worker writes are not all reversible through that log.
- **#9 is premature.** `ai_audit_log` cannot yet reliably distinguish Canvas, WhatsApp, email, or collector versions. “Precision” computed before #2 has produced stable provenance would be false precision.
- **#10 substantially overlaps People attention and open loops** in `app/lib/snapshots/people.ts`. Calendar-person matching is also weak because the current Google event shape does not provide a dependable attendee identity (`utils/google/calendar.ts`).
- **#11 models promises incorrectly.** The promisee is not necessarily the quest giver, and an LLM reading a later message cannot safely infer fulfilment. Keep “promise” as a source classification or view before creating a lifecycle.
- **#12’s data feature already exists:** `saveDailyLog` in `app/actions/daily-log.ts`, `DailyLogSheet` in `app/_components/stream-sheets.tsx`, and MCP `log_daily` in `app/lib/mcp/writes.ts`. Only the watch, Shortcut, and WhatsApp capture surfaces are new.
- **#13 and #16 are premature structure.** Goals already support weekly horizons, while a guidance setting adds preference complexity before Guided mode has proved useful.
- **#15 risks hiding real commitments.** “Only Main can be overdue” converts a classification guess into truth suppression. Keep one factual overdue count and soften presentation for side quests instead.

## 3. Up to 4 missing ideas that fit the north star. Give each a one-paragraph design and an implementation sketch against this codebase.

- **WhatsApp extraction inbox.** Collector results should arrive as one reviewable receipt containing message preview, proposed objective, giver, action link, confidence, and merge/dismiss controls. Confirmed items enter the HUD; rejected examples improve later prompts. Reuse the existing proposal/audit flow in `app/lib/mcp/audit.ts` and proposal-card UI rather than creating tasks immediately.

- **Waiting-on state.** Many chat-derived quests are temporarily unactionable. Add `waiting_on_person_id`, `waiting_reason`, and `follow_up_at`; exclude them from fit-now selection, then resurface them when the timer expires or before contact with that person. Thread this through task validation, `streamSnapshot`, People dossiers, and the tracked-quest picker.

- **Stuck-loop detector.** Detect repeated title/intel revisions without completion or objective change—the exact Canvas failure described in the document. Use audit history plus `intel_updated_at`; after a threshold, replace further status churn with “What is blocking this?” and offer Go, Shrink, Hand off, or Drop.

- **Tracked-quest lease.** Persist an auto-selected quest and its reason until completion, explicit rejection, or invalidation. A purely recomputed picker will jitter whenever calendar gaps change. Store the lease alongside `tracked_task_id`; completing or rejecting it selects a successor and explains why the HUD changed.

## 4. Any change you would make to the suggested sequencing.

Add a **zero-wave for correctness**: fix the missing `declined` MCP enum in `app/api/mcp/[transport]/route.ts`, reconcile the disagreeing counters, and expose machine-readable run failures.

Then sequence: **#5 workshop split → lightweight #8 Camp/lateness cleanup → #1 anatomy → #2 provenance/go links → #14 cues → minimal leased #3 tracked quest.** This follows the document’s own later warning that tracking an untriaged pile destroys trust.

Next ship generalized **#6 health**, then #4 escalation and #7 console. Only after provenance and usage data accumulate should #9, #10, #11, #13, #16, and #17 be considered. The current sequencing also needs updating because it omits ideas #14–17 entirely.
