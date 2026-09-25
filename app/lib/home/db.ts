import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/utils/supabase/service";
import type { HomeMember } from "./logic";

// Service-role client for the home app's own Supabase project (a separate
// database from Mindboard's). Access control mirrors the home app's web gate:
// the caller's confirmed Mindboard email must be on the home app's `allowlist`
// (its revocation list) and belong to a household profile.
let cached: SupabaseClient | null = null;

export function homeConfigured(): boolean {
  return Boolean(process.env.HOME_APP_SUPABASE_URL && process.env.HOME_APP_SUPABASE_SERVICE_ROLE_KEY);
}

export function homeDb(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.HOME_APP_SUPABASE_URL;
  const key = process.env.HOME_APP_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("home app is not connected on this deployment");
  cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return cached;
}

export async function loadMembers(): Promise<HomeMember[]> {
  const { data, error } = await homeDb()
    .from("profiles")
    .select("id, name, email, role, sort_order, in_rotation")
    .order("sort_order");
  if (error) throw new Error(error.message);
  return (data ?? []) as HomeMember[];
}

/** The household member behind a Mindboard user, matched by Google email. */
export async function resolveMember(mindboardUserId: string): Promise<{ member: HomeMember; members: HomeMember[] }> {
  const { data, error } = await createServiceClient().auth.admin.getUserById(mindboardUserId);
  const email = data?.user?.email?.toLowerCase();
  if (error || !email || !data.user.email_confirmed_at) throw new Error("couldn't resolve a confirmed account email");
  const { data: allowed, error: allowErr } = await homeDb()
    .from("allowlist")
    .select("email")
    .eq("email", email)
    .maybeSingle();
  if (allowErr) throw new Error(allowErr.message);
  const members = await loadMembers();
  const member = allowed ? members.find((m) => m.email === email) : undefined;
  if (!member) throw new Error("this Mindboard account isn't a member of the home app");
  return { member, members };
}
