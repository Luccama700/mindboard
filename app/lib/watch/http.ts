import "server-only";
import { NextResponse } from "next/server";
import {
  parseWatchTokenMap,
  readIdempotencyKey,
  resolveWatchUserId,
} from "./protocol";
import type { WatchWriteOutcome } from "./writes";

// Request-level glue shared by every /api/watch/* handler: bearer → user id
// (401 otherwise), JSON body parsing, and the outcome → response mapping.

export type WatchRequestContext = { userId: string; idempotencyKey: string | null };

export function authenticateWatch(
  request: Request,
): WatchRequestContext | NextResponse {
  const tokens = parseWatchTokenMap(
    process.env.WATCH_TOKEN,
    process.env.MINDBOARD_OWNER_USER_ID,
  );
  const userId = resolveWatchUserId(request.headers.get("authorization"), tokens);
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="mindboard-watch"' } },
    );
  }
  return {
    userId,
    idempotencyKey: readIdempotencyKey(request.headers.get("idempotency-key")),
  };
}

export async function readJsonBody(request: Request): Promise<unknown | NextResponse> {
  try {
    return await request.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
}

export function respond(outcome: WatchWriteOutcome): NextResponse {
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }
  return NextResponse.json({ ok: true, replayed: outcome.replayed, ...outcome.result });
}

export function failed(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : "unexpected error";
  return NextResponse.json({ error: message }, { status: 500 });
}
