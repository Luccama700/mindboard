// What a v2 page may show, decided in one place.
//
// There are two sources on this branch and neither reads a database: the sample
// day, which is invented, and a read only snapshot folder of one account's own
// data. The three checks below used to be written out inside the Today page.
// They are here because a second page now needs the same three, and two copies
// of a gate is how one of them comes to be wrong. Every page under app/v2 asks
// this module and reads no environment variable itself; a test pins that.
//
// THE FIXTURES CHECK is `V2_FIXTURES === "1"` and `VERCEL_ENV !== "production"`,
// and the pair looks redundant and is not:
//
//   - This app is only ever hosted on Vercel, so `VERCEL_ENV` is always set
//     there and is the only thing that distinguishes the production deployment
//     from a preview. A preview is a production BUILD, which is why the test is
//     on the environment and not on NODE_ENV: a preview has to be able to show
//     the sample, and that is the whole point of these routes.
//   - `V2_FIXTURES` is never set for the production environment. The flag is the
//     switch; the environment check is the backstop for the day somebody sets it
//     in the wrong place.
//   - What is behind it is invented data only: no database read, no session,
//     nothing of anybody's. The worst a leak could do is show a stranger a
//     fictional Wednesday.
//
// THE SNAPSHOT CHECK is the same shape and refuses production too, because what
// is behind it is NOT invented: it is a read only copy of one account's own
// data, sitting in a folder on the machine that serves the page. The variable is
// therefore only ever set on a local or preview deployment, and the path has to
// be absolute (`localSnapshotDir`). Nothing a visitor sends takes part in any
// path: the file names inside the folder are literals.
//
// THE SAMPLE WINS when both are set, exactly as the page used to decide it.
//
// WHAT "LOCAL" DOES NOT MEAN. Neither source asks who is asking, so each shows
// whatever it is built from to ANYONE WHO CAN REACH THIS SERVER. In snapshot
// mode that is every open task title, the planner rules and the account's id, in
// the page payload. `next dev` and `next start` bind to 0.0.0.0 by default,
// which is every interface on the machine, so the server has to be started on
// the loopback address instead (`-H 127.0.0.1`). NOTHING HERE CAN ENFORCE THAT:
// by the time a request arrives it has already been accepted, and the address it
// came from is the proxy's business, not the page's.
//
// So snapshot mode has a speed bump, and `requireLoopback` is labelled as one.
// The sample has no such check, deliberately: what is behind it is invented, and
// a Vercel preview is exactly where it is meant to be looked at, which a
// loopback check would make impossible. Only real data is worth a speed bump.
//
// WHICH WAY THE IMPORTS RUN. This module reads `localSnapshotDir` from the
// snapshot loader, where the rest of the folder's rules live, and the loader
// never reads anything from here. The loopback check that both of them need is a
// leaf of its own (./loopback.ts), re-exported from both, because when it lived
// in either the two imported each other, and a cycle held up by a comment is a
// trap for whoever edits next. A test pins the direction.

import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { fixturesEnabled } from "@/app/lib/v2/fixtures/sample-day";
import { localSnapshotDir } from "@/app/lib/v2/local/snapshot";
import { isLoopbackHost } from "@/app/lib/v2/loopback";

// Re-exported so the gate is still one import for a caller that needs both.
export { isLoopbackHost };

/** Where a v2 page's data comes from. There is no third one on this branch. */
export type ScreenSource = { kind: "sample" } | { kind: "local"; dir: string };

/**
 * What this page may show, or null for nothing at all.
 *
 * Pure and synchronous on purpose, so a page can refuse with a real 404 before
 * anything streams: once a loading fallback has rendered the server has already
 * committed to 200 to start the stream, and a `notFound()` after an await cannot
 * change the status any more.
 */
export function screenSource(env: {
  V2_FIXTURES?: string;
  V2_LOCAL_SNAPSHOT?: string;
  VERCEL_ENV?: string;
}): ScreenSource | null {
  if (fixturesEnabled(env)) return { kind: "sample" };
  const dir = localSnapshotDir(env);
  return dir === null ? null : { kind: "local", dir };
}

/**
 * The speed bump, for a local source only.
 *
 * A request whose Host is not the loopback address is shown the not-found page
 * and no data at all: it is told nothing about what it nearly reached, and the
 * header it sent is not repeated anywhere, not on the page and not in a log.
 *
 * It may well be shown that page with a 200 rather than a 404, because this runs
 * inside the async half of a page and `app/loading.tsx` wraps these routes (the
 * streaming guide, "Status codes"). The status is cosmetic here: what matters is
 * that the owner's day is not in the response, and it is not.
 */
export async function requireLoopback(source: ScreenSource): Promise<void> {
  if (source.kind === "sample") return;
  const host = (await headers()).get("host");
  if (!isLoopbackHost(host)) notFound();
}
