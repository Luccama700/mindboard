// Probes: feeds the engine cannot wait for, so it goes and looks instead.
//
// A probe turns the newest thing a system left behind into a FeedRun, which is
// what the watchdog judges. The run carries the instant that thing was written,
// NOT the instant the probe ran: a probe that stamped `now` would make a dead
// worker look alive every ten minutes, which is the one failure this layer
// exists to catch.
//
// The runs a probe returns are evaluated and thrown away, never stored. Storing
// them would write the same heartbeat again every tick, and a run row is the
// record of something that happened, not of something being looked at.

import type { SupabaseClient } from "@supabase/supabase-js";

import type { FeedRun, Instant } from "../types";

/** The feed a probe reports under. */
export const HOME_WORKER_FEED = "home-worker";

/**
 * One look at one system. Returns null when there is nothing to report, which
 * the watchdog reads as "this feed has no run" and therefore as blind.
 */
export type Probe = (userId: string, now: Instant) => Promise<FeedRun | null>;

function run(feed: string, at: Instant, count: number): FeedRun {
  return { feed, startedAt: at, finishedAt: at, status: "ok", count, errorClass: null };
}

function failed(feed: string, at: Instant, errorClass: string): FeedRun {
  return { feed, startedAt: at, finishedAt: at, status: "error", count: 0, errorClass };
}

/**
 * The home worker's newest heartbeat, as a run of the `home-worker` feed. The
 * row is one per user (worker_status), read with the explicit user_id filter
 * every service-client query in this codebase carries.
 */
export function homeWorkerProbe(client: SupabaseClient): Probe {
  return async (userId, now) => {
    const { data, error } = await client
      .from("worker_status")
      .select("last_seen_at")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) return failed(HOME_WORKER_FEED, now, "probe-failed");
    const seenAt = (data as { last_seen_at?: unknown } | null)?.last_seen_at;
    if (typeof seenAt !== "string" || !Number.isFinite(Date.parse(seenAt))) return null;
    return run(HOME_WORKER_FEED, new Date(Date.parse(seenAt)).toISOString(), 1);
  };
}

/** Every probe the tick runs. More arrive later. */
export function createProbes(client: SupabaseClient): Probe[] {
  return [homeWorkerProbe(client)];
}
