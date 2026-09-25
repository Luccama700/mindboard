import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/utils/supabase/service";
import type { HomeMember } from "./logic";

// Service-role client for the home app's own Supabase project (a separate
// database from Mindboard's). Access control is the home app's allowlist: the
// caller's Mindboard email must belong to a household member, the same gate
// the home app's web sign-in applies.
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
  if (error || !email) throw new Error("couldn't resolve your account email");
  const members = await loadMembers();
  const member = members.find((m) => m.email === email);
  if (!member) throw new Error("this Mindboard account isn't a member of the home app");
  return { member, members };
}
