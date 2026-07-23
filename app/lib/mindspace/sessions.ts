import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// External-session ingestion shared by the claude.ai import action (session
// client) and the mindspace_ingest_sessions MCP tool (service client — so
// userId is threaded explicitly, per the multi-tenant MCP invariant). Upserts
// are idempotent on (user, provider, session_ref); re-syncing a session that
// grew updates it in place, and the verdict cache follows automatically
// because the item ref carries the word count.

export type ExternalProvider = "claude_ai" | "claude_code";

export type ExternalSessionInput = {
  ref: string;
  title?: string;
  project?: string;
  startedAt: string;
  endedAt: string;
  durationMin: number;
  userText: string;
  wordCount?: number;
};

export const SESSION_BATCH_MAX = 200;
const USER_TEXT_CAP = 6000;
const TITLE_CAP = 200;
const MAX_DURATION_MIN = 120;

export type IngestResult = {
  ok: boolean;
  imported: number;
  skipped: number;
  error?: string;
};

export async function ingestExternalSessions(
  supabase: SupabaseClient,
  userId: string,
  provider: ExternalProvider,
  sessions: ExternalSessionInput[],
): Promise<IngestResult> {
  const rows = [];
  let skipped = 0;
  const seenRefs = new Set<string>();

  for (const session of sessions.slice(0, SESSION_BATCH_MAX)) {
    const ref = session.ref?.trim();
    const startedMs = Date.parse(session.startedAt ?? "");
    const endedMs = Date.parse(session.endedAt ?? "");
    if (
      !ref ||
      ref.length > 200 ||
      seenRefs.has(ref) ||
      Number.isNaN(startedMs) ||
      Number.isNaN(endedMs) ||
      endedMs < startedMs ||
      typeof session.userText !== "string"
    ) {
      skipped++;
      continue;
    }
    seenRefs.add(ref);
    const userText = session.userText.slice(0, USER_TEXT_CAP);
    const wordCount =
      typeof session.wordCount === "number" && session.wordCount >= 0
        ? Math.round(session.wordCount)
        : (userText.match(/\S+/g)?.length ?? 0);
    rows.push({
      user_id: userId,
      provider,
      session_ref: ref,
      title: session.title?.trim().slice(0, TITLE_CAP) || null,
      project: session.project?.trim().slice(0, TITLE_CAP) || null,
      started_at: new Date(startedMs).toISOString(),
      ended_at: new Date(endedMs).toISOString(),
      duration_min: Math.min(
        MAX_DURATION_MIN,
        Math.max(0, Math.round(session.durationMin ?? 0)),
      ),
      word_count: wordCount,
      user_text: userText,
      updated_at: new Date().toISOString(),
    });
  }

  if (rows.length === 0) {
    return { ok: true, imported: 0, skipped };
  }

  const { error } = await supabase
    .from("mindspace_sessions")
    .upsert(rows, { onConflict: "user_id,provider,session_ref" });
  if (error) {
    return { ok: false, imported: 0, skipped, error: error.message };
  }
  return { ok: true, imported: rows.length, skipped };
}

export type SessionCounts = {
  claudeAi: number;
  claudeCode: number;
  latestEndedAt: string | null;
};

export async function countExternalSessions(
  supabase: SupabaseClient,
  userId: string,
): Promise<SessionCounts> {
  const [aiRes, codeRes, latestRes] = await Promise.all([
    supabase
      .from("mindspace_sessions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("provider", "claude_ai"),
    supabase
      .from("mindspace_sessions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("provider", "claude_code"),
    supabase
      .from("mindspace_sessions")
      .select("ended_at")
      .eq("user_id", userId)
      .order("ended_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  return {
    claudeAi: aiRes.count ?? 0,
    claudeCode: codeRes.count ?? 0,
    latestEndedAt: (latestRes.data?.ended_at as string | null) ?? null,
  };
}
