import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { createClient } from "@/utils/supabase/server";
import {
  COURSE_COLUMNS,
  SOURCE_COLUMNS,
  type Course,
  type CourseSource,
} from "@/app/_components/learn-types";
import { CourseChatClient } from "./chat-client";

export const maxDuration = 120;

export default async function CourseChatPage({
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

  const [courseResult, sourcesResult, settingsResult] = await Promise.all([
    supabase
      .from("courses")
      .select(COURSE_COLUMNS)
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("course_sources")
      .select(SOURCE_COLUMNS)
      .eq("course_id", id)
      .eq("status", "converted")
      .order("created_at", { ascending: true }),
    supabase
      .from("user_settings")
      .select("anthropic_api_key")
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);

  const course = courseResult.data as Course | null;
  if (!course) notFound();

  return (
    <main className="min-h-screen px-5 pt-8 pb-64 max-w-2xl mx-auto">
      <header className="flex items-center justify-between mb-6 pr-24 lg:pr-0">
        <Link
          href="/learn"
          className="inline-flex items-center min-h-11 text-muted text-label tracking-widest uppercase hover:text-fg transition-colors"
        >
          ← learn
        </Link>
        <h1 className="flex items-center gap-2 text-label tracking-widest uppercase text-muted">
          <span
            aria-hidden
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: course.color }}
          />
          {course.name}
        </h1>
      </header>

      <CourseChatClient
        course={course}
        sources={(sourcesResult.data ?? []) as CourseSource[]}
        hasKey={Boolean(settingsResult.data?.anthropic_api_key)}
      />
    </main>
  );
}
