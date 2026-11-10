import { NextResponse } from "next/server";

import { parseUpdate, verifySecret } from "@/app/lib/v2/channel/telegram";
import { callbackMessage, handleIncoming } from "@/app/lib/v2/engine/incoming";
import { createEngine } from "@/app/lib/v2/engine/sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Telegram's door. Two rules shape it.
//
// 1. The secret header is the only thing that gets past the top: anyone can
//    post here, so an update is not an update until it carries the token this
//    bot's webhook was registered with (compared in constant time).
// 2. After that it always answers 200. Telegram retries anything else, and a
//    retry of an update the engine cannot handle would repeat forever. The
//    engine is idempotent, so a retry of one it CAN handle is harmless.
//
// The update body is data, never instructions: nothing in it chooses an account
// (a chat id maps to one only through a redeemed pairing code), and the two
// values taken from it, the message id and the message's own text, are echoed
// back to that same chat and nowhere else.

export async function POST(request: Request) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  if (!verifySecret(request.headers.get("x-telegram-bot-api-secret-token"), expected)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  try {
    const body: unknown = await request.json();
    const incoming = parseUpdate(body);
    if (incoming !== null) {
      const { deps } = createEngine();
      const message = callbackMessage(body);
      await handleIncoming(deps, incoming, new Date().toISOString(), {
        chatMessageId: message.messageId,
        chatMessageText: message.text,
      });
    }
  } catch (error) {
    // One line, the class only: an update body can carry a person's own words.
    const kind = error instanceof Error ? error.name : typeof error;
    console.warn(`v2 webhook: update not handled (${kind})`);
  }

  return NextResponse.json({ ok: true });
}
