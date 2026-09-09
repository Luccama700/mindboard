import { NextResponse } from "next/server";
import { authenticateWatch, failed, readJsonBody, respond } from "@/app/lib/watch/http";
import { validateTaskId } from "@/app/lib/watch/protocol";
import { missTaskFromWatch } from "@/app/lib/watch/writes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// { id } — mark a task missed (didn't do it), via the MCP miss_task executor.

export async function POST(request: Request) {
  const auth = authenticateWatch(request);
  if (auth instanceof NextResponse) return auth;
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  const parsed = validateTaskId(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    return respond(await missTaskFromWatch(auth.userId, parsed.value.id, auth.idempotencyKey));
  } catch (error) {
    return failed(error);
  }
}
