// The Today screen. In this slice it runs on the sample day only: no database,
// no sign in, no session. Task 7 adds the live branch beside the fixture one.
//
// The gate is deliberately strict and deliberately pure (`fixturesEnabled`, so
// it is testable): the flag has to be exactly "1" AND the deployment must not be
// production. Anything else is a 404, so a route that serves invented data can
// never appear on the real site by accident.
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
