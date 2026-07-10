import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { safeTimeZone, todayISO } from "@/app/_components/date-utils";

// The single Mindboard owner whose data the MCP server exposes. Set from the
// Supabase auth user id in env (single-user deployment). Every service-role
// query filters by this id explicitly, because the service role bypasses RLS.
export function ownerUserId(): string {
  const id = process.env.MINDBOARD_OWNER_USER_ID;
  if (!id) {
    throw new Error("MINDBOARD_OWNER_USER_ID is not set");
  }
  return id;
}

// User-local date key (YYYY-MM-DD). The process clock is UTC on Vercel, so the
// user's stored timezone (user_settings.timezone) is resolved and the date is
// computed in that zone — matching the app's todayISO(timeZone) convention (so
// the assistant/MCP and the app agree on "today" near local midnight). Falls
// back to the process clock when no valid timezone is stored.
//
// Reads through the CALLER'S client + id: the remote MCP path passes the
// service client + ownerUserId(); the in-app assistant's propose/confirm path
// passes its session (RLS) client + the session user id. This keeps the
// session/RLS paths off the service role and off the MCP-only env.
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
