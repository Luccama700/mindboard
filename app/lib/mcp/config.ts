import "server-only";

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

// Server-local date key (YYYY-MM-DD), matching the rest of the app's date
// convention (the process clock — UTC on Vercel). The stored user timezone in
// user_settings is intentionally not consulted here yet; see the Milestone 1
// notes in docs/second-brain-plan.md.
export function todayKey(): string {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}
