import Link from "next/link";
import { createClient } from "@/utils/supabase/server";
import { signOut } from "./actions/auth";
import { TodayClient } from "./_components/today-client";
import type { TaskWithGroup } from "./_components/types";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center px-6">
        <div className="max-w-sm w-full space-y-8">
          <div>
            <p className="text-[#6b6b6b] text-xs tracking-widest uppercase mb-3">
              personal dashboard
            </p>
            <h1 className="text-4xl font-bold tracking-tight text-[#f5f0e8]">
              mindboard
            </h1>
          </div>

          <p className="text-[#6b6b6b] text-sm leading-relaxed">
            Track what matters. Ship what ships.
          </p>

          <div className="pt-4">
            <a
              href="/login"
              className="inline-block bg-[#b5ff3c] text-[#0d0d0d] text-sm font-bold px-6 py-3 hover:bg-[#f5f0e8] transition-colors"
            >
              get started →
            </a>
          </div>
        </div>
      </main>
    );
  }

  const { data: rawTasks } = await supabase
    .from("tasks")
    .select(
      "id, title, due_date, status, priority, group_id, created_at, completed_at, groups(name, color)",
    )
    .neq("status", "done")
    .not("due_date", "is", null);

  type RawTask = {
    id: string;
    title: string;
    due_date: string | null;
    status: "todo" | "doing" | "done";
    priority: "low" | "med" | "high";
    group_id: string | null;
    created_at: string;
    completed_at: string | null;
    groups: { name: string; color: string } | { name: string; color: string }[] | null;
  };

  const tasks: TaskWithGroup[] = ((rawTasks ?? []) as RawTask[]).map((row) => {
    const groupRecord = Array.isArray(row.groups)
      ? (row.groups[0] ?? null)
      : (row.groups ?? null);
    return {
      id: row.id,
      title: row.title,
      due_date: row.due_date,
      status: row.status,
      priority: row.priority,
      group_id: row.group_id,
      created_at: row.created_at,
      completed_at: row.completed_at,
      group_name: groupRecord?.name ?? null,
      group_color: groupRecord?.color ?? null,
    };
  });

  const todayLabel = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  return (
    <main className="min-h-screen px-5 pt-8 pb-40 max-w-2xl mx-auto">
      <header className="flex items-start justify-between mb-8">
        <div>
          <p className="text-[10px] tracking-widest uppercase text-[#6b6b6b]">
            {todayLabel}
          </p>
          <h1 className="text-3xl font-bold tracking-tight text-[#f5f0e8] mt-1">
            today
          </h1>
        </div>
        <div className="flex flex-col items-end gap-3 pt-1">
          <Link
            href="/groups"
            className="text-xs tracking-widest uppercase px-3 py-2 border border-[#f5f0e8] text-[#f5f0e8] hover:bg-[#f5f0e8] hover:text-[#0d0d0d] transition-colors"
          >
            groups →
          </Link>
          <form action={signOut}>
            <button
              type="submit"
              className="text-[10px] tracking-widest uppercase text-[#6b6b6b] hover:text-[#f5f0e8] transition-colors"
            >
              sign out
            </button>
          </form>
        </div>
      </header>

      <TodayClient initial={tasks} />
    </main>
  );
}
