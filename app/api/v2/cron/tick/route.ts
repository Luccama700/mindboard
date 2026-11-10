import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { createEngine } from "@/app/lib/v2/engine/sources";
import { runTick } from "@/app/lib/v2/engine/tick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The v2 engine's clock. A pg_cron job posts here every ten minutes
// (supabase/migrations/0067_v2_tick_schedule.sql), reading this route's bearer
// out of Supabase Vault, so the secret is never in the repository.
//
// It runs the tick for every account with the engine switched on, each in its
// own try: one account's failure is counted and the next one still runs. The
// answer is counts only — no account id, no message, nothing a monitor could
// leak — and a doubled post is harmless, because the tick is idempotent.

function authorized(request: Request, expected: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const given = Buffer.from(token, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (given.length !== wanted.length) return false;
  return timingSafeEqual(given, wanted);
}

export async function POST(request: Request) {
  const expected = process.env.V2_CRON_SECRET;
  // Not configured is not the same as refused: with no secret there is nothing
  // to compare, and accepting the post would run the engine for anyone.
  if (!expected) return NextResponse.json({ error: "not configured" }, { status: 503 });
  if (!authorized(request, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { stores, deps } = createEngine();
  // One instant for the whole run, so every account's tick agrees on "now".
  const now = new Date().toISOString();
  const userIds = await stores.users.listEnabled();

  let failed = 0;
  for (const userId of userIds) {
    try {
      const result = await runTick(deps, userId, now);
      if (!result.ok) failed += 1;
    } catch (error) {
      failed += 1;
      const kind = error instanceof Error ? error.name : typeof error;
      console.warn(`v2 cron: the tick threw for ${userId} (${kind})`);
    }
  }

  return NextResponse.json({ users: userIds.length, failed });
}
