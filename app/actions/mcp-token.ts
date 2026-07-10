"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/utils/supabase/server";
import { generatePatToken, hashPatToken } from "@/app/lib/mcp/pat";

// Per-user MCP personal access token lifecycle. The plaintext token is
// returned to the caller exactly once; only its SHA-256 hash persists
// (user_settings.mcp_token_hash), plus a last-4 hint and timestamp for the
// settings card. Runs on the session client, so RLS scopes the row.

export async function generateMcpToken(): Promise<{
  error: string | null;
  token?: string;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const token = generatePatToken();
  const { error } = await supabase.from("user_settings").upsert(
    {
      user_id: user.id,
      mcp_token_hash: hashPatToken(token),
      mcp_token_hint: token.slice(-4),
      mcp_token_created_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) return { error: error.message };

  revalidatePath("/settings");
  return { error: null, token };
}

export async function revokeMcpToken(): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("user_settings")
    .update({
      mcp_token_hash: null,
      mcp_token_hint: null,
      mcp_token_created_at: null,
    })
    .eq("user_id", user.id);
  if (error) return { error: error.message };

  revalidatePath("/settings");
  return { error: null };
}
