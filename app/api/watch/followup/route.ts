import { NextResponse } from "next/server";
import { authenticateWatch, failed, readJsonBody, respond } from "@/app/lib/watch/http";
import { queueFollowupFromWatch } from "@/app/lib/watch/followup";
import { validateFollowup } from "@/app/lib/watch/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// { id, text } — queue a dictated follow-up on a task for the home worker's
// Claude Code run. The original task stays open.

export async function POST(request: Request) {
  const auth = authenticateWatch(request);
  if (auth instanceof NextResponse) return auth;
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  const parsed = validateFollowup(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    const { id, text } = parsed.value;
    return respond(await queueFollowupFromWatch(auth.userId, id, text, auth.idempotencyKey));
  } catch (error) {
    return failed(error);
  }
}
