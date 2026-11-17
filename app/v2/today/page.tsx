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
import { LocalSnapshotError, loadLocalToday } from "@/app/lib/v2/local/snapshot";
import { requireLoopback, screenSource, type ScreenSource } from "@/app/lib/v2/source";
import type { TodayScreenData } from "@/app/lib/v2/view/screen-data";
import { SnapshotError } from "../_components/snapshot-error";
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
 *
 * THE SCREEN IS KEYED ON THE DAY IT PLANS. Its state is a plan for one day, and
 * client state survives a navigation that changes only the search parameters.
 * So a week link that comes back with another planned day (one pressed after the
 * planning date rolled over) starts the screen again, while a week link on the
 * same day keeps every press.
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
  const date = oneOf(asked.date);
  const week = oneOf(asked.week);

  if (source.kind === "sample") {
    const data = sampleDay();
    return (
      <TodayClient
        key={data.input.date}
        data={week === null ? data : { ...data, calendar: sampleWeek(week) }}
        keep={keptDate(date, data)}
      />
    );
  }

  const folder = await readFolder(source.dir, date, week);
  if (folder.data === undefined) return <SnapshotError message={folder.error} />;

  return (
    <TodayClient key={folder.data.input.date} data={folder.data} keep={keptDate(date, folder.data)} />
  );
}

/**
 * What the calendar's week links carry back besides the week: the `date` this
 * request asked for, when it is the day that was planned. A link that dropped it
 * planned the clock's day instead, beside a screen still showing the other one.
 *
 * A date the source ignored (not a real day, too far off, or a sample that has
 * only its own day) is not carried: it changed nothing, and the link would only
 * repeat it.
 */
function keptDate(
  date: string | null,
  data: TodayScreenData,
): Readonly<Record<string, string>> | undefined {
  return date !== null && date === data.input.date ? { date } : undefined;
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
 * ONE CALL. The day and the week beside it come out of the same reads of the
 * folder on the same clock, so they cannot land on different sides of midnight,
 * and a `week` the folder cannot use falls back to the week of the day being
 * shown rather than the week of the clock.
 *
 * IT LIVES BELOW `TodayScreen`, so reading the file from the top shows the
 * awaited loopback check before any read of the folder. That is for the reader:
 * the gate check in __tests__/v2-source.test.ts reads the syntax tree and does
 * not care where the helper is written, only that every call to it waits for
 * the check. The declaration is hoisted, so the order costs nothing.
 */
async function readFolder(
  dir: string,
  date: string | null,
  week: string | null,
): Promise<{ data: TodayScreenData; error?: undefined } | { data?: undefined; error: string }> {
  try {
    return { data: await loadLocalToday(dir, new Date().toISOString(), date, week) };
  } catch (error) {
    if (error instanceof LocalSnapshotError) return { error: error.message };
    throw error;
  }
}
