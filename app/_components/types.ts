export type Task = {
  id: string;
  title: string;
  due_date: string | null;
  status: "todo" | "doing" | "done";
  priority: "low" | "med" | "high";
  group_id: string | null;
  created_at: string;
  completed_at: string | null;
};

export type TaskWithGroup = Task & {
  group_name: string | null;
  group_color: string | null;
};
