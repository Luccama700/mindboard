// /v2: the way in. It sends the visitor to the desk and shows nothing itself.
//
// It is gated exactly as every page under app/v2 is, and for the same reasons,
// which are written out at the top of app/v2/today/page.tsx: the gate decides
// synchronously, so a route that is switched off answers a real 404 before
// anything streams, and the redirect, which has to wait for the loopback check
// and for the search parameters, lives in the async child. It reads no data.
//
// Three search parameters are carried over to the desk, `date`, `week` and
// `layout`, and only when the value is a short plain token. Anything else is
// dropped: the address is somebody else's text, and the desk reads each of the
// three for itself and judges it again.

import { notFound, redirect } from "next/navigation";

import { requireLoopback, screenSource, type ScreenSource } from "@/app/lib/v2/source";

// The gate reads environment variables, so this runs per request rather than
// once at build time.
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

/** The only parameters that go on to the desk. */
const CARRIED = ["date", "week", "layout"] as const;

const PLAIN_TOKEN = /^[A-Za-z0-9-]{1,40}$/;

export default function V2RootPage(props?: { searchParams?: Promise<Search> }) {
  const source = screenSource({
    V2_FIXTURES: process.env.V2_FIXTURES,
    V2_LOCAL_SNAPSHOT: process.env.V2_LOCAL_SNAPSHOT,
    VERCEL_ENV: process.env.VERCEL_ENV,
  });
  if (source === null) notFound();

  return <Onward source={source} searchParams={props?.searchParams} />;
}

/**
 * The address on the desk: its three keys, each kept only when it is one plain
 * string. A repeated parameter arrives as a list, which is not any one value.
 */
function deskAddress(asked: Search): string {
  const kept = new URLSearchParams();
  for (const key of CARRIED) {
    const value = asked[key];
    if (typeof value === "string" && PLAIN_TOKEN.test(value)) kept.set(key, value);
  }
  const query = kept.toString();
  return query === "" ? "/v2/desk" : `/v2/desk?${query}`;
}

/** The redirect, after the loopback check like every other child. */
async function Onward({
  source,
  searchParams,
}: {
  source: ScreenSource;
  searchParams?: Promise<Search>;
}): Promise<never> {
  await requireLoopback(source);
  const asked = searchParams === undefined ? {} : await searchParams;
  redirect(deskAddress(asked));
}
