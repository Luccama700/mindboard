// The desk: one workspace of tiled panes, in four layouts of the same fourteen
// panes, on a big screen, a laptop and a phone.
//
// /v2/desk?layout=<id>, with `date` and `week` read as Today reads them. In this
// task nothing on it can be moved: it opens on the layout the address names, in
// the default arrangement for whatever size the window is, and switching layout
// changes it. The saved layout (a cookie) is read by a later task.
//
// It is gated exactly as Today is, and for the same reasons, which are written
// out at the top of app/v2/today/page.tsx and in app/lib/v2/source.ts: the gate
// decides synchronously, so a route that is switched off answers a real 404
// before anything streams; the loopback check is the first statement of the
// async child; and every read comes after it. It loads the WHOLE desk (the day,
// the quests and the money of one request), because a pane reads its data from
// the desk's providers and never from a source of its own.

import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { sampleDesk } from "@/app/lib/v2/fixtures/sample-desk";
import { loadLocalDesk } from "@/app/lib/v2/local/desk";
import { LocalSnapshotError } from "@/app/lib/v2/local/snapshot";
import { requireLoopback, screenSource, type ScreenSource } from "@/app/lib/v2/source";
import { EMPTY_TILE_SET, setCurrent, type TileSet } from "@/app/lib/v2/tiles";
import { DESK_COPY } from "@/app/lib/v2/view/desk";
import type { DeskScreenData } from "@/app/lib/v2/view/desk-data";
import { SnapshotError } from "../_components/snapshot-error";
import { DeskClient } from "../_desk/desk-client";

export const metadata: Metadata = {
  title: DESK_COPY.heading,
};

// The gate reads environment variables and the snapshot branch reads the clock,
// so this runs per request rather than once at build time.
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

export default function DeskPage(props?: { searchParams?: Promise<Search> }) {
  const source = screenSource({
    V2_FIXTURES: process.env.V2_FIXTURES,
    V2_LOCAL_SNAPSHOT: process.env.V2_LOCAL_SNAPSHOT,
    VERCEL_ENV: process.env.VERCEL_ENV,
  });
  if (source === null) notFound();

  return <DeskScreen source={source} searchParams={props?.searchParams} />;
}

/**
 * One parameter, as a string. A repeated parameter arrives as a list, which is
 * not any one value, so it is read as absent.
 */
function oneOf(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The desk the address asks for. In this task it is the empty desk, opened on
 * the layout named: one it does not have, or a hidden one, is refused by the
 * engine and the desk's own current layout is drawn instead.
 */
function deskSet(layout: string | null): TileSet {
  return layout === null ? EMPTY_TILE_SET : setCurrent(EMPTY_TILE_SET, layout);
}

/**
 * The request's `date`, when it is the day that was planned: the one every link
 * on the desk carries back. A date the source ignored changed nothing, and is
 * not carried (Today's rule).
 */
function keptDate(date: string | null, data: DeskScreenData): string | null {
  return date !== null && date === data.today.input.date ? date : null;
}

/**
 * The desk, from whichever source the gate allowed. The loopback check is the
 * first thing in it: a request whose Host is not this machine gets no data at
 * all in snapshot mode.
 */
async function DeskScreen({
  source,
  searchParams,
}: {
  source: ScreenSource;
  searchParams?: Promise<Search>;
}) {
  await requireLoopback(source);
  const asked = searchParams === undefined ? {} : await searchParams;
  const layout = oneOf(asked.layout);
  const date = oneOf(asked.date);
  const week = oneOf(asked.week);
  const initial = deskSet(layout);

  if (source.kind === "sample") {
    const data = sampleDesk(week);
    return <DeskClient data={data} initial={initial} date={keptDate(date, data)} />;
  }

  const folder = await readFolder(source.dir, date, week);
  if (folder.data === undefined) return <SnapshotError message={folder.error} />;

  return <DeskClient data={folder.data} initial={initial} date={keptDate(date, folder.data)} />;
}

/**
 * The folder's desk, or the one error it reports. A folder whose day cannot be
 * read has no desk to show, so that comes back as a value for the error screen;
 * a quest or money file that cannot be read is already a note on the desk (see
 * loadLocalDesk). Anything else still throws.
 *
 * Separate from the component because JSX must not be built inside a try: React
 * renders an element after the function returns, so a catch around it would not
 * catch what it looks like it catches (react-hooks/error-boundaries).
 */
async function readFolder(
  dir: string,
  date: string | null,
  week: string | null,
): Promise<{ data: DeskScreenData; error?: undefined } | { data?: undefined; error: string }> {
  try {
    return { data: await loadLocalDesk(dir, new Date().toISOString(), date, week) };
  } catch (error) {
    if (error instanceof LocalSnapshotError) return { error: error.message };
    throw error;
  }
}
