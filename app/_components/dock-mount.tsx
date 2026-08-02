import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/utils/supabase/server";
import { todayKey } from "@/app/lib/mcp/config";
import type { SpendingCategory } from "@/app/_components/finance-types";
import {
  listVaultNotePaths,
  readVaultCredentials,
  vaultTag,
} from "@/app/lib/brain/vault";
import type { Group } from "@/app/tasks/groups-types";
import { Dock } from "./dock";

// Rail badge: how many notes the vault holds. Explicitly opts out of the
// fresh-by-default tree read (vault.ts): this renders on every page, a count
// that lags by up to the 180s TTL is harmless, and an uncached GitHub call per
// render is not. DockMount renders inside its own Suspense boundary, so a cold
// or failing GitHub call never blocks page content — it only delays the dock,
// and any failure degrades to no badge.
async function brainNoteCount(
  supabase: SupabaseClient,
  userId: string,
): Promise<number> {
  try {
    const credentials = await readVaultCredentials(supabase, userId);
    if (!credentials) return 0;
    const notes = await listVaultNotePaths(credentials, vaultTag(userId), {
      fresh: false,
    });
    return notes.length;
  } catch {
    return 0;
  }
}

// Server shell for the global Dock: resolves the session and the data the
// capture input needs (active groups, inbox count, rail badges). Logged-out
// visitors get no dock at all.
export async function DockMount() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [
    groupsResponse,
    inboxResponse,
    brainCount,
    accountsResponse,
    categoriesResponse,
    today,
  ] = await Promise.all([
    supabase
      .from("groups")
      .select("id, name, type, color, archived, created_at, google_calendar_id")
      .eq("archived", false)
      .order("created_at", { ascending: false }),
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .is("group_id", null)
      .in("status", ["todo", "doing"]),
    brainNoteCount(supabase, user.id),
    supabase
      .from("accounts")
      // Total: dock.tsx:367 pins a quick-spend to accounts[0], so this picks
      // the WRITE target, not just a label.
      .select("id, name, balance, currency")
      .eq("archived", false)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
    supabase
      .from("spending_categories")
      .select("id, name, color, archived, created_at")
      .eq("archived", false)
      .order("name", { ascending: true }),
    // The capture bar writes tasks.due_date directly, so its notion of "today"
    // has to be the user's, not the device's. Resolved here (the Dock's only
    // parent) and threaded down as a prop; it rides the existing Promise.all,
    // so it costs no extra latency.
    todayKey(supabase, user.id),
  ]);

  const groups = (groupsResponse.data ?? []) as Group[];
  const accounts = ((accountsResponse.data ?? []) as {
    id: string;
    name: string;
    balance: number;
    currency: string;
  }[]).map((a) => ({ ...a, balance: Number(a.balance) }));
  const categories = (categoriesResponse.data ?? []) as SpendingCategory[];

  return (
    <Dock
      today={today}
      groups={groups}
      inboxCount={inboxResponse.count ?? 0}
      brainCount={brainCount}
      accounts={accounts}
      categories={categories}
    />
  );
}
