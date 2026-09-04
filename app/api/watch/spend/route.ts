import { NextResponse } from "next/server";
import { authenticateWatch, failed, readJsonBody, respond } from "@/app/lib/watch/http";
import { validateSpend } from "@/app/lib/watch/protocol";
import { logSpendFromWatch } from "@/app/lib/watch/writes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// { amount, note? } → a spend today against the default (oldest active)
// account, via the MCP log_spend executor.

export async function POST(request: Request) {
  const auth = authenticateWatch(request);
  if (auth instanceof NextResponse) return auth;
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  const parsed = validateSpend(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    const { amount, note } = parsed.value;
    return respond(
      await logSpendFromWatch(auth.userId, amount, note, auth.idempotencyKey),
    );
  } catch (error) {
    return failed(error);
  }
}
