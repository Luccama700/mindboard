export type Task = {
  id: string;
  title: string;
  due_date: string | null;
  due_time: string | null; // "HH:MM" | "HH:MM:SS" — a time-block on the day
  duration_min: number | null;
  status: "todo" | "doing" | "done";
  priority: "low" | "med" | "high";
  notes: string | null;
  group_id: string | null;
  gcal_event_id: string | null;
  gcal_calendar_id: string | null;
  created_at: string;
  completed_at: string | null;
};

export type TaskWithGroup = Task & {
  group_name: string | null;
  group_color: string | null;
};

export const TASK_COLUMNS =
  "id, title, due_date, due_time, duration_min, status, priority, notes, group_id, gcal_event_id, gcal_calendar_id, created_at, completed_at";
