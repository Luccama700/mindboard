import { createClient } from "@/utils/supabase/server";
import type { Group } from "@/app/tasks/groups-types";
import { Dock } from "./dock";

// Server shell for the global Dock: resolves the session and the data the
// capture input needs (active groups, inbox count). Logged-out visitors get
// no dock at all.
export async function DockMount() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [groupsResponse, inboxResponse, accountsResponse, categoriesResponse] =
    await Promise.all([
      supabase
        .from("groups")
        .select("id, name, type, color, archived, created_at, google_calendar_id")
        .eq("archived", false)
        .order("created_at", { ascending: false }),
      supabase
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .is("group_id", null)
        .neq("status", "done"),
      supabase
        .from("accounts")
        .select("id, name, balance, currency")
        .eq("archived", false)
        .order("created_at", { ascending: true }),
      supabase
        .from("spending_categories")
        .select("id, name, color")
        .order("name", { ascending: true }),
    ]);

  const groups = (groupsResponse.data ?? []) as Group[];
  const accounts = ((accountsResponse.data ?? []) as {
    id: string;
    name: string;
    balance: number;
    currency: string;
  }[]).map((a) => ({ ...a, balance: Number(a.balance) }));
  const categories = (categoriesResponse.data ?? []) as {
    id: string;
    name: string;
    color: string;
  }[];

  return (
    <Dock
      groups={groups}
      inboxCount={inboxResponse.count ?? 0}
      accounts={accounts}
      categories={categories}
    />
  );
}
