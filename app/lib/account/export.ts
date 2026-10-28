// Data export (audit finding M9): which tables a tenant gets a copy of, and
// which columns never leave the server. Pure and client-safe — no Supabase
// import — so the route handler and the unit tests share one source of truth.

// Every user-owned public table, in migration order. Reads go through the
// COOKIE client, so RLS scopes each one to the caller; the list is what to
// ask for, never what to trust.
//
// `order` keeps `.range()` paging stable. Most tables have a uuid `id`; the
// four that do not are keyed by their primary key instead.
// `columns` names the select list for a table whose secret columns the
// session role can no longer read at all (0058 revokes them), where "*" would
// fail the whole table instead of being stripped afterwards.
export type ExportTable = { table: string; order: string[]; columns?: string };

export const EXPORT_TABLES: ExportTable[] = [
  { table: "groups", order: ["id"] },
  { table: "tasks", order: ["id"] },
  { table: "inventory_groups", order: ["id"] },
  { table: "inventory_items", order: ["id"] },
  { table: "spending_categories", order: ["id"] },
  { table: "accounts", order: ["id"] },
  { table: "balance_changes", order: ["id"] },
  { table: "recurring_expenses", order: ["id"] },
  { table: "income_sources", order: ["id"] },
  { table: "inventory_usages", order: ["id"] },
  { table: "user_settings", order: ["user_id"] },
  { table: "goals", order: ["id"] },
  { table: "daily_logs", order: ["id"] },
  { table: "ai_conversations", order: ["id"] },
  { table: "ai_messages", order: ["id"] },
  { table: "ai_audit_log", order: ["id"] },
  {
    table: "vault_settings",
    order: ["user_id"],
    columns: "user_id, repo, branch, created_at, updated_at",
  },
  { table: "recurring_tasks", order: ["id"] },
  { table: "recurring_task_completions", order: ["id"] },
  { table: "account_reconciliations", order: ["id"] },
  { table: "spend_overrides", order: ["id"] },
  { table: "courses", order: ["id"] },
  { table: "course_sources", order: ["id"] },
  { table: "course_source_parts", order: ["id"] },
  { table: "audio_episodes", order: ["id"] },
  { table: "jobs", order: ["id"] },
  { table: "worker_status", order: ["user_id"] },
  { table: "course_cards", order: ["id"] },
  { table: "spend_limits", order: ["id"] },
  { table: "recurring_task_slots", order: ["id"] },
  { table: "mindspace_topics", order: ["id"] },
  { table: "mindspace_items", order: ["id"] },
  { table: "mindspace_labels", order: ["item_id", "topic_id"] },
  { table: "mindspace_observations", order: ["id"] },
  { table: "mindspace_sessions", order: ["id"] },
  { table: "people", order: ["id"] },
  { table: "person_interactions", order: ["id"] },
  { table: "person_mention_candidates", order: ["id"] },
  { table: "people_groups", order: ["id"] },
  { table: "task_dispatches", order: ["id"] },
  { table: "urc_log", order: ["id"] },
];

// Left out on purpose, with the reason the export states out loud.
export const EXCLUDED_TABLES: Record<string, string> = {
  google_tokens:
    "holds only your google access/refresh tokens — credentials, not your data",
  urc_devices: "remote-control device registry; service-role only, holds a token hash",
  urc_jobs: "remote-control sessions; service-role only, holds private session urls",
  oauth_grants:
    "connected-app sessions; service-role only, holds refresh-token ids (listed on /settings instead)",
  oauth_used_codes: "spent one-time sign-in codes; service-role only, no user column",
};

// Column-name rules, not a hand-kept column list: a new encrypted column lands
// in the export the day it is added unless its name says secret. The patterns
// cover *_hash (mcp_token_hash, capture_token_hash, urc token_hash),
// *_token (github_token, access_token, refresh_token), *_api_key (the three
// provider keys) and session_url. mindspace_items.taxonomy_hash is swept up by
// the *_hash rule — it is a cache key, so losing it costs the export nothing.
const SECRET_COLUMN_PATTERNS = [
  /_hash$/,
  /_token$/,
  /^token$/,
  /_api_key$/,
  /^api_key$/,
  /_secret$/,
  /^secret$/,
  /^session_url$/,
];

export function isSecretColumn(name: string): boolean {
  return SECRET_COLUMN_PATTERNS.some((pattern) => pattern.test(name));
}

export function stripSecrets<T extends Record<string, unknown>>(
  row: T,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (isSecretColumn(key)) continue;
    out[key] = value;
  }
  return out;
}

export const EXPORT_NOTE =
  "every row mindboard holds for you, read through your own session so you " +
  "only ever see your own. credential columns (api keys, oauth tokens, token " +
  "hashes, remote-session urls) are stripped. not in here: the files you " +
  "uploaded (icons, course pdfs, podcast audio, reel media) — their rows name " +
  "them and the app serves them — and your brain vault, which already lives " +
  "in your own github repo.";
