import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";

import { createClient } from "@/utils/supabase/server";
import { readProviderKey } from "@/app/lib/connections/keys";
import {
  loadConvertedSources,
  loadSourceDocuments,
} from "@/app/lib/learn/context";
import {
  COURSE_COLUMNS,
  type Course,
} from "@/app/_components/learn-types";
import { noteHref } from "@/app/lib/brain/parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Grounded course chat (L4 of docs/education-plan.md): the selected sources'
// converted markdown rides along as citation-enabled text documents, so every
// claim in the answer carries the exact passage it came from — the NotebookLM
// trust loop. Answers only from the sources; the system prompt says so and the
// citations prove it. Transcript state lives on the client (ephemeral v1).

const CHAT_MODEL = "claude-sonnet-5";
const MAX_TURNS = 40;

type ChatTurn = { role: "user" | "assistant"; content: string };

type CitationItem = {
  n: number;
  title: string;
  href: string;
  cited_text: string;
};

function systemPrompt(courseName: string): string {
  return [
    `You are a study assistant for the course "${courseName}".`,
    "Answer ONLY from the attached course documents. If the documents don't cover the question, say so plainly — never fill gaps from general knowledge without flagging it as outside the sources.",
    "Be concrete and quote the relevant passage's ideas. Use $…$ LaTeX for math. Keep answers tight; this is a study tool, not an essay.",
  ].join("\n");
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    courseId?: string;
    sourceIds?: string[];
    messages?: ChatTurn[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const turns = (body.messages ?? []).slice(-MAX_TURNS);
  if (
    turns.length === 0 ||
    turns[turns.length - 1].role !== "user" ||
    turns.some((t) => typeof t.content !== "string" || !t.content.trim())
  ) {
    return NextResponse.json({ error: "messages must end with a user turn" }, { status: 400 });
  }

  const { data: courseRow } = await supabase
    .from("courses")
    .select(COURSE_COLUMNS)
    .eq("id", body.courseId ?? "")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!courseRow) {
    return NextResponse.json({ error: "course not found" }, { status: 404 });
  }
  const course = courseRow as Course;

  const sources = await loadConvertedSources(
    supabase,
    user.id,
    course,
    body.sourceIds?.length ? body.sourceIds : null,
  );
  if (!sources.ok) return NextResponse.json({ error: sources.error }, { status: 400 });

  const documents = await loadSourceDocuments(supabase, user.id, sources.value);
  if (!documents.ok) {
    return NextResponse.json({ error: documents.error }, { status: 400 });
  }

  const apiKey = await readProviderKey(supabase, user.id, "anthropic");
  if (!apiKey) {
    return NextResponse.json(
      { error: "no anthropic key connected — add it in settings → connections" },
      { status: 400 },
    );
  }

  // Documents ride in the first user turn (stable across the conversation →
  // prompt-cacheable); later turns are plain text.
  const documentBlocks: Anthropic.ContentBlockParam[] = documents.value.map(
    (doc, index) => ({
      type: "document",
      source: { type: "text", media_type: "text/plain", data: doc.markdown },
      title: doc.source.title,
      citations: { enabled: true },
      ...(index === documents.value.length - 1
        ? { cache_control: { type: "ephemeral" as const } }
        : {}),
    }),
  );

  const messages: Anthropic.MessageParam[] = turns.map((turn, index) => ({
    role: turn.role,
    content:
      index === 0 && turn.role === "user"
        ? [...documentBlocks, { type: "text" as const, text: turn.content }]
        : turn.content,
  }));
  if (turns[0].role !== "user") {
    messages.unshift({
      role: "user",
      content: [
        ...documentBlocks,
        { type: "text" as const, text: "(course documents attached)" },
      ],
    });
  }

  const client = new Anthropic({ apiKey });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        const runner = client.messages.stream({
          model: CHAT_MODEL,
          max_tokens: 4_000,
          system: systemPrompt(course.name),
          messages,
        });
        runner.on("text", (text) => send({ type: "text", text }));
        const final = await runner.finalMessage();

        // Flatten citations across text blocks into numbered chips, one per
        // unique (document, passage), in order of first appearance.
        const items: CitationItem[] = [];
        const seen = new Map<string, number>();
        for (const block of final.content) {
          if (block.type !== "text" || !block.citations) continue;
          for (const citation of block.citations) {
            const docIndex =
              "document_index" in citation ? citation.document_index : null;
            if (docIndex === null || docIndex >= documents.value.length) continue;
            const doc = documents.value[docIndex];
            const citedText =
              "cited_text" in citation ? (citation.cited_text ?? "") : "";
            const key = `${docIndex}:${citedText.slice(0, 120)}`;
            if (seen.has(key)) continue;
            const n = items.length + 1;
            seen.set(key, n);
            items.push({
              n,
              title: doc.source.title,
              href: doc.source.vault_path ? noteHref(doc.source.vault_path) : "",
              cited_text: citedText.slice(0, 500),
            });
          }
        }
        send({ type: "citations", items });
        send({ type: "done" });
      } catch (error) {
        const message =
          error instanceof Anthropic.APIError
            ? `anthropic ${error.status}: ${error.message.slice(0, 200)}`
            : "chat failed";
        send({ type: "error", error: message });
      } finally {
        controller.close();
      }
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
