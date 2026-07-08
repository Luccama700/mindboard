"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/utils/supabase/server";
import {
  COURSE_COLUMNS,
  SOURCE_COLUMNS,
  type Course,
  type CourseSource,
} from "@/app/_components/learn-types";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

type CourseResult = { error: string | null; course?: Course };
type SourceResult = { error: string | null; source?: CourseSource };

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

export async function createCourse(input: {
  name: string;
  code?: string;
  term?: string;
  color?: string;
}): Promise<CourseResult> {
  const name = input.name?.trim();
  if (!name) return { error: "course name required" };
  if (name.length > 120) return { error: "course name too long" };
  const color = input.color?.trim() || "#b5ff3c";
  if (!HEX_RE.test(color)) return { error: "invalid color" };

  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const { data, error } = await supabase
    .from("courses")
    .insert({
      user_id: user.id,
      name,
      code: input.code?.trim() || null,
      term: input.term?.trim() || null,
      color,
    })
    .select(COURSE_COLUMNS)
    .single();
  if (error) return { error: error.message };

  revalidatePath("/learn");
  return { error: null, course: data as Course };
}

export async function updateCourse(input: {
  id: string;
  name?: string;
  code?: string | null;
  term?: string | null;
  color?: string;
}): Promise<{ error: string | null }> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return { error: "course name required" };
    patch.name = name;
  }
  if (input.code !== undefined) patch.code = input.code?.trim() || null;
  if (input.term !== undefined) patch.term = input.term?.trim() || null;
  if (input.color !== undefined) {
    if (!HEX_RE.test(input.color)) return { error: "invalid color" };
    patch.color = input.color;
  }
  if (Object.keys(patch).length === 0) return { error: null };

  const { error } = await supabase
    .from("courses")
    .update(patch)
    .eq("id", input.id)
    .eq("user_id", user.id);
  if (error) return { error: error.message };

  revalidatePath("/learn");
  return { error: null };
}

export async function archiveCourse(input: {
  id: string;
  archived: boolean;
}): Promise<{ error: string | null }> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("courses")
    .update({ archived: input.archived })
    .eq("id", input.id)
    .eq("user_id", user.id);
  if (error) return { error: error.message };

  revalidatePath("/learn");
  return { error: null };
}

// Step 1 of the upload flow: create the metadata row so the client has an id
// to key the storage folder ({user_id}/{source_id}/{filename}).
export async function registerSource(input: {
  courseId: string;
  title: string;
  kind?: "pdf" | "markdown" | "text";
}): Promise<SourceResult> {
  const title = input.title?.trim();
  if (!title) return { error: "source title required" };
  if (title.length > 200) return { error: "source title too long" };

  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const { data, error } = await supabase
    .from("course_sources")
    .insert({
      user_id: user.id,
      course_id: input.courseId,
      title,
      kind: input.kind ?? "pdf",
    })
    .select(SOURCE_COLUMNS)
    .single();
  if (error) return { error: error.message };

  revalidatePath("/learn");
  return { error: null, source: data as CourseSource };
}

// Step 2: the browser uploaded the file directly to storage (RLS-scoped to
// the user's own folder); record where it landed.
export async function attachSourceFile(input: {
  sourceId: string;
  storagePath: string;
}): Promise<{ error: string | null }> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const path = input.storagePath?.trim() ?? "";
  if (!path.startsWith(`${user.id}/${input.sourceId}/`)) {
    return { error: "storage path does not match this source" };
  }

  const { error } = await supabase
    .from("course_sources")
    .update({ storage_path: path, status: "uploaded", error: null })
    .eq("id", input.sourceId)
    .eq("user_id", user.id)
    .eq("status", "registered");
  if (error) return { error: error.message };

  revalidatePath("/learn");
  return { error: null };
}

export async function renameSource(input: {
  sourceId: string;
  title: string;
}): Promise<{ error: string | null }> {
  const title = input.title?.trim();
  if (!title) return { error: "source title required" };

  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("course_sources")
    .update({ title })
    .eq("id", input.sourceId)
    .eq("user_id", user.id);
  if (error) return { error: error.message };

  revalidatePath("/learn");
  return { error: null };
}

// Path 3: convert an uploaded PDF to vault markdown on the stored Anthropic
// key. Long-running (one Claude call per ~20-page slice) — /learn sets
// maxDuration accordingly.
export async function convertSource(input: {
  sourceId: string;
  model?: string;
}): Promise<{ error: string | null; vaultPath?: string }> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const { runPdfConversion } = await import("@/app/lib/learn/convert");
  const result = await runPdfConversion({
    supabase,
    userId: user.id,
    sourceId: input.sourceId,
    model: input.model,
  });

  revalidatePath("/learn");
  if (!result.ok) return { error: result.error };
  return { error: null, vaultPath: result.value.vault_path };
}

// Path 2: hand the PDF to the home PC. The job waits in the queue until the
// worker is online; the source row tracks progress.
export async function queueSourceConversion(input: {
  sourceId: string;
}): Promise<{ error: string | null }> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const { data: source } = await supabase
    .from("course_sources")
    .select("id, kind, status, storage_path")
    .eq("id", input.sourceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!source) return { error: "source not found" };
  if (source.kind !== "pdf" || !source.storage_path) {
    return { error: "source has no uploaded pdf" };
  }
  if (source.status !== "uploaded" && source.status !== "failed") {
    return { error: `source is ${source.status}` };
  }

  const { error: jobError } = await supabase.from("jobs").insert({
    user_id: user.id,
    kind: "ocr",
    payload: { source_id: input.sourceId },
  });
  if (jobError) return { error: jobError.message };

  const { error } = await supabase
    .from("course_sources")
    .update({ status: "queued", error: null })
    .eq("id", input.sourceId)
    .eq("user_id", user.id);
  if (error) return { error: error.message };

  revalidatePath("/learn");
  return { error: null };
}

// In-app episode generation executes directly — the tap on "generate" IS the
// confirmation (unlike the MCP path, which proposes first).
export async function generateEpisode(input: {
  courseId: string;
  sourceIds?: string[];
  flavor?: string;
  engine?: string;
}): Promise<{ error: string | null; episodeId?: string }> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const { generateEpisodeFor } = await import("@/app/lib/learn/episodes");
  const result = await generateEpisodeFor(supabase, user.id, {
    course: input.courseId,
    source_ids: input.sourceIds ?? null,
    flavor: input.flavor ?? "deep-dive",
    engine: input.engine ?? "gemini",
  });

  revalidatePath("/learn");
  if (!result.ok) return { error: result.error };
  return { error: null, episodeId: result.value.episode_id };
}

export async function deleteEpisode(input: {
  episodeId: string;
}): Promise<{ error: string | null }> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const { data: episode } = await supabase
    .from("audio_episodes")
    .select("storage_path")
    .eq("id", input.episodeId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!episode) return { error: "episode not found" };

  if (episode.storage_path) {
    await supabase.storage.from("course-audio").remove([episode.storage_path]);
  }

  const { error } = await supabase
    .from("audio_episodes")
    .delete()
    .eq("id", input.episodeId)
    .eq("user_id", user.id);
  if (error) return { error: error.message };

  revalidatePath("/learn");
  return { error: null };
}

export async function generateArtifact(input: {
  courseId: string;
  kind: string;
}): Promise<{ error: string | null; vaultPath?: string }> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const { generateArtifactFor, ARTIFACT_KINDS } = await import(
    "@/app/lib/learn/artifacts"
  );
  if (!(input.kind in ARTIFACT_KINDS)) return { error: "unknown artifact kind" };
  const result = await generateArtifactFor(
    supabase,
    user.id,
    input.courseId,
    input.kind as keyof typeof ARTIFACT_KINDS,
  );
  if (!result.ok) return { error: result.error };
  return { error: null, vaultPath: result.value.vault_path };
}

export async function generateCards(input: {
  courseId: string;
  count?: number;
}): Promise<{ error: string | null; created?: number }> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const { generateCardsFor } = await import("@/app/lib/learn/artifacts");
  const result = await generateCardsFor(
    supabase,
    user.id,
    input.courseId,
    input.count ?? 20,
  );
  revalidatePath(`/learn/${input.courseId}/study`);
  if (!result.ok) return { error: result.error };
  return { error: null, created: result.value.created };
}

export async function reviewCard(input: {
  cardId: string;
  got: boolean;
}): Promise<{ error: string | null }> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const { data: card } = await supabase
    .from("course_cards")
    .select("got_count, miss_count")
    .eq("id", input.cardId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!card) return { error: "card not found" };

  const { error } = await supabase
    .from("course_cards")
    .update({
      got_count: (card.got_count as number) + (input.got ? 1 : 0),
      miss_count: (card.miss_count as number) + (input.got ? 0 : 1),
      last_reviewed_at: new Date().toISOString(),
    })
    .eq("id", input.cardId)
    .eq("user_id", user.id);
  if (error) return { error: error.message };
  return { error: null };
}

export async function deleteCard(input: {
  cardId: string;
}): Promise<{ error: string | null }> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("course_cards")
    .delete()
    .eq("id", input.cardId)
    .eq("user_id", user.id);
  if (error) return { error: error.message };
  return { error: null };
}

// Deletes the metadata row and the stored original. The vault copy (if the
// source was converted) is deliberately left alone — vault knowledge is
// reviewed and removed in the vault, never by an app-side cascade.
export async function deleteSource(input: {
  sourceId: string;
}): Promise<{ error: string | null }> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const { data: source } = await supabase
    .from("course_sources")
    .select("storage_path")
    .eq("id", input.sourceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!source) return { error: "source not found" };

  if (source.storage_path) {
    await supabase.storage.from("course-files").remove([source.storage_path]);
  }

  const { error } = await supabase
    .from("course_sources")
    .delete()
    .eq("id", input.sourceId)
    .eq("user_id", user.id);
  if (error) return { error: error.message };

  revalidatePath("/learn");
  return { error: null };
}
