// The Today screen. It runs on one of two sources, in this order: the sample
// day when the fixtures flag is on, else a local snapshot of the owner's own
// data when V2_LOCAL_SNAPSHOT points at a folder. Neither reads a database and
// neither needs a session, so this route still has no sign in.
//
// THE FIXTURES GATE. `V2_FIXTURES === "1"` and `VERCEL_ENV !== "production"`,
// exactly as the brief has it, and the reasoning is worth writing down because
// the pair looks redundant and is not:
//
//   - This app is only ever hosted on Vercel, so `VERCEL_ENV` is always set
//     there and is the only thing that distinguishes the production deployment
//     from a preview. A preview is a production BUILD, which is why the test is
//     on the environment and not on NODE_ENV: a preview has to be able to show
//     the sample, and that is the whole point of this route.
//   - `V2_FIXTURES` is never set for the production environment. The flag is the
//     switch; the environment check is the backstop for the day somebody sets it
//     in the wrong place.
//   - What is behind the gate is invented data only: no database read, no
//     session, nothing of anybody's. The worst a leak could do is show a
//     stranger a fictional Wednesday.
//
// THE SNAPSHOT GATE is the same shape and refuses production too, because what
// is behind it is NOT invented: it is a read only copy of one account's own
// data, sitting in a folder on the machine that serves the page. The variable
// is therefore only ever set on a local or preview deployment, and the path has
// to be absolute (`localSnapshotDir`). Nothing a visitor sends takes part in
// any path: the file names inside the folder are literals.
//
// Both checks are pure functions, so each is testable on its own.
//
// WHY THIS PAGE IS NOT ASYNC. Reading the `date` parameter means awaiting
// `searchParams` (Next 16: both props are promises), and reading the folder is
// asynchronous as well, but `notFound()` has to throw where the gate is decided
// rather than inside a promise nobody awaits. So the gate stays synchronous and
// the one branch that needs to wait is a component of its own.
//
// Server and client: the server decides the mode and builds the day (that parses
// the planner rules and, for a snapshot, reads the folder), then hands plain
// data to one client component. The planner itself then runs in the browser, so
// Start, Done, Not today and the energy options are real replans.

import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { fixturesEnabled, sampleDay } from "@/app/lib/v2/fixtures/sample-day";
import {
  LocalSnapshotError,
  loadLocalToday,
  localSnapshotDir,
} from "@/app/lib/v2/local/snapshot";
import type { TodayScreenData } from "@/app/lib/v2/view/screen-data";
import { TodayClient } from "./today-client";

export const metadata: Metadata = {
  title: "Today",
};

// The gates read environment variables and the snapshot branch reads the clock,
// so this has to run per request rather than once at build time. Declared here
// rather than left to whatever the root layout happens to do, so the gate cannot
// be prerendered into a static answer by a change somewhere above this page.
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

export default function TodayPage(props?: { searchParams?: Promise<Search> }) {
  if (
    fixturesEnabled({
      V2_FIXTURES: process.env.V2_FIXTURES,
      VERCEL_ENV: process.env.VERCEL_ENV,
    })
  ) {
    return <TodayClient data={sampleDay()} />;
  }

  const dir = localSnapshotDir({
    V2_LOCAL_SNAPSHOT: process.env.V2_LOCAL_SNAPSHOT,
    VERCEL_ENV: process.env.VERCEL_ENV,
  });
  if (dir === null) notFound();

  return <LocalToday dir={dir} searchParams={props?.searchParams} />;
}

/**
 * The folder, or the one error it reports. A folder that is missing a file, or
 * has one that cannot be read, is something to go and fix, so it comes back as
 * a value rather than as a thrown error. Anything else still throws.
 *
 * Separate from the component because JSX must not be built inside a try: React
 * renders an element after the function returns, so a catch around it would not
 * catch what it looks like it catches (react-hooks/error-boundaries).
 */
async function readFolder(
  dir: string,
  date: string | null,
): Promise<{ data: TodayScreenData; error?: undefined } | { data?: undefined; error: string }> {
  try {
    return { data: await loadLocalToday(dir, new Date().toISOString(), date) };
  } catch (error) {
    if (error instanceof LocalSnapshotError) return { error: error.message };
    throw error;
  }
}

/** The day from the snapshot folder, or a panel naming the file that is wrong. */
async function LocalToday({
  dir,
  searchParams,
}: {
  dir: string;
  searchParams?: Promise<Search>;
}) {
  const asked = searchParams === undefined ? {} : await searchParams;
  // A repeated parameter arrives as a list, which is not a date. The loader
  // ignores anything that is not a real day near today.
  const date = typeof asked.date === "string" ? asked.date : null;
  const folder = await readFolder(dir, date);

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
