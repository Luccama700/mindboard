import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { createEngine } from "@/app/lib/v2/engine/sources";
import { ENGINE_TICK_FEED, TICK_DEADLINE_MS, runTick } from "@/app/lib/v2/engine/tick";
import type { Stores } from "@/app/lib/v2/store/types";

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

/** The tick took longer than TICK_DEADLINE_MS and was abandoned. */
class TickDeadline extends Error {
  constructor() {
    super("the tick did not finish in time");
    this.name = "TickDeadline";
  }
}

/**
 * One account's tick, under a deadline. Returns true when it finished and said
 * ok.
 *
 * The accounts run one after another (deliberately: the engine writes, and
 * running them at once would multiply the load on every table at the same
 * instant), so an account whose tick hangs would spend the whole sixty seconds
 * and leave every later account with no tick at all and no `engine-tick` run to
 * show it. After the deadline this one is abandoned, its own `engine-tick` run
 * is written with class `timeout`, and the next account starts.
 *
 * The abandoned tick keeps running until the function ends: there is nothing to
 * cancel it with, and whatever it was doing is idempotent, so the worst it can
 * do is finish late and write its own run.
 */
async function tickWithin(
  stores: Stores,
  deps: Parameters<typeof runTick>[0],
  userId: string,
  now: string,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TickDeadline()), TICK_DEADLINE_MS);
  });
  try {
    const result = await Promise.race([runTick(deps, userId, now), deadline]);
    return result.ok;
  } catch (error) {
    if (error instanceof TickDeadline) {
      try {
        await stores.feeds.addRun(userId, {
          feed: ENGINE_TICK_FEED,
          startedAt: now,
          finishedAt: now,
          status: "error",
          count: 0,
          errorClass: "timeout",
        });
      } catch {
        // Nothing left to report it with; the count below still says it failed.
      }
    }
    const kind = error instanceof Error ? error.name : typeof error;
    console.warn(`v2 cron: the tick did not finish for ${userId} (${kind})`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

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
    if (!(await tickWithin(stores, deps, userId, now))) failed += 1;
  }

  return NextResponse.json({ users: userIds.length, failed });
}
