---
description: Adversarial Codex (Integrator) review of the current changes before shipping — the Rocket Fuel co-founder loop
argument-hint: "[--base <branch> | --uncommitted | --commit <sha>] [focus notes]"
---

# /rocket-review — Integrator gate before shipping

You (Claude/Opus) are the **Visionary**: you own the product intent, the architecture, and the change on the table. **Codex (GPT-5.5) is the Integrator**: an adversarial, read-only co-founder whose job is to catch what will actually break before it ships. Different model, different failure modes — that is the point. The Integrator *proposes*; the Visionary *decides and ships*. Run this loop before every non-trivial ship.

Arguments passed to this command: `$ARGUMENTS`

## The loop

1. **Make the change reviewable.** Ensure the work you want reviewed is on disk. If `$ARGUMENTS` contains `--base <branch>`, make sure your changes are committed to the current branch first (base-diff mode reviews committed history). Otherwise the default reviews the uncommitted working tree.

2. **Summon the Integrator.** Run the wrapper from the repo root and read its full output:
   ```bash
   bash .claude/codex/review.sh $ARGUMENTS
   ```
   (No args → reviews uncommitted changes. It pins the model, runs Codex **read-only**, and saves the review under `.claude/codex/reviews/`.) A thorough review can take a minute or two at `high` effort; set `CODEX_REVIEW_EFFORT=xhigh` before the run for maximum rigor on a final pre-ship pass.

3. **Adjudicate every finding as the Visionary.** Do **not** reflexively accept or reject. For each finding, decide and state your call in one line:
   - **Accept** → it's a real defect or a fair intent-mismatch; fix it.
   - **Reject** → give a concrete reason (wrong, out of scope for this change, contradicts a repo rule, or a false positive). The Integrator is adversarial and *will* be wrong sometimes; that's expected. But a rejection needs a reason, not a shrug.
   - **Defer** → real but out of scope for this ship; capture it as a task.
   Weigh each finding against product intent and the repo's hard rules in `AGENTS.md` (RLS, timezone correctness, narrow changes, propose→confirm for AI writes, unit tests for pure logic).

4. **Apply the accepted fixes** yourself (you are still the one writing the code).

5. **Loop until clean.** If you fixed anything the Integrator rated BLOCKER or HIGH, run `review.sh` again. Repeat until Codex returns `VERDICT: SHIP`, or until every remaining finding has been consciously rejected/deferred with a stated reason.

6. **Ship.** Run the repo gates — `npm run lint` and `npm run test` (and `npm run build` for anything non-trivial) — then commit/push per the user's instruction. In your final summary to the user, report: what the Integrator flagged, what you accepted vs. rejected (with reasons), and the final verdict.

## Guardrails
- Codex is **read-only** here — it never edits your files, and it runs sandboxed so it cannot touch secrets. All code changes stay in your hands.
- The Integrator serves the ship decision; it does not own it. Rocket Fuel only works when the Visionary genuinely lets the work be challenged **and** holds the final call.
