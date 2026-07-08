import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { createClient } from "@/utils/supabase/server";
import {
  COURSE_COLUMNS,
  type Course,
} from "@/app/_components/learn-types";
import { StudyClient, type StudyCard } from "./study-client";

// Card/artifact generation makes one long Claude call.
export const maxDuration = 300;

export default async function StudyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [courseResult, cardsResult, convertedCount] = await Promise.all([
    supabase.from("courses").select(COURSE_COLUMNS).eq("id", id).maybeSingle(),
    supabase
      .from("course_cards")
      .select(
        "id, question, answer, explain, got_count, miss_count, last_reviewed_at",
      )
      .eq("course_id", id)
      .order("created_at", { ascending: true }),
    supabase
      .from("course_sources")
      .select("id", { count: "exact", head: true })
      .eq("course_id", id)
      .eq("status", "converted"),
  ]);

  const course = courseResult.data as Course | null;
  if (!course) notFound();

  return (
    <main className="min-h-screen px-5 pt-8 pb-64 max-w-2xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <Link
          href="/learn"
          className="text-muted text-label tracking-widest uppercase hover:text-fg transition-colors"
        >
          ← learn
        </Link>
        <h1 className="flex items-center gap-2 text-label tracking-widest uppercase text-muted">
          <span
            aria-hidden
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: course.color }}
          />
          {course.name} · study
        </h1>
      </header>

      <StudyClient
        course={course}
        initialCards={(cardsResult.data ?? []) as StudyCard[]}
        hasConvertedSources={(convertedCount.count ?? 0) > 0}
      />
    </main>
  );
}
