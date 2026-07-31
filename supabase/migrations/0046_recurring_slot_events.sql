-- Promotion of a recurring occurrence into a real Google Calendar event
-- (docs/superpowers/specs/2026-07-31-routines-drag-promote-design.md).
-- A slot row carrying gcal_event_id means "this day's occurrence is materialized
-- as that event": composition skips the rtask item and the event stands in.
ALTER TABLE recurring_task_slots
  ADD COLUMN gcal_event_id TEXT,
  ADD COLUMN gcal_calendar_id TEXT;
