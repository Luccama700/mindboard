export type Task = {
  id: string;
  title: string;
  due_date: string | null;
  due_time: string | null; // "HH:MM" | "HH:MM:SS" — a time-block on the day
  duration_min: number | null;
  estimated_minutes: number | null;
  status: "todo" | "doing" | "done" | "missed";
  priority: "low" | "med" | "high";
  // Overnight-agent lifecycle (null = not an AI task); see docs/overnight-agent-plan.md.
  ai_state: "planned" | "approved" | "building" | "built" | "failed" | "declined" | null;
  notes: string | null;
  group_id: string | null;
  gcal_event_id: string | null;
  gcal_calendar_id: string | null;
  created_at: string;
  completed_at: string | null;
  missed_at: string | null;
  // 1..5, a second axis beside estimated_minutes (migration 0053). Informational
  // and a planning input — never summed into a score.
  energy_cost: number | null;
  // 'ai' = assigned at creation (outlined dots), 'user' = tapped (filled dots).
  energy_source: "ai" | "user" | null;
  // Depth-one decomposition: the parent is the thing owed, children are what
  // the stream shows. not_before + due_date is a child's planning window.
  parent_task_id: string | null;
  not_before: string | null;
};

export type TaskWithGroup = Task & {
  group_name: string | null;
  group_color: string | null;
};

export const TASK_COLUMNS =
  "id, title, due_date, due_time, duration_min, status, priority, ai_state, notes, group_id, gcal_event_id, gcal_calendar_id, created_at, completed_at, estimated_minutes, missed_at, energy_cost, energy_source, parent_task_id, not_before";
