import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { TasksClient, type Task } from "@/app/_components/tasks-client";

export default async function InboxPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: tasks } = await supabase
    .from("tasks")
    .select(
      "id, title, due_date, status, priority, group_id, created_at, completed_at",
    )
    .is("group_id", null)
    .order("created_at", { ascending: false });

  return (
    <main className="min-h-screen px-5 pt-8 pb-40 max-w-2xl mx-auto">
      <header className="flex items-center justify-between mb-8">
        <Link
          href="/groups"
          className="text-[#6b6b6b] text-xs tracking-widest uppercase hover:text-[#f5f0e8] transition-colors"
        >
          ← groups
        </Link>
        <p className="text-[10px] tracking-widest uppercase text-[#6b6b6b]">
          unsorted
        </p>
      </header>

      <div className="flex items-center gap-3 mb-8">
        <span
          className="w-1.5 h-8 flex-shrink-0 border-2 border-dashed border-[#3a3a3a]"
          aria-hidden
        />
        <h1 className="text-2xl font-bold tracking-tight text-[#f5f0e8]">
          inbox
        </h1>
      </div>

      <TasksClient initial={(tasks ?? []) as Task[]} groupId={null} />
    </main>
  );
}
