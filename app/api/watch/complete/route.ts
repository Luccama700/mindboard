import { NextResponse } from "next/server";
import { authenticateWatch, failed, readJsonBody, respond } from "@/app/lib/watch/http";
import { validateComplete } from "@/app/lib/watch/protocol";
import {
  completeRecurringFromWatch,
  completeTaskFromWatch,
} from "@/app/lib/watch/writes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// { type: "task" | "recurring", id } — the MCP complete_task /
// complete_recurring_task executors (recurring: today's occurrence only).

export async function POST(request: Request) {
  const auth = authenticateWatch(request);
  if (auth instanceof NextResponse) return auth;
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  const parsed = validateComplete(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    const { type, id } = parsed.value;
    return respond(
      type === "task"
        ? await completeTaskFromWatch(auth.userId, id, auth.idempotencyKey)
        : await completeRecurringFromWatch(auth.userId, id, auth.idempotencyKey),
    );
  } catch (error) {
    return failed(error);
  }
}
