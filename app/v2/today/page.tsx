// The Today screen. In this slice it runs on the sample day only: no database,
// no sign in, no session. Task 7 adds the live branch beside the fixture one.
//
// THE GATE. `V2_FIXTURES === "1"` and `VERCEL_ENV !== "production"`, exactly as
// the brief has it, and the reasoning is worth writing down because the pair
// looks redundant and is not:
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
// The check is pure (`fixturesEnabled`) so it is testable on its own.
//
// Server and client: the server decides fixture mode and builds the sample (that
// parses the planner rules, which the browser has no use for), then hands plain
// data to one client component. The planner itself then runs in the browser, so
// Start, Done, Not today and the energy options are real replans.

import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { fixturesEnabled, sampleDay } from "@/app/lib/v2/fixtures/sample-day";
import { TodayClient } from "./today-client";

export const metadata: Metadata = {
  title: "Today",
};

// The gate reads two environment variables, so it has to run per request rather
// than once at build time. Declared here rather than left to whatever the root
// layout happens to do, so the gate cannot be prerendered into a static answer
// by a change somewhere above this page.
export const dynamic = "force-dynamic";

export default function TodayPage() {
  if (
    !fixturesEnabled({
      V2_FIXTURES: process.env.V2_FIXTURES,
      VERCEL_ENV: process.env.VERCEL_ENV,
    })
  ) {
    notFound();
  }

  return <TodayClient sample={sampleDay()} />;
}
