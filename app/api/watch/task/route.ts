import { NextResponse } from "next/server";
import { authenticateWatch, failed, readJsonBody, respond } from "@/app/lib/watch/http";
import { validateTaskTitle } from "@/app/lib/watch/protocol";
import { createTaskFromWatch } from "@/app/lib/watch/writes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// { title } → an inbox task (no group, no date, priority med).

export async function POST(request: Request) {
  const auth = authenticateWatch(request);
  if (auth instanceof NextResponse) return auth;
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  const parsed = validateTaskTitle(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    return respond(
      await createTaskFromWatch(auth.userId, parsed.value.title, auth.idempotencyKey),
    );
  } catch (error) {
    return failed(error);
  }
}
