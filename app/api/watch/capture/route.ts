import { NextResponse } from "next/server";
import { authenticateWatch, failed, readJsonBody, respond } from "@/app/lib/watch/http";
import { validateCaptureText } from "@/app/lib/watch/protocol";
import { captureFromWatch } from "@/app/lib/watch/writes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// { text } → capture_to_brain (vault Inbox/ note, source "apple watch").

export async function POST(request: Request) {
  const auth = authenticateWatch(request);
  if (auth instanceof NextResponse) return auth;
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  const parsed = validateCaptureText(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    return respond(
      await captureFromWatch(auth.userId, parsed.value.text, auth.idempotencyKey),
    );
  } catch (error) {
    return failed(error);
  }
}
