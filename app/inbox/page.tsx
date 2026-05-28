import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { TasksClient } from "@/app/_components/tasks-client";
import type { Task } from "@/app/_components/types";

export default async function InboxPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const [{ data: tasks }, { data: groupRows }] = await Promise.all([
    supabase
      .from("tasks")
      .select(
        "id, title, due_date, status, priority, notes, group_id, created_at, completed_at",
      )
      .is("group_id", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("groups")
      .select("id, name, color")
      .eq("archived", false)
      .order("created_at", { ascending: false }),
  ]);

  const groups = (groupRows ?? []) as { id: string; name: string; color: string }[];

  return (
    <main className="min-h-screen px-5 pt-8 pb-40 max-w-2xl mx-auto">
      <header className="flex items-center justify-between mb-8">
        <Link
          href="/groups"
          className="text-muted text-xs tracking-widest uppercase hover:text-fg transition-colors"
        >
          ← groups
        </Link>
        <p className="text-[10px] tracking-widest uppercase text-muted">
          unsorted
        </p>
      </header>

      <div className="flex items-center gap-3 mb-8">
        <span
          className="w-1.5 h-8 flex-shrink-0 border-2 border-dashed border-line-subtle"
          aria-hidden
        />
        <h1 className="text-2xl font-bold tracking-tight text-fg">
          inbox
        </h1>
      </div>

      <TasksClient initial={(tasks ?? []) as Task[]} groupId={null} groups={groups} />
    </main>
  );
}
