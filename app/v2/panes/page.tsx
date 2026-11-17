// The pane gallery: one pane of the desk, alone, in a box of a fixed size.
//
// /v2/panes?pane=<id>&w=<px>&h=<px>, with the pane's options as ?o.<key>=<value>.
// It is how a pane is looked at at 230, 464 and 1300 px wide before the desk it
// belongs on exists. It is not linked from anywhere.
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
import { sampleMoneyStale } from "@/app/lib/v2/fixtures/sample-money";
import { loadLocalDesk } from "@/app/lib/v2/local/desk";
import { LocalSnapshotError } from "@/app/lib/v2/local/snapshot";
import { requireLoopback, screenSource, type ScreenSource } from "@/app/lib/v2/source";
import type { DeskScreenData } from "@/app/lib/v2/view/desk-data";
import { galleryKeep, galleryRequest } from "@/app/lib/v2/view/desk";
import { SnapshotError } from "../_components/snapshot-error";
import { GalleryClient } from "./gallery-client";

export const metadata: Metadata = {
  title: "Panes",
};

// The gate reads environment variables and the snapshot branch reads the clock,
// so this runs per request rather than once at build time.
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

export default function PanesPage(props?: { searchParams?: Promise<Search> }) {
  const source = screenSource({
    V2_FIXTURES: process.env.V2_FIXTURES,
    V2_LOCAL_SNAPSHOT: process.env.V2_LOCAL_SNAPSHOT,
    VERCEL_ENV: process.env.VERCEL_ENV,
  });
  if (source === null) notFound();

  return <PanesScreen source={source} searchParams={props?.searchParams} />;
}

/**
 * The desk, from whichever source the gate allowed, and the one pane asked for.
 * The loopback check is the first thing in it: a request whose Host is not this
 * machine gets no data at all in snapshot mode.
 *
 * The planned day keys the day inside the client (see GalleryClient), so a week
 * link on the same day keeps every press made in the pane.
 */
async function PanesScreen({
  source,
  searchParams,
}: {
  source: ScreenSource;
  searchParams?: Promise<Search>;
}) {
  await requireLoopback(source);
  const asked = galleryRequest(searchParams === undefined ? {} : await searchParams);

  // `?stale=1` swaps in the sample's money as it looks when the ledger is
  // months old, so every Money pane can be seen leading with how old its
  // numbers are. The sample only: a snapshot's money is as old as it is.
  if (source.kind === "sample") {
    const fresh = sampleDesk(asked.week);
    const desk = asked.stale ? { ...fresh, money: sampleMoneyStale(fresh.today) } : fresh;
    return (
      <GalleryClient
        data={desk}
        paneId={asked.paneId}
        width={asked.width}
        height={asked.height}
        options={asked.options}
        keep={galleryKeep(asked, desk.today.input.date)}
      />
    );
  }

  const folder = await readFolder(source.dir, asked.date, asked.week);
  if (folder.data === undefined) return <SnapshotError message={folder.error} />;

  return (
    <GalleryClient
      data={folder.data}
      paneId={asked.paneId}
      width={asked.width}
      height={asked.height}
      options={asked.options}
      keep={galleryKeep(asked, folder.data.today.input.date)}
    />
  );
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
