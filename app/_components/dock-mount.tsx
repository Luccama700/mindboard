import { createClient } from "@/utils/supabase/server";
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

  const [groupsResponse, inboxResponse] = await Promise.all([
    supabase
      .from("groups")
      .select("id, name, color")
      .eq("archived", false)
      .order("created_at", { ascending: false }),
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .is("group_id", null)
      .neq("status", "done"),
  ]);

  const groups = (groupsResponse.data ?? []) as {
    id: string;
    name: string;
    color: string;
  }[];

  return <Dock groups={groups} inboxCount={inboxResponse.count ?? 0} />;
}
