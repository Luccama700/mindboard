export type Group = {
  id: string;
  name: string;
  type: "course" | "project" | "work" | "personal";
  color: string;
  archived: boolean;
  created_at: string;
  google_calendar_id: string | null;
};
