import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceClient } from "@/utils/supabase/service";
import { readVaultCredentials } from "@/app/lib/brain/vault";
import {
  createVaultFileWithRetry,
  VAULT_NOT_CONFIGURED_MESSAGE,
} from "./capture";
import {
  assembleParts,
  buildSourceDocument,
  courseSourcePath,
  validateBeginUpload,
  validatePart,
  vancouverStamp,
  type SourcePart,
} from "./course-ops";
import type { Result } from "./validate";
import {
  COURSE_COLUMNS,
  SOURCE_COLUMNS,
  type Course,
  type CourseSource,
} from "@/app/_components/learn-types";

// Server glue for the course-source ingestion tools, shared by the MCP server
// (service client scoped to the owner) and the in-app assistant (session
// client). The vault write is fenced create-only under Courses/ — the second
// deliberate direct-write exception after capture_to_brain's Inbox/.

async function loadCourses(
  supabase: SupabaseClient,
  userId: string,
): Promise<Course[]> {
  const { data } = await supabase
    .from("courses")
    .select(COURSE_COLUMNS)
    .eq("user_id", userId)
    .eq("archived", false)
    .order("created_at", { ascending: false });
  return (data ?? []) as Course[];
}

// Exact id → exact name (case-insensitive) → unique substring; ambiguity
// fails with candidates, matching the update_stock resolution semantics.
export function resolveCourse(
  courses: Course[],
  ref: string,
): Result<Course> {
  const trimmed = ref.trim();
  if (!trimmed) return { ok: false, error: "course is required" };

  const byId = courses.find((c) => c.id === trimmed);
  if (byId) return { ok: true, value: byId };

  const lowered = trimmed.toLowerCase();
  const exact = courses.filter((c) => c.name.toLowerCase() === lowered);
  if (exact.length === 1) return { ok: true, value: exact[0] };

  const partial = courses.filter(
    (c) =>
      c.name.toLowerCase().includes(lowered) ||
      (c.code ?? "").toLowerCase() === lowered,
  );
  if (partial.length === 1) return { ok: true, value: partial[0] };
  if (partial.length > 1) {
    return {
      ok: false,
      error: `"${trimmed}" matches several courses: ${partial
        .map((c) => c.name)
        .join(", ")} — use the id from list_courses`,
    };
  }
  return {
    ok: false,
    error: `no course matches "${trimmed}" — see list_courses (or create the course in /learn first)`,
  };
}

export async function listCoursesFor(
  supabase: SupabaseClient,
  userId: string,
): Promise<
  Result<{
    courses: (Pick<Course, "id" | "name" | "code" | "term"> & {
      sources: Pick<CourseSource, "id" | "title" | "kind" | "status" | "vault_path">[];
    })[];
  }>
> {
  const courses = await loadCourses(supabase, userId);
  const { data: sources } = await supabase
    .from("course_sources")
    .select(SOURCE_COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  const bySource = (sources ?? []) as CourseSource[];
  return {
    ok: true,
    value: {
      courses: courses.map((course) => ({
        id: course.id,
        name: course.name,
        code: course.code,
        term: course.term,
        sources: bySource
          .filter((s) => s.course_id === course.id)
          .map((s) => ({
            id: s.id,
            title: s.title,
            kind: s.kind,
            status: s.status,
            vault_path: s.vault_path,
          })),
      })),
    },
  };
}

export type BeginUploadOutcome = {
  source_id: string;
  course: string;
  title: string;
  instructions: string;
};

export async function beginSourceUploadFor(
  supabase: SupabaseClient,
  userId: string,
  raw: {
    course?: unknown;
    source_id?: unknown;
    title?: unknown;
    page_count?: unknown;
  },
): Promise<Result<BeginUploadOutcome>> {
  const courses = await loadCourses(supabase, userId);

  // Attach markdown to an existing source (a PDF already uploaded in /learn).
  if (typeof raw.source_id === "string" && raw.source_id.trim()) {
    const { data: existing } = await supabase
      .from("course_sources")
      .select(SOURCE_COLUMNS)
      .eq("id", raw.source_id.trim())
      .eq("user_id", userId)
      .maybeSingle();
    if (!existing) return { ok: false, error: "source not found — see list_courses" };
    const source = existing as CourseSource;
    if (source.status === "converted") {
      return {
        ok: false,
        error: `"${source.title}" is already converted (${source.vault_path}) — delete and re-add it to reconvert`,
      };
    }
    const course = courses.find((c) => c.id === source.course_id);
    if (!course) return { ok: false, error: "that source's course is archived" };

    const { error } = await supabase
      .from("course_sources")
      .update({ status: "converting", error: null })
      .eq("id", source.id)
      .eq("user_id", userId);
    if (error) return { ok: false, error: error.message };

    await supabase
      .from("course_source_parts")
      .delete()
      .eq("source_id", source.id)
      .eq("user_id", userId);

    return {
      ok: true,
      value: {
        source_id: source.id,
        course: course.name,
        title: source.title,
        instructions: partInstructions(),
      },
    };
  }

  const courseRef = typeof raw.course === "string" ? raw.course : "";
  const resolved = resolveCourse(courses, courseRef);
  if (!resolved.ok) return resolved;

  const parsed = validateBeginUpload(raw);
  if (!parsed.ok) return parsed;

  const { data, error } = await supabase
    .from("course_sources")
    .insert({
      user_id: userId,
      course_id: resolved.value.id,
      title: parsed.value.title,
      kind: "markdown",
      status: "converting",
      page_count: parsed.value.pageCount,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  return {
    ok: true,
    value: {
      source_id: data.id as string,
      course: resolved.value.name,
      title: parsed.value.title,
      instructions: partInstructions(),
    },
  };
}

function partInstructions(): string {
  return "Transcribe the document verbatim to GitHub-flavored markdown: $…$ / $$…$$ LaTeX for math, markdown tables, <!-- p.N --> comment before each page's content. Do not summarize or skip content. Send sequential parts (part_index 1, 2, …, ≤20000 chars each) via append_source_markdown, then call finalize_source.";
}

export async function appendSourcePartFor(
  supabase: SupabaseClient,
  userId: string,
  raw: { source_id?: unknown; part_index?: unknown; markdown?: unknown },
): Promise<Result<{ source_id: string; part_index: number; parts_so_far: number }>> {
  const sourceId = typeof raw.source_id === "string" ? raw.source_id.trim() : "";
  if (!sourceId) return { ok: false, error: "source_id is required" };

  const parsed = validatePart(raw);
  if (!parsed.ok) return parsed;

  const { data: source } = await supabase
    .from("course_sources")
    .select("id, status")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!source) return { ok: false, error: "source not found — call begin_source_upload first" };
  if (source.status !== "converting") {
    return {
      ok: false,
      error: `source is ${source.status}, not accepting parts — call begin_source_upload first`,
    };
  }

  const { error } = await supabase.from("course_source_parts").upsert(
    {
      user_id: userId,
      source_id: sourceId,
      part_index: parsed.value.part_index,
      markdown: parsed.value.markdown,
    },
    { onConflict: "source_id,part_index" },
  );
  if (error) return { ok: false, error: error.message };

  const { count } = await supabase
    .from("course_source_parts")
    .select("id", { count: "exact", head: true })
    .eq("source_id", sourceId)
    .eq("user_id", userId);

  return {
    ok: true,
    value: {
      source_id: sourceId,
      part_index: parsed.value.part_index,
      parts_so_far: count ?? 0,
    },
  };
}

export async function finalizeSourceFor(
  supabase: SupabaseClient,
  userId: string,
  raw: { source_id?: unknown },
  via: string,
): Promise<Result<{ vault_path: string; message: string }>> {
  const sourceId = typeof raw.source_id === "string" ? raw.source_id.trim() : "";
  if (!sourceId) return { ok: false, error: "source_id is required" };

  const { data: sourceRow } = await supabase
    .from("course_sources")
    .select(SOURCE_COLUMNS)
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!sourceRow) return { ok: false, error: "source not found" };
  const source = sourceRow as CourseSource;
  if (source.status !== "converting") {
    return { ok: false, error: `source is ${source.status}, nothing to finalize` };
  }

  const { data: courseRow } = await supabase
    .from("courses")
    .select("name")
    .eq("id", source.course_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!courseRow) return { ok: false, error: "course not found" };
  const courseName = courseRow.name as string;

  const { data: partRows } = await supabase
    .from("course_source_parts")
    .select("part_index, markdown")
    .eq("source_id", sourceId)
    .eq("user_id", userId)
    .order("part_index", { ascending: true });

  const assembled = assembleParts((partRows ?? []) as SourcePart[]);
  if (!assembled.ok) return assembled;

  const credentials = await readVaultCredentials(supabase, userId);
  if (!credentials) return { ok: false, error: VAULT_NOT_CONFIGURED_MESSAGE };

  const stamp = vancouverStamp(new Date());
  const document = buildSourceDocument({
    courseName,
    title: source.title,
    kind: source.kind,
    pageCount: source.page_count,
    markdown: assembled.value,
    stamp,
    via,
  });

  const pathCheck = courseSourcePath(courseName, source.title, 1);
  if (!pathCheck.ok) return pathCheck;

  const written = await createVaultFileWithRetry(
    credentials,
    (attempt) => {
      const path = courseSourcePath(courseName, source.title, attempt);
      // Sanitization was validated above; attempts only vary the suffix.
      return path.ok ? path.value : pathCheck.value;
    },
    document,
    `Course source: ${courseName} — ${source.title} (via ${via})`,
  );
  if (!written.ok) {
    await supabase
      .from("course_sources")
      .update({ error: written.error })
      .eq("id", sourceId)
      .eq("user_id", userId);
    return written;
  }

  const { error: updateError } = await supabase
    .from("course_sources")
    .update({ status: "converted", vault_path: written.value.path, error: null })
    .eq("id", sourceId)
    .eq("user_id", userId);
  if (updateError) return { ok: false, error: updateError.message };

  await supabase
    .from("course_source_parts")
    .delete()
    .eq("source_id", sourceId)
    .eq("user_id", userId);

  return {
    ok: true,
    value: {
      vault_path: written.value.path,
      message: `"${source.title}" is in the vault at ${written.value.path}.`,
    },
  };
}

// ---- MCP entry points (service client, scoped to the authenticated user) ----

export async function listCourses(userId: string) {
  return listCoursesFor(createServiceClient(), userId);
}

export async function beginSourceUpload(userId: string, raw: Record<string, unknown>) {
  return beginSourceUploadFor(createServiceClient(), userId, raw);
}

export async function appendSourcePart(userId: string, raw: Record<string, unknown>) {
  return appendSourcePartFor(createServiceClient(), userId, raw);
}

export async function finalizeSource(userId: string, raw: Record<string, unknown>) {
  return finalizeSourceFor(createServiceClient(), userId, raw, "MCP");
}
