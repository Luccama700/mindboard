import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

import { readProviderKey } from "@/app/lib/connections/keys";
import { readVaultCredentials } from "@/app/lib/brain/vault";
import {
  createVaultFileWithRetry,
  sanitizeCaptureTitle,
  VAULT_NOT_CONFIGURED_MESSAGE,
} from "@/app/lib/mcp/capture";
import { vancouverStamp } from "@/app/lib/mcp/course-ops";
import type { Result } from "@/app/lib/mcp/validate";
import {
  COURSE_COLUMNS,
  type Course,
} from "@/app/_components/learn-types";
import { loadConvertedSources, loadSourceDocuments } from "./context";

// Study artifacts (L5): one-shot generators whose output is a vault note
// under Courses/<course>/ — the vault is the knowledge layer, so generated
// study material lands there, not in Postgres. Flashcards are the exception
// (progress state) and live in course_cards.

const ARTIFACT_MODEL = "claude-sonnet-5";

export const ARTIFACT_KINDS = {
  "study-guide": {
    label: "Study Guide",
    prompt:
      "Write a thorough study guide: the key concepts in dependency order, each with a tight explanation, the formulas/definitions that must be memorized ($…$ LaTeX), common pitfalls, and a final checklist of what to be able to do.",
  },
  faq: {
    label: "FAQ",
    prompt:
      "Write an FAQ: the 12–20 questions a student actually asks about this material (including the embarrassing basic ones), each answered tightly from the sources.",
  },
  briefing: {
    label: "Briefing",
    prompt:
      "Write a one-page briefing: what this material covers, why it matters, the 5 core ideas with one-sentence explanations, and how the pieces connect.",
  },
  timeline: {
    label: "Timeline",
    prompt:
      "Write a timeline/sequence document: the material's ideas in the order they build on each other (or chronological order if historical), each entry with what changed and why it matters.",
  },
} as const;

export type ArtifactKind = keyof typeof ARTIFACT_KINDS;

const CARDS_TOOL = {
  name: "submit_cards",
  description: "Submit the finished flashcard set.",
  input_schema: {
    type: "object" as const,
    properties: {
      cards: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            answer: { type: "string" },
            explain: {
              type: "string",
              description:
                "Why the answer is what it is, grounded in the source material.",
            },
          },
          required: ["question", "answer"],
          additionalProperties: false,
        },
      },
    },
    required: ["cards"],
    additionalProperties: false,
  },
};

async function courseAndContext(
  supabase: SupabaseClient,
  userId: string,
  courseId: string,
): Promise<
  Result<{ course: Course; markdown: string; apiKey: string }>
> {
  const { data: courseRow } = await supabase
    .from("courses")
    .select(COURSE_COLUMNS)
    .eq("id", courseId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!courseRow) return { ok: false, error: "course not found" };
  const course = courseRow as Course;

  const sources = await loadConvertedSources(supabase, userId, course, null);
  if (!sources.ok) return sources;
  const documents = await loadSourceDocuments(supabase, userId, sources.value);
  if (!documents.ok) return documents;

  const apiKey = await readProviderKey(supabase, userId, "anthropic");
  if (!apiKey) {
    return {
      ok: false,
      error: "no anthropic key connected — add it in settings → connections",
    };
  }

  return {
    ok: true,
    value: {
      course,
      apiKey,
      markdown: documents.value
        .map((doc) => `## SOURCE: ${doc.source.title}\n\n${doc.markdown}`)
        .join("\n\n"),
    },
  };
}

export async function generateArtifactFor(
  supabase: SupabaseClient,
  userId: string,
  courseId: string,
  kind: ArtifactKind,
): Promise<Result<{ vault_path: string }>> {
  const spec = ARTIFACT_KINDS[kind];
  if (!spec) return { ok: false, error: "unknown artifact kind" };

  const context = await courseAndContext(supabase, userId, courseId);
  if (!context.ok) return context;
  const { course, markdown, apiKey } = context.value;

  const credentials = await readVaultCredentials(supabase, userId);
  if (!credentials) return { ok: false, error: VAULT_NOT_CONFIGURED_MESSAGE };

  const client = new Anthropic({ apiKey });
  let body: string;
  try {
    const message = await client.messages
      .stream({
        model: ARTIFACT_MODEL,
        max_tokens: 8_000,
        system:
          "You produce study documents for an Obsidian vault. GitHub-flavored markdown, $…$/$$…$$ LaTeX for math, [[wikilinks]] to the source notes where natural. Ground everything in the provided sources; no outside facts. Output only the document body — no preamble.",
        messages: [
          {
            role: "user",
            content: `${spec.prompt}\n\nCourse: ${course.name}\n\n=== SOURCE MATERIAL ===\n${markdown}`,
          },
        ],
      })
      .finalMessage();
    body = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
  } catch (error) {
    const detail =
      error instanceof Anthropic.APIError
        ? `anthropic ${error.status}: ${error.message.slice(0, 200)}`
        : "artifact generation failed";
    return { ok: false, error: detail };
  }
  if (!body) return { ok: false, error: "artifact came back empty" };

  const safeCourse = sanitizeCaptureTitle(course.name);
  if (!safeCourse.ok) return safeCourse;
  const stamp = vancouverStamp(new Date());
  const document = [
    "---",
    "type: course-artifact",
    `artifact: ${kind}`,
    `course: "${course.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
    `created: ${stamp.created}`,
    "---",
    "",
    body,
    "",
  ].join("\n");

  const written = await createVaultFileWithRetry(
    credentials,
    (attempt) =>
      `Courses/${safeCourse.value}/${spec.label}${attempt > 1 ? ` -${attempt}` : ""}.md`,
    document,
    `Course artifact: ${course.name} — ${spec.label}`,
  );
  if (!written.ok) return written;
  return { ok: true, value: { vault_path: written.value.path } };
}

export async function generateCardsFor(
  supabase: SupabaseClient,
  userId: string,
  courseId: string,
  count: number,
): Promise<Result<{ created: number }>> {
  const wanted = Math.min(Math.max(Math.round(count) || 20, 5), 60);
  const context = await courseAndContext(supabase, userId, courseId);
  if (!context.ok) return context;
  const { course, markdown, apiKey } = context.value;

  const client = new Anthropic({ apiKey });
  let raw: unknown;
  try {
    const message = await client.messages
      .stream({
        model: ARTIFACT_MODEL,
        max_tokens: 8_000,
        system:
          "You write flashcards that make the material stick. One atomic fact or skill per card; front is a real question (not 'define X' unless a definition matters); back is the tight answer with $…$ LaTeX where needed; explain says WHY, grounded in the sources. Cover the material evenly.",
        tools: [CARDS_TOOL as Anthropic.Tool],
        tool_choice: { type: "tool", name: CARDS_TOOL.name },
        messages: [
          {
            role: "user",
            content: `Write ${wanted} flashcards for ${course.name} from this material.\n\n=== SOURCE MATERIAL ===\n${markdown}`,
          },
        ],
      })
      .finalMessage();
    const toolUse = message.content.find((block) => block.type === "tool_use");
    raw = toolUse && toolUse.type === "tool_use" ? toolUse.input : null;
  } catch (error) {
    const detail =
      error instanceof Anthropic.APIError
        ? `anthropic ${error.status}: ${error.message.slice(0, 200)}`
        : "card generation failed";
    return { ok: false, error: detail };
  }

  const cards = (raw as { cards?: unknown })?.cards;
  if (!Array.isArray(cards) || cards.length === 0) {
    return { ok: false, error: "card generation returned no cards" };
  }

  const rows = cards
    .map((entry) => {
      const card = entry as {
        question?: unknown;
        answer?: unknown;
        explain?: unknown;
      };
      const question =
        typeof card.question === "string" ? card.question.trim() : "";
      const answer = typeof card.answer === "string" ? card.answer.trim() : "";
      if (!question || !answer) return null;
      return {
        user_id: userId,
        course_id: courseId,
        question,
        answer,
        explain:
          typeof card.explain === "string" && card.explain.trim()
            ? card.explain.trim()
            : null,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
  if (rows.length === 0) return { ok: false, error: "no valid cards returned" };

  const { error } = await supabase.from("course_cards").insert(rows);
  if (error) return { ok: false, error: error.message };
  return { ok: true, value: { created: rows.length } };
}
