import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { safeTimeZone, todayISO } from "@/app/_components/date-utils";

// The deployment owner's Supabase user id. Since the multi-tenant conversion
// this no longer scopes MCP data reads/writes (the auth layer resolves a
// per-request user id instead) — it only (a) maps the legacy static
// MCP_BEARER_TOKEN to the owner and (b) names the worker_status row the home
// worker heartbeats.
export function ownerUserId(): string {
  const id = process.env.MINDBOARD_OWNER_USER_ID;
  if (!id) {
    throw new Error("MINDBOARD_OWNER_USER_ID is not set");
  }
  return id;
}

// Users whose jobs may run on the deployment's home worker: the owner plus any
// ids in WORKER_ALLOWED_USER_IDS (comma-separated Supabase user ids). Env-based
// so only whoever controls the deployment can grant access.
export function workerAllowedUserIds(): string[] {
  const extra = (process.env.WORKER_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return [...new Set([ownerUserId(), ...extra])];
}

// User-local date key (YYYY-MM-DD). The process clock is UTC on Vercel, so the
// user's stored timezone (user_settings.timezone) is resolved and the date is
// computed in that zone — matching the app's todayISO(timeZone) convention (so
// the assistant/MCP and the app agree on "today" near local midnight). Falls
// back to the process clock when no valid timezone is stored.
//
// Reads through the CALLER'S client + id. In the multi-tenant MCP model each
// tool resolves the authenticated caller's userId (not a single owner) and
// threads it here, so the date lands in THAT user's zone; the in-app
// assistant's propose/confirm path passes its session (RLS) client + session
// user id the same way.
export async function todayKey(
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  const { data } = await supabase
    .from("user_settings")
    .select("timezone")
    .eq("user_id", userId)
    .maybeSingle();
  const timezone = (data as { timezone: string | null } | null)?.timezone ?? null;
  return todayISO(safeTimeZone(timezone));
}
