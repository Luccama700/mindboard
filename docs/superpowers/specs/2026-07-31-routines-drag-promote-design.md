# Routines: drag anywhere, readable when short, promotable to real events

2026-07-31 · approved by Lucca · branch `ai/routines-drag-promote`

## Problems

1. A recurring occurrence timed by its rule (`due_time`, no slot) is deliberately
   non-draggable in the week view (`ruleTimedNoSlot` disables the drag), so the one
   obvious gesture — drag the routine to a new time — does nothing.
2. Routine blocks render two stacked text lines inside `overflow-hidden` with
   `min-height: 32px`; any occurrence ≤ 30 min clips its time line (and sometimes the
   title descenders).
3. There is no path from "routine occurrence" to "real Google Calendar event" — e.g. a
   daily lunch routine that becomes an actual lunch appointment with someone.

## Decisions (Lucca, 2026-07-31)

- Promotion **replaces** the routine that day: block disappears from the calendar, the
  occurrence is marked done, the real event stands in. Next occurrence is normal.
- Promotion goes through a **compact dialog**: title prefilled from the routine (set at
  creation only — renaming existing Google events stays out of scope), date, start
  time, duration.
- The event lands on the **group's linked calendar, else `primary`** — same rule as
  `pushTaskToCalendar`.

## Design

### 1. Drag fix

`RecurringTaskBlock` gives rule-timed occurrences drag data (same `rtask-slot` shape).
Dropping writes a **that-day slot override** via the existing `approveRecurringSlot`
path (`onScheduleRtask`). The rule's default time is untouched on other days; the
already-shipped "unpin ×" restores it. Cross-day drags keep the existing slot-drag
semantics (schedule target day, clear source slot — a no-op when the source had none).
Known pre-existing edge (unchanged): a slot dragged to a day where the rule does not
land will not render.

### 2. Short-block display

When the rendered block height is under 40px (< ~57 min at the current hour height),
both routine variants switch to a single truncated line — `↻ title · 12:30` (ghost:
`↻ title · ~12:30 · auto`) — with reduced vertical padding. Taller blocks keep the
two-line layout.

### 3. Promote to event

- **Migration `0046_recurring_slot_events.sql`**: `recurring_task_slots` gains nullable
  `gcal_event_id TEXT`, `gcal_calendar_id TEXT`. Applied to prod only on Lucca's
  explicit go.
- **Action `promoteRecurringToEvent({ ruleId, occurredOn, title, start, durationMin })`**
  in `app/actions/recurring-tasks.ts`: RLS-scoped rule load → group's linked calendar
  else `primary` → user timezone from prefs → `createEvent` → upsert slot row with the
  chosen time + event link → insert completion row → revalidate. Error surface mirrors
  `pushTaskToCalendar`.
- **Composition**: rtask items whose slot carries `gcal_event_id` are skipped —
  client-side (dashboard calendar build) and server-side (planning/schedule
  materialization) so busy math never double-counts the slot plus the real event.
- **UI**: selected-day list routine rows gain `make event →`, opening an inline panel
  (title, date, start, duration) in the existing edit-panel idiom; confirm calls the
  action; the refreshed fetch shows the Google event, which then edits and drags like
  any event.

## Testing

- `recurring-slots-action.test.ts`: promote validation cases (bad time, missing title,
  bad duration).
- Pure test for the promoted-exclusion rule in composition.
- Gates: lint 0 errors, full Vitest suite, prod build.

## Out of scope

Renaming existing Google events; MCP/assistant promote tool; stream-card promote
affordance; changing ghost-proposal behavior.
