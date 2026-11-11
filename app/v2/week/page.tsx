// The Week page: one week of calendar, the whole window wide.
//
// It is gated exactly as Today is, and for the same reasons, which are written
// out at the top of app/v2/today/page.tsx and in app/lib/v2/source.ts: the gate
// decides synchronously, so a route that is switched off answers a real 404
// before anything streams; the loopback check is the first statement of the
// async child; and every read of the folder comes after it.
//
// Only the calendar is read here. The day and its planner belong to Today, so
// this page plans nothing and shows no planned blocks.

import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { sampleWeek } from "@/app/lib/v2/fixtures/sample-week";
import { loadLocalCalendar } from "@/app/lib/v2/local/calendar";
import { LocalSnapshotError } from "@/app/lib/v2/local/snapshot";
import { requireLoopback, screenSource, type ScreenSource } from "@/app/lib/v2/source";
import type { CalendarScreenData } from "@/app/lib/v2/view/screen-data";
import { WeekClient } from "./week-client";

export const metadata: Metadata = {
  title: "Week",
};

// The gate reads environment variables and the snapshot branch reads the clock,
// so this runs per request rather than once at build time.
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

export default function WeekPage(props?: { searchParams?: Promise<Search> }) {
  const source = screenSource({
    V2_FIXTURES: process.env.V2_FIXTURES,
    V2_LOCAL_SNAPSHOT: process.env.V2_LOCAL_SNAPSHOT,
    VERCEL_ENV: process.env.VERCEL_ENV,
  });
  if (source === null) notFound();

  return <WeekScreen source={source} searchParams={props?.searchParams} />;
}

/**
 * One parameter, as a string. A repeated parameter arrives as a list, which is
 * not a week, and the calendar ignores a week it cannot use rather than
 * refusing the page over it.
 */
function oneOf(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The week, from whichever source the gate allowed. The loopback check is the
 * first thing in it: a request whose Host is not this machine gets no data.
 */
async function WeekScreen({
  source,
  searchParams,
}: {
  source: ScreenSource;
  searchParams?: Promise<Search>;
}) {
  await requireLoopback(source);
  const asked = searchParams === undefined ? {} : await searchParams;
  const week = oneOf(asked.week);

  if (source.kind === "sample") return <WeekClient calendar={sampleWeek(week)} />;

  const folder = await readCalendar(source.dir, week);
  if (folder.error !== undefined) {
    return (
      <main style={{ padding: "2rem 1rem", maxWidth: "34rem", lineHeight: 1.5 }}>
        <h1 style={{ fontSize: "1.1rem", fontWeight: 700 }}>The snapshot is not ready</h1>
        <p style={{ marginTop: "0.75rem" }}>{folder.error}</p>
        <p style={{ marginTop: "0.75rem", opacity: 0.7 }}>
          The folder is the one V2_LOCAL_SNAPSHOT points at. Nothing was changed in it.
        </p>
      </main>
    );
  }

  // null is a folder with no calendar file, which the screen says in words.
  return <WeekClient calendar={folder.calendar} />;
}

/**
 * The folder's week, or the one error it reports. A file that is missing or
 * cannot be read is something to go and fix, so it comes back as a value; any
 * other error still throws.
 *
 * Separate from the component because JSX must not be built inside a try, and
 * BELOW it on purpose, as Today's `readFolder` is: reading the file from the top
 * shows the awaited check before any read of the folder.
 */
async function readCalendar(
  dir: string,
  week: string | null,
): Promise<
  | { calendar: CalendarScreenData | null; error?: undefined }
  | { calendar?: undefined; error: string }
> {
  try {
    return { calendar: await loadLocalCalendar(dir, new Date().toISOString(), week) };
  } catch (error) {
    if (error instanceof LocalSnapshotError) return { error: error.message };
    throw error;
  }
}
