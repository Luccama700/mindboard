import "server-only";

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
