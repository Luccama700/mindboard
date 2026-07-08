import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  readVaultCredentials,
  readVaultNoteRaw,
  vaultTag,
} from "@/app/lib/brain/vault";
import type { Result } from "@/app/lib/mcp/validate";
import {
  SOURCE_COLUMNS,
  type Course,
  type CourseSource,
} from "@/app/_components/learn-types";

// Shared course-context loading for the episode generator and the grounded
// chat: which converted sources, and their vault markdown.

export const MAX_CONTEXT_CHARS = 400_000;

export async function loadConvertedSources(
  supabase: SupabaseClient,
  userId: string,
  course: Course,
  sourceIds: string[] | null,
): Promise<Result<CourseSource[]>> {
  const { data } = await supabase
    .from("course_sources")
    .select(SOURCE_COLUMNS)
    .eq("user_id", userId)
    .eq("course_id", course.id)
    .eq("status", "converted")
    .order("created_at", { ascending: true });
  let sources = (data ?? []) as CourseSource[];
  if (sourceIds) {
    const wanted = new Set(sourceIds);
    sources = sources.filter((s) => wanted.has(s.id));
    if (sources.length !== wanted.size) {
      return {
        ok: false,
        error: "some source_ids are not converted sources of that course",
      };
    }
  }
  if (sources.length === 0) {
    return {
      ok: false,
      error: `"${course.name}" has no converted sources yet — convert a PDF or upload markdown first`,
    };
  }
  return { ok: true, value: sources };
}

export type SourceDocument = {
  source: CourseSource;
  markdown: string;
};

export async function loadSourceDocuments(
  supabase: SupabaseClient,
  userId: string,
  sources: CourseSource[],
): Promise<Result<SourceDocument[]>> {
  const credentials = await readVaultCredentials(supabase, userId);
  if (!credentials) return { ok: false, error: "vault not connected" };

  const documents: SourceDocument[] = [];
  let total = 0;
  for (const source of sources) {
    if (!source.vault_path) continue;
    const note = await readVaultNoteRaw(
      credentials,
      vaultTag(userId),
      source.vault_path,
    );
    if (!note) {
      return {
        ok: false,
        error: `vault note missing for "${source.title}" (${source.vault_path})`,
      };
    }
    total += note.markdown.length;
    documents.push({ source, markdown: note.markdown });
  }

  if (total > MAX_CONTEXT_CHARS) {
    return {
      ok: false,
      error: `selected sources total ${total} characters (max ${MAX_CONTEXT_CHARS}) — pick fewer sources`,
    };
  }
  return { ok: true, value: documents };
}
