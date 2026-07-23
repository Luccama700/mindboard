import "server-only";
import Anthropic from "@anthropic-ai/sdk";

import type {
  ItemLabel,
  MindspaceItem,
  MindspaceTopic,
  MindspaceView,
} from "@/app/lib/mindspace/types";

// The M2 classifier: forced-tool Haiku on the user's stored key (the auto-sort
// rail). The per-user taxonomy is the cached system prefix — batches within a
// pass reuse it at the 90% cache discount. Traces are truncated hard before
// they leave the process; nothing here is stored, only the returned numbers.

const MODEL = "claude-haiku-4-5-20251001";
export const MODEL_VERSION = MODEL;
export const CLASSIFY_BATCH = 20;
const EXCERPT_CHARS = 700;
const MAX_TOKENS = 4000;

const SOURCE_HINTS: Record<MindspaceItem["source"], string> = {
  capture: "note captured from an AI conversation",
  journal: "journal entry",
  note: "note",
  task: "task",
  ai_chat: "the user's messages in an AI chat session",
  daily_log: "daily check-in note",
  spend: "spending note",
  event: "calendar event",
};

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: "classify_traces",
  description:
    "Classify each trace against the user's topics and score its emotional salience.",
  input_schema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            trace: { type: "integer", description: "trace number from the list" },
            labels: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  topic: { type: "string", description: "exact topic id" },
                  weight: {
                    type: "number",
                    description:
                      "fraction of the trace's content about this topic, 0-1",
                  },
                },
                required: ["topic", "weight"],
                additionalProperties: false,
              },
            },
            salience: {
              type: "integer",
              description:
                "0 routine/logistical · 1 engaged · 2 emotionally charged or personally significant · 3 intense (distressed or elated)",
            },
            valence: {
              type: "integer",
              description: "-2 very negative … 2 very positive, 0 neutral/mixed",
            },
          },
          required: ["trace", "labels", "salience", "valence"],
          additionalProperties: false,
        },
      },
    },
    required: ["results"],
    additionalProperties: false,
  },
};

export function taxonomySystemPrompt(topics: MindspaceTopic[]): string {
  const lines = topics
    .filter((topic) => topic.status !== "archived")
    .map((topic) => {
      const aliases =
        topic.aliases.length > 0 ? ` — also: ${topic.aliases.join(", ")}` : "";
      const description = topic.description ? ` — ${topic.description}` : "";
      return `- id: ${topic.id} | ${topic.name} (${topic.kind})${aliases}${description}`;
    })
    .join("\n");

  return `You classify a user's personal traces (notes, AI chats, tasks, calendar events, spending notes) against their life topics — the people, projects, and concerns currently in their life — and score each trace's emotional salience.

Topics:
${lines}

Rules:
- labels: the topics this trace is substantially about. weight = the fraction of the trace's content attributable to that topic; weights across a trace's labels sum to at most 1. Most traces have one dominant topic. A passing mention is not a label. Empty labels when nothing fits.
- salience: how much this trace suggests the subject weighed on the user. 0 routine/logistical (a grocery note, a calendar hold) · 1 normally engaged · 2 emotionally charged or personally significant · 3 intense — visible distress, elation, or crisis.
- valence: the trace's emotional tone toward its subject, -2 very negative to 2 very positive, 0 neutral or mixed.
- Cover every trace number exactly once.`;
}

export type ClassifyVerdict = {
  ref: string;
  labels: ItemLabel[];
  salience: number;
  valence: number;
};

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export async function classifyBatch(
  anthropic: Anthropic,
  system: string,
  items: MindspaceItem[],
  topicIds: Set<string>,
): Promise<ClassifyVerdict[]> {
  const traceList = items
    .map((item, index) => {
      const excerpt = item.text.replace(/\s+/g, " ").slice(0, EXCERPT_CHARS);
      return `${index + 1}. [${SOURCE_HINTS[item.source]}] ${excerpt}`;
    })
    .join("\n");

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: [
      { type: "text", text: system, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: `Traces:\n${traceList}` }],
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: "tool", name: "classify_traces" },
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  const input = (toolUse?.input ?? {}) as { results?: unknown };
  if (!Array.isArray(input.results)) return [];

  const verdicts: ClassifyVerdict[] = [];
  const seen = new Set<number>();
  for (const raw of input.results) {
    const result = raw as {
      trace?: unknown;
      labels?: unknown;
      salience?: unknown;
      valence?: unknown;
    };
    if (typeof result.trace !== "number" || seen.has(result.trace)) continue;
    const item = items[result.trace - 1];
    if (!item) continue;
    seen.add(result.trace);

    const labels: ItemLabel[] = [];
    let weightSum = 0;
    if (Array.isArray(result.labels)) {
      for (const rawLabel of result.labels) {
        const label = rawLabel as { topic?: unknown; weight?: unknown };
        if (typeof label.topic !== "string" || !topicIds.has(label.topic)) {
          continue;
        }
        if (labels.some((l) => l.topicId === label.topic)) continue;
        const weight =
          typeof label.weight === "number" && Number.isFinite(label.weight)
            ? Math.min(1, Math.max(0, label.weight))
            : 0;
        if (weight <= 0) continue;
        labels.push({ topicId: label.topic, weight });
        weightSum += weight;
      }
    }
    if (weightSum > 1) {
      for (const label of labels) label.weight /= weightSum;
    }

    verdicts.push({
      ref: item.ref,
      labels,
      salience: clampInt(result.salience, 0, 3, 1),
      valence: clampInt(result.valence, -2, 2, 0),
    });
  }
  return verdicts;
}

const OBSERVE_TOOL: Anthropic.Tool = {
  name: "write_observations",
  description: "Write short observations about the user's attention shifts.",
  input_schema: {
    type: "object",
    properties: {
      observations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            topic: {
              type: ["string", "null"],
              description: "topic id the observation is about, or null",
            },
            text: { type: "string", description: "one sentence, lowercase" },
          },
          required: ["topic", "text"],
          additionalProperties: false,
        },
      },
    },
    required: ["observations"],
    additionalProperties: false,
  },
};

export type ObservationDraft = { topicId: string | null; text: string };

// The gentle reflective layer: numbers in, at most three one-liners out. The
// model sees aggregate shares only — never trace content — and the tone
// contract is noticing, not judging.
export async function writeObservations(
  anthropic: Anthropic,
  topics: MindspaceTopic[],
  view: MindspaceView,
): Promise<ObservationDraft[]> {
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const topicIds = new Set(topics.map((topic) => topic.id));
  const [threeDay, week, month] = view.windows;

  function windowLines(label: string, windowView: typeof week): string {
    if (windowView.sparse) return `${label}: too few traces`;
    const lines = windowView.shares
      .map((share) => {
        const topic = byId.get(share.topicId);
        if (!topic) return null;
        return `${topic.name} (id ${topic.id}): ${Math.round(share.share * 100)}%, ${share.itemCount} traces, charge ${share.meanSalience.toFixed(1)}/3`;
      })
      .filter(Boolean)
      .join("; ");
    return `${label}: ${lines || "nothing classified"}`;
  }

  const system = `You write at most 3 one-line observations about how a user's recorded attention is distributed, from aggregate numbers alone.

Tone contract:
- noticing, never judging or diagnosing; no advice; no alarm.
- lowercase, calm, one plain sentence each; no exclamation marks.
- name topics by their name, not their id; set the topic field to the id.
- prefer what changed (a share doubling, a topic going quiet, charge rising while volume falls) over restating the biggest number.
- if nothing is notable, return fewer observations, or none.`;

  const data = [
    windowLines("last 3 days", threeDay),
    windowLines("last week", week),
    windowLines("last month", month),
  ].join("\n");

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1000,
    system,
    messages: [{ role: "user", content: `Attention data:\n${data}` }],
    tools: [OBSERVE_TOOL],
    tool_choice: { type: "tool", name: "write_observations" },
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  const input = (toolUse?.input ?? {}) as { observations?: unknown };
  if (!Array.isArray(input.observations)) return [];

  return input.observations
    .map((raw) => {
      const observation = raw as { topic?: unknown; text?: unknown };
      if (
        typeof observation.text !== "string" ||
        observation.text.trim().length === 0
      ) {
        return null;
      }
      const topicId =
        typeof observation.topic === "string" &&
        topicIds.has(observation.topic)
          ? observation.topic
          : null;
      return { topicId, text: observation.text.trim().slice(0, 240) };
    })
    .filter((draft): draft is ObservationDraft => draft !== null)
    .slice(0, 3);
}
