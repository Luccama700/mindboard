# Task Dispatch ("do this now") — Design

Date: 2026-07-31
Status: approved (day-view button · one-shot note, chat-ready shape · full worker powers · immediate run)

## Overview

From the day/home view, any open task gets a dispatch affordance: click → type a
note → send. The note lands in the task's notes, the home worker claims the
dispatch within ~5 minutes (or instantly via a manual `run.mjs` invocation) and
runs it as a full-power headless session, and the result is written back into
the task notes. One-shot in v1; the payload is shaped as a thread root so a
per-task chat can bolt on later without rework.

## Dispatch record

A `dispatch` object rides the existing agent-run request stamp:

```json
{
  "id": "dsp_<nanoid>",
  "taskId": "<task id>",
  "note": "<operator note text>",
  "createdAt": "<iso>",
  "status": "requested | claimed | running | done | failed",
  "resultSummary": "<short text, set on completion>"
}
```

- Human-readable trail lives in the task notes as appended sections:
  `## Operator note (<timestamp>)` on send, `## Agent result (<timestamp>)`
  on completion. Notes remain the human source of truth; the record drives
  the machinery.
- Future chat thread = messages hanging off `dispatch.id`.

## UI (day/home view)

- Each not-done task row: small `✦ do it` button (existing `✦` design
  language).
- Click → modal: task title, one textarea ("anything the agent should know or
  do?"), send.
- On send: row badges `✦ dispatched`; flips to `✦ done — see notes` /
  `✦ failed` on normal data refresh. No chat surface, no streaming, no new
  pages in v1.

## API

One new endpoint (PWA session auth; PAT parity for MCP). On send, atomically:

1. append the operator note section to the task notes,
2. mark the task ai-approved,
3. stamp the agent-run request with the dispatch payload.

Idempotent per dispatch id.

## Worker (run.mjs)

- The existing 5-min poll (`--if-requested`) claims the stamp. A stamp carrying
  a dispatch enters targeted mode (`--task <id>`) instead of the full sweep.
- Targeted mode: fetch that one task; compose prompt from title + notes +
  operator note + `capabilities.md`; spawn a **Track C "dispatched" executor**:
  headless Claude Code with the Track A-style permission profile (shell,
  files, browser) rather than Track B's fetch-only profile.
- One dispatch at a time (existing lockfile/claim semantics).
- Budget cap `OVERNIGHT_DISPATCH_BUDGET_USD` (default 10), hard timeout,
  logs under `overnight/logs/` (overnight-watcher already reads these).
- `--task <id>` is also directly invocable for watch-it-work runs:
  `node overnight/run.mjs --task 123`.

## Guardrails (explicit in executor prompt + permission profile)

- **Drafts-never-submit**: the executor prepares, researches, builds, and
  writes results back. It does not send, sign, purchase, publish, or submit
  anything in the operator's name. Graded coursework submission specifically
  stays a human action.
- No credential handling.
- Never works on `main`; code changes go to worktrees/`ai/*` branches like
  Track A.
- Browser use allowed; form-submission-type actions are out of scope for the
  executor profile.

## Errors

- Failed run → `## Agent result — failed` in notes + log pointer.
- Budget/timeout → partial summary, marked as such.
- Claimed-but-dead (machine asleep, crash): stale after 60 min, re-claimable;
  staleness surfaces in the morning watcher report.
- Poll offline → dispatch waits; badge stays `✦ dispatched`.

## Testing

- Unit: payload validation, note-append idempotency, status transitions.
- Integration: `--task <id> --dry-run` prints composed prompt + permission
  profile without spawning.
- Manual e2e: dispatch a trivial task ("write hello.md in the sandbox repo")
  end to end before pointing it at anything real.
