import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { createServiceClient } from "@/utils/supabase/service";

// Per-user MCP personal access tokens ("PAT") for clients that don't speak the
// OAuth flow (Claude Desktop config, MCP inspector, curl). The plaintext token
// is shown exactly once at generation; only its SHA-256 hex lands in
// user_settings.mcp_token_hash (unique partial index from migration 0016), so
// a database leak never yields usable tokens. Lookup is hash → user_id.

export const PAT_PREFIX = "mbp_";

export function generatePatToken(): string {
  return `${PAT_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashPatToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function looksLikePat(bearer: string): boolean {
  return bearer.startsWith(PAT_PREFIX);
}

// Resolve a presented PAT to its user id, or null. The SHA-256 preimage
// resistance makes a constant-time comparison unnecessary: an attacker can't
// craft tokens that partially match a stored hash.
export async function resolvePatUserId(bearer: string): Promise<string | null> {
  if (!looksLikePat(bearer)) return null;
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("user_settings")
    .select("user_id")
    .eq("mcp_token_hash", hashPatToken(bearer))
    .maybeSingle();
  return (data?.user_id as string | undefined) ?? null;
}
