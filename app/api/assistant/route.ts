import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";

import { createClient } from "@/utils/supabase/server";
import { decryptSecret } from "@/app/lib/assistant/crypto";
import {
  ASSISTANT_TOOLS,
  runAssistantTool,
} from "@/app/lib/assistant/tools";
import { todayKey } from "@/app/lib/mcp/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MODELS = new Set([
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5",
]);
const DEFAULT_MODEL = "claude-opus-4-8";
const MAX_LOOPS = 8;
const HISTORY_LIMIT = 30;

const INSTRUCTIONS = `You are Mindboard's planning copilot — a calm, terse planning partner living inside the owner's personal life dashboard (tasks, schedule, money, stock levels, goals, daily check-ins).

Ground rules:
- Start almost every conversation by calling get_snapshot; plan from live data, never memory. For anything spanning more than today (a week, an evening a few days out), call it with verbose:true (or horizonDays) to get per-day free gaps, upcoming bills, and the days' recurring occurrences.
- Writes are proposals. Every propose_* tool records a proposal the user must confirm with a tap — never claim something was created, scheduled, or logged; say it "awaits your confirm."
- Finance writes are propose-only: propose_log_spend for a single spend today, propose_update_finance for anything dated, batched, or statement-shaped (imports, corrections, transfers, reconciles). Never claim a balance changed until the user confirms.
- Anything recurring ("every day", "every monday", "mon/wed/fri") is ONE propose_create_recurring_task rule, never N individual tasks; occurrences appear on their own each day they land.
- When planning a day or evening, weigh the free gaps, due tasks, energy from recent check-ins, and quiet goals. Prefer placing 1-3 concrete blocks over exhaustive schedules.
- Be brief and lowercase-calm like the app. One-line rationale per suggestion, no filler, no headers unless listing a plan.
- When the user references "this" (a pinned task/note), it is included in the message context.`;

type SseEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "text"; delta: string }
  | { type: "tool"; name: string }
  | { type: "proposal"; proposalId: string; preview: string }
  | { type: "done" }
  | { type: "error"; message: string };

function sse(event: SseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { message?: string; conversationId?: string; model?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const message = body.message?.trim();
  if (!message) return NextResponse.json({ error: "message required" }, { status: 400 });
  const model = MODELS.has(body.model ?? "") ? body.model! : DEFAULT_MODEL;

  // The key: decrypted here and only here; never logged, never returned.
  const { data: settings } = await supabase
    .from("user_settings")
    .select("anthropic_api_key")
    .eq("user_id", user.id)
    .maybeSingle();
  const encrypted = settings?.anthropic_api_key as string | null | undefined;
  if (!encrypted) {
    return NextResponse.json({ error: "no api key" }, { status: 409 });
  }
  let apiKey: string;
  try {
    apiKey = decryptSecret(encrypted);
  } catch {
    return NextResponse.json({ error: "key unreadable — paste it again in settings" }, { status: 409 });
  }

  // Conversation bootstrap + history.
  let conversationId = body.conversationId ?? null;
  if (conversationId) {
    const { data } = await supabase
      .from("ai_conversations")
      .select("id")
      .eq("id", conversationId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!data) conversationId = null;
  }
  if (!conversationId) {
    const { data, error } = await supabase
      .from("ai_conversations")
      .insert({ user_id: user.id, title: message.slice(0, 80) })
      .select("id")
      .single();
    if (error || !data) {
      return NextResponse.json({ error: "conversation failed" }, { status: 500 });
    }
    conversationId = data.id as string;
  }

  const { data: historyRows } = await supabase
    .from("ai_messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(HISTORY_LIMIT);

  await supabase.from("ai_messages").insert({
    conversation_id: conversationId,
    user_id: user.id,
    role: "user",
    content: message,
  });

  // Live planning fuel: goals + the last week of daily logs. `today` resolves
  // in the user's zone — the process clock is UTC on Vercel, so a bare
  // todayISO() would tell the model tomorrow's date all evening.
  const [todayLocal, goalsResult, logsResult] = await Promise.all([
    todayKey(supabase, user.id),
    supabase
      .from("goals")
      .select("title, why, horizon, status, target_date")
      .eq("status", "active"),
    supabase
      .from("daily_logs")
      .select("log_date, mood, energy, sleep_hours")
      .order("log_date", { ascending: false })
      .limit(7),
  ]);
  const context = `today: ${todayLocal}
active goals: ${JSON.stringify(goalsResult.data ?? [])}
last check-ins (mood/energy 1-5): ${JSON.stringify(logsResult.data ?? [])}`;

  const anthropic = new Anthropic({ apiKey });

  const messages: Anthropic.MessageParam[] = [
    ...((historyRows ?? []) as { role: "user" | "assistant"; content: string }[])
      .filter((row) => row.content.trim().length > 0)
      .map((row) => ({ role: row.role, content: row.content })),
    { role: "user" as const, content: message },
  ];

  const finalConversationId = conversationId;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: SseEvent) =>
        controller.enqueue(encoder.encode(sse(event)));
      send({ type: "conversation", conversationId: finalConversationId });

      let assistantTranscript = "";

      try {
        for (let loop = 0; loop < MAX_LOOPS; loop++) {
          const response = anthropic.messages.stream({
            model,
            max_tokens: 16000,
            // Haiku 4.5 supports neither adaptive thinking nor the effort
            // param; the others default to high thinking effort.
            ...(model === "claude-haiku-4-5"
              ? {}
              : {
                  thinking: { type: "adaptive" as const },
                  output_config: { effort: "high" as const },
                }),
            system: [
              {
                type: "text" as const,
                text: INSTRUCTIONS,
                cache_control: { type: "ephemeral" as const },
              },
              { type: "text" as const, text: context },
            ],
            tools: ASSISTANT_TOOLS,
            messages,
          });

          response.on("text", (delta) => {
            assistantTranscript += delta;
            send({ type: "text", delta });
          });

          const finalMessage = await response.finalMessage();

          if (finalMessage.stop_reason === "refusal") {
            send({ type: "error", message: "the model declined that request" });
            break;
          }

          if (finalMessage.stop_reason === "pause_turn") {
            messages.push({ role: "assistant", content: finalMessage.content });
            continue;
          }

          if (finalMessage.stop_reason !== "tool_use") break;

          const toolUses = finalMessage.content.filter(
            (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
          );
          messages.push({ role: "assistant", content: finalMessage.content });

          const results: Anthropic.ToolResultBlockParam[] = [];
          for (const toolUse of toolUses) {
            send({ type: "tool", name: toolUse.name });
            const outcome = await runAssistantTool(
              supabase,
              user.id,
              finalConversationId,
              toolUse.name,
              (toolUse.input ?? {}) as Record<string, unknown>,
            );
            if (outcome.type === "proposal") {
              send({
                type: "proposal",
                proposalId: outcome.proposalId,
                preview: outcome.preview,
              });
              results.push({
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: JSON.stringify({
                  proposed: true,
                  proposalId: outcome.proposalId,
                  preview: outcome.preview,
                  note: "awaiting the user's confirm tap — do not treat as done",
                }),
              });
            } else if (outcome.type === "result") {
              results.push({
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: JSON.stringify(outcome.content),
              });
            } else {
              results.push({
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: outcome.error,
                is_error: true,
              });
            }
          }
          messages.push({ role: "user", content: results });
        }
      } catch (error) {
        let messageText = "assistant call failed";
        if (error instanceof Anthropic.AuthenticationError) {
          messageText = "anthropic rejected the api key — check it in settings";
        } else if (error instanceof Anthropic.RateLimitError) {
          messageText = "rate limited by anthropic — try again shortly";
        } else if (error instanceof Anthropic.APIError) {
          messageText = `anthropic error (${error.status})`;
        }
        send({ type: "error", message: messageText });
      }

      if (assistantTranscript.trim()) {
        await supabase.from("ai_messages").insert({
          conversation_id: finalConversationId,
          user_id: user.id,
          role: "assistant",
          content: assistantTranscript,
        });
        await supabase
          .from("ai_conversations")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", finalConversationId);
      }

      send({ type: "done" });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
