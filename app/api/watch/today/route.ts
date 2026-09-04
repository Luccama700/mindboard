import { NextResponse } from "next/server";
import { authenticateWatch, failed } from "@/app/lib/watch/http";
import { getWatchToday } from "@/app/lib/watch/reads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// The watch's one read: overdue + due-today tasks, today's routines with done
// state, the next timed event, and free hours left — sized for a glance.

export async function GET(request: Request) {
  const auth = authenticateWatch(request);
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json(await getWatchToday(auth.userId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return failed(error);
  }
}
