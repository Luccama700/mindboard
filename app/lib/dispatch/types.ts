// Shared shape of a task dispatch — the "do this now" queue row the day
// stream writes and the home worker claims (spec:
// docs/superpowers/specs/2026-07-31-task-dispatch-design.md).
export type DispatchStatus =
  | "requested"
  | "claimed"
  | "running"
  | "done"
  | "failed";

export type TaskDispatch = {
  id: string;
  user_id: string;
  task_id: string;
  note: string;
  status: DispatchStatus;
  result_summary: string | null;
  created_at: string;
  claimed_at: string | null;
  finished_at: string | null;
};

export const DISPATCH_COLUMNS =
  "id, user_id, task_id, note, status, result_summary, created_at, claimed_at, finished_at";
