import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Service-role Supabase client for session-less server contexts (the MCP
// server, which authenticates by bearer token, not a Supabase auth cookie).
//
// It BYPASSES row-level security, so every query built on it MUST filter by
// user_id explicitly — that explicit scoping is the security invariant that
// replaces RLS here. The service-role key is server-only and is never a
// NEXT_PUBLIC_* var, so it can't reach the browser bundle.
let cached: SupabaseClient | null = null;

export function createServiceClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "Supabase service client requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
    );
  }

  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
