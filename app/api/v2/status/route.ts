import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { createEngine } from "@/app/lib/v2/engine/sources";
import { tickStatus } from "@/app/lib/v2/engine/tick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Is the clock running? One question, for a monitor, behind its own secret.
//
// It answers about the ENGINE, never about an account: the newest tick across
// every enabled account, how stale that is, and whether that is acceptable. No
// account id, no count of accounts, no message. A monitoring endpoint is a
// place a credential leaks from eventually, so there is nothing here to leak.
//
// What counts as stale (thirty minutes, three missed ticks) belongs to
// `tickStatus`, so the rule is stated once and unit-tested there.

function authorized(request: Request, expected: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const given = Buffer.from(token, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (given.length !== wanted.length) return false;
  return timingSafeEqual(given, wanted);
}

export async function GET(request: Request) {
  const expected = process.env.V2_STATUS_SECRET;
  if (!expected) return NextResponse.json({ error: "not configured" }, { status: 503 });
  if (!authorized(request, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { stores } = createEngine();
  return NextResponse.json(await tickStatus(stores, new Date().toISOString()));
}
