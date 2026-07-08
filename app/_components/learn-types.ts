export type Course = {
  id: string;
  name: string;
  code: string | null;
  term: string | null;
  color: string;
  archived: boolean;
  created_at: string;
};

export type SourceKind = "pdf" | "markdown" | "text" | "url";

export type SourceStatus =
  | "registered"
  | "uploaded"
  | "queued"
  | "converting"
  | "converted"
  | "failed";

export type CourseSource = {
  id: string;
  course_id: string;
  title: string;
  kind: SourceKind;
  status: SourceStatus;
  storage_path: string | null;
  vault_path: string | null;
  page_count: number | null;
  error: string | null;
  created_at: string;
};

export type EpisodeStatus =
  | "scripting"
  | "rendering"
  | "queued"
  | "done"
  | "failed";

export type AudioEpisode = {
  id: string;
  course_id: string;
  title: string;
  source_ids: string[];
  engine: "gemini" | "vibevoice";
  flavor: "deep-dive" | "brief" | "debate" | "solo";
  status: EpisodeStatus;
  duration_sec: number | null;
  storage_path: string | null;
  error: string | null;
  created_at: string;
};

export const EPISODE_COLUMNS =
  "id, course_id, title, source_ids, engine, flavor, status, duration_sec, storage_path, error, created_at";

export const COURSE_COLUMNS =
  "id, name, code, term, color, archived, created_at";

export const SOURCE_COLUMNS =
  "id, course_id, title, kind, status, storage_path, vault_path, page_count, error, created_at";

// One human-readable line per source status, shared by /learn and receipts.
export function sourceStatusLabel(source: CourseSource): string {
  switch (source.status) {
    case "registered":
      return source.kind === "pdf" ? "awaiting file" : "registered";
    case "uploaded":
      return "ready to convert";
    case "queued":
      return "queued for home pc";
    case "converting":
      return "converting…";
    case "converted":
      return "in vault";
    case "failed":
      return source.error ? `failed — ${source.error}` : "failed";
  }
}
