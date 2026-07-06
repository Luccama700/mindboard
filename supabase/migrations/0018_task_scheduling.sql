-- Task scheduling depth: optional due time + duration turn a task into a
-- time-block on the week view; the gcal columns record a push of that block
-- to Google Calendar (one-way: Mindboard creates/reschedules, Google never
-- writes task truth). Both gcal columns are needed — events.patch addresses
-- (calendarId, eventId), and the group's calendar link can change later.
alter table public.tasks
  add column due_time         time,
  add column duration_min     integer check (duration_min > 0),
  add column gcal_event_id    text,
  add column gcal_calendar_id text;
