// The Today screen. It runs on one of two sources, and which one it may use is
// not decided here: every v2 page asks `screenSource` (app/lib/v2/source.ts),
// which holds the two environment checks, the order between them, and the
// loopback speed bump, with the reasoning for each written out beside them.
// Neither source reads a database and neither needs a session, so this route
// still has no sign in.
//
// WHY THIS PAGE IS NOT ASYNC. Everything the snapshot needs is asynchronous:
// `searchParams` and `headers()` are promises in Next 16, and so is reading the
// folder. But a route that is switched off has to answer a real 404, and
// `notFound()` can only set the status before the response starts streaming
// (the streaming guide, "Status codes"): once a loading fallback has rendered,
// the server has committed to 200 and a later `notFound()` only adds a noindex
// tag. So the gate's decision stays synchronous, here, and everything that has
// to wait lives in a child component.
//
// Server and client: the server decides the source and builds the day (that
// parses the planner rules and, for a snapshot, reads the folder), then hands
// plain data to one client component. The planner itself then runs in the
// browser, so Start, Done, Not today and the energy options are real replans.

import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { sampleDay } from "@/app/lib/v2/fixtures/sample-day";
import { sampleWeek } from "@/app/lib/v2/fixtures/sample-week";
import { loadLocalCalendar } from "@/app/lib/v2/local/calendar";
import { LocalSnapshotError, loadLocalToday } from "@/app/lib/v2/local/snapshot";
import { requireLoopback, screenSource, type ScreenSource } from "@/app/lib/v2/source";
import type { TodayScreenData } from "@/app/lib/v2/view/screen-data";
import { TodayClient } from "./today-client";

export const metadata: Metadata = {
  title: "Today",
};

// The gate reads environment variables and the snapshot branch reads the clock,
// so this has to run per request rather than once at build time. Declared here
// rather than left to whatever the root layout happens to do, so the gate cannot
// be prerendered into a static answer by a change somewhere above this page.
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

export default function TodayPage(props?: { searchParams?: Promise<Search> }) {
  const source = screenSource({
    V2_FIXTURES: process.env.V2_FIXTURES,
    V2_LOCAL_SNAPSHOT: process.env.V2_LOCAL_SNAPSHOT,
    VERCEL_ENV: process.env.VERCEL_ENV,
  });
  if (source === null) notFound();

  return <TodayScreen source={source} searchParams={props?.searchParams} />;
}

/**
 * One parameter, as a string.
 *
 * A repeated parameter arrives as a list, which is not a date and not a week.
 * Neither reader is given anything else to judge: each ignores a value that is
 * not a real day it can use, because a parameter is in a URL and a bad one must
 * not cost the screen.
 */
function oneOf(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The day, from whichever source the gate allowed.
 *
 * Async, and the loopback check is the first thing in it: a request whose Host
 * is not this machine gets no data at all in snapshot mode. The sample is
 * invented and has no such check, so a Vercel preview can show it.
 */
async function TodayScreen({
  source,
  searchParams,
}: {
  source: ScreenSource;
  searchParams?: Promise<Search>;
}) {
  await requireLoopback(source);
  const asked = searchParams === undefined ? {} : await searchParams;
  const week = oneOf(asked.week);

  if (source.kind === "sample") {
    const data = sampleDay();
    return <TodayClient data={week === null ? data : { ...data, calendar: sampleWeek(week) }} />;
  }

  const folder = await readFolder(source.dir, oneOf(asked.date), week);
  if (folder.data === undefined) {
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

  return <TodayClient data={folder.data} />;
}

/**
 * The folder, or the one error it reports. A folder that is missing a file, or
 * has one that cannot be read, is something to go and fix, so it comes back as
 * a value rather than as a thrown error. Anything else still throws.
 *
 * Separate from the component because JSX must not be built inside a try: React
 * renders an element after the function returns, so a catch around it would not
 * catch what it looks like it catches (react-hooks/error-boundaries).
 *
 * The clock is read once and used for both reads, so the day and the week beside
 * it cannot land on different sides of midnight.
 *
 * IT LIVES BELOW `TodayScreen` ON PURPOSE, and a test pins that: every read of
 * the folder has to appear after the awaited loopback check, so that reading the
 * file from the top shows the check first and no later edit can quietly move a
 * read above it. The declaration is hoisted, so the order costs nothing.
 */
async function readFolder(
  dir: string,
  date: string | null,
  week: string | null,
): Promise<{ data: TodayScreenData; error?: undefined } | { data?: undefined; error: string }> {
  try {
    const now = new Date().toISOString();
    const data = await loadLocalToday(dir, now, date);
    if (week === null) return { data };
    // The calendar's own week links land here. The loader ignores a week the
    // snapshot cannot speak for and answers its default week instead, so a stale
    // or hand-typed link shows the week it has rather than an empty grid.
    return { data: { ...data, calendar: await loadLocalCalendar(dir, now, week) } };
  } catch (error) {
    if (error instanceof LocalSnapshotError) return { error: error.message };
    throw error;
  }
}
