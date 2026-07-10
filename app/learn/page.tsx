import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/utils/supabase/server";
import {
  COURSE_COLUMNS,
  EPISODE_COLUMNS,
  SOURCE_COLUMNS,
  type AudioEpisode,
  type Course,
  type CourseSource,
} from "@/app/_components/learn-types";
import { LearnClient } from "./learn-client";

// PDF conversion runs one Claude call per ~20-page slice from a server
// action on this route; allow the fluid-compute maximum.
export const maxDuration = 300;

export default async function LearnPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const [coursesResult, sourcesResult, episodesResult] = await Promise.all([
    supabase
      .from("courses")
      .select(COURSE_COLUMNS)
      .order("created_at", { ascending: false }),
    supabase
      .from("course_sources")
      .select(SOURCE_COLUMNS)
      .order("created_at", { ascending: false }),
    supabase
      .from("audio_episodes")
      .select(EPISODE_COLUMNS)
      .order("created_at", { ascending: false }),
  ]);

  const episodes = (episodesResult.data ?? []) as AudioEpisode[];
  const audioUrls: Record<string, string> = {};
  const playable = episodes.filter((e) => e.status === "done" && e.storage_path);
  if (playable.length > 0) {
    const { data: signed } = await supabase.storage
      .from("course-audio")
      .createSignedUrls(
        playable.map((e) => e.storage_path as string),
        3600,
      );
    signed?.forEach((entry, index) => {
      if (entry.signedUrl) audioUrls[playable[index].id] = entry.signedUrl;
    });
  }

  return (
    <main className="min-h-screen px-5 pt-8 pb-64 max-w-2xl mx-auto">
      <header className="flex items-center justify-between mb-10 pr-24 lg:pr-0">
        <Link
          href="/"
          className="inline-flex items-center min-h-11 text-muted text-label tracking-widest uppercase hover:text-fg transition-colors"
        >
          ← mindboard
        </Link>
        <h1 className="text-label tracking-widest uppercase text-muted">
          learn
        </h1>
      </header>

      <div data-tour="courses">
        <LearnClient
          userId={user.id}
          initialCourses={(coursesResult.data ?? []) as Course[]}
          initialSources={(sourcesResult.data ?? []) as CourseSource[]}
          initialEpisodes={episodes}
          audioUrls={audioUrls}
        />
      </div>
    </main>
  );
}
