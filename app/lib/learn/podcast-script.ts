// Pure script logic for audio overviews: the two-host dialogue contract, the
// Claude prompt that writes it, validation of the typed script, and the
// per-engine renderings (Gemini multi-speaker prompt, VibeVoice plain lines).
// One script serves every voice backend.

import type { Result } from "@/app/lib/mcp/validate";

export type ScriptLine = { speaker: "A" | "B"; text: string };

export type EpisodeFlavor = "deep-dive" | "brief" | "debate" | "solo";

export const HOST_NAMES: Record<"A" | "B", string> = { A: "Ava", B: "Ben" };

// Gemini prebuilt voices: Kore (firm, clear) for the explainer, Puck (upbeat)
// for the curious co-host.
export const GEMINI_VOICES: Record<"A" | "B", string> = {
  A: "Kore",
  B: "Puck",
};

export const FLAVOR_SPECS: Record<
  EpisodeFlavor,
  { words: string; note: string }
> = {
  "deep-dive": {
    words: "1900–2200",
    note: "Cover the material thoroughly — every major concept, the tricky parts slowly, with one worked example where the source has one.",
  },
  brief: {
    words: "600–800",
    note: "A tight orientation pass: what this material is about, the 3–4 ideas that matter most, and what to watch out for. No detours.",
  },
  debate: {
    words: "1600–2000",
    note: "The hosts take genuinely different readings of the material and argue them — respectfully but persistently — before landing on what they agree the sources actually support.",
  },
  solo: {
    words: "1400–1800",
    note: "A single narrator (speaker A only — no second host, ever) explains the material straight through: a great recorded lecture, not a conversation. Signpost transitions out loud ('so that's X — now the part everyone trips on'), ask the listener rhetorical questions instead of having a co-host ask them.",
  },
};

export function scriptSystemPrompt(flavor: EpisodeFlavor = "deep-dive"): string {
  if (flavor === "solo") {
    return [
      "You are a world-class scriptwriter for a single-narrator study podcast.",
      "THE NARRATOR (speaker A, the only speaker): a warm, sharp explainer who knows the material cold and talks TO the listener, not at them.",
      "Style rules:",
      "- Every line uses speaker A. There is no speaker B.",
      "- Short sentences. Contractions. Spoken register, not written.",
      "- Occasional filler ('uh', 'I mean', 'right?') — sparingly, maybe once a minute.",
      "- Rhetorical questions where a co-host would have asked ('so why does that matter?').",
      "- Signpost transitions out loud; recap briefly before moving on.",
      "- Open with a cold-hook question. Close with a two-line recap and one takeaway.",
      "- Ground every claim in the source material; if the sources don't cover something, say so.",
      "- No sound-effect or stage directions — emotion comes from wording and punctuation only.",
    ].join("\n");
  }
  return [
    "You are a world-class podcast producer and scriptwriter for a two-host study show.",
    "HOST A (Ava): warm, sharp explainer who knows the material cold.",
    "HOST B (Ben): genuinely curious co-host who asks what the listener would ask, pushes back sometimes, and summarizes ('so what you're saying is…').",
    "Style rules:",
    "- Short sentences. Contractions. Spoken register, not written.",
    "- Filler words ('uh', 'I mean', 'right?') about once every 3–4 turns — not every line.",
    "- Acknowledgment openers ('Yeah, and the wild part is—') when building on the other host.",
    "- At least one interruption: a line ending in an em-dash that the other host completes.",
    "- One moment of friendly disagreement that gets resolved.",
    "- Open with a cold-hook question. Close with a two-line recap and one takeaway.",
    "- Ground every claim in the source material. If the sources don't cover something, Ben asks and Ava says it's not covered.",
    "- No sound-effect or stage directions in the text — emotion comes from wording and punctuation only.",
  ].join("\n");
}

export function scriptUserPrompt(input: {
  courseName: string;
  sourceTitles: string[];
  flavor: EpisodeFlavor;
  sourceMarkdown: string;
}): string {
  const spec = FLAVOR_SPECS[input.flavor];
  return [
    `Write a two-host episode about the following ${input.courseName} material: ${input.sourceTitles.join(", ")}.`,
    `Flavor: ${input.flavor}. ${spec.note}`,
    `Target ${spec.words} words of spoken dialogue total. Do not pad; go deeper instead.`,
    "Return the script via the tool call.",
    "",
    "=== SOURCE MATERIAL ===",
    input.sourceMarkdown,
  ].join("\n");
}

// Anthropic tool schema forcing the typed script shape.
export const SCRIPT_TOOL = {
  name: "submit_script",
  description: "Submit the finished two-host episode script.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: { type: "string", maxLength: 120 },
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            speaker: { type: "string", enum: ["A", "B"] },
            text: { type: "string" },
          },
          required: ["speaker", "text"],
          additionalProperties: false,
        },
      },
    },
    required: ["title", "lines"],
    additionalProperties: false,
  },
};

export function validateScript(raw: unknown): Result<{
  title: string;
  lines: ScriptLine[];
}> {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "script generation returned no structured output" };
  }
  const value = raw as { title?: unknown; lines?: unknown };
  const title =
    typeof value.title === "string" && value.title.trim()
      ? value.title.trim().slice(0, 120)
      : "";
  if (!title) return { ok: false, error: "script has no title" };
  if (!Array.isArray(value.lines) || value.lines.length < 4) {
    return { ok: false, error: "script has too few lines" };
  }
  const lines: ScriptLine[] = [];
  for (const entry of value.lines) {
    const line = entry as { speaker?: unknown; text?: unknown };
    if (line.speaker !== "A" && line.speaker !== "B") {
      return { ok: false, error: "script line has an unknown speaker" };
    }
    const text = typeof line.text === "string" ? line.text.trim() : "";
    if (!text) continue;
    lines.push({ speaker: line.speaker, text });
  }
  if (lines.length < 4) return { ok: false, error: "script has too few lines" };
  return { ok: true, value: { title, lines } };
}

export function speakersUsed(lines: ScriptLine[]): ("A" | "B")[] {
  const used = new Set(lines.map((line) => line.speaker));
  return (["A", "B"] as const).filter((speaker) => used.has(speaker));
}

// Gemini TTS: multi-speaker scripts get a style preamble + named lines; a
// solo script gets a single-narrator prompt (rendered with voiceConfig, not
// multiSpeakerVoiceConfig — Gemini requires exactly two speakers for that).
export function scriptToGeminiPrompt(lines: ScriptLine[]): string {
  if (speakersUsed(lines).length === 1) {
    const body = lines.map((line) => line.text).join("\n");
    return `TTS the following in a warm, clear narrator voice — engaging but unhurried:\n${body}`;
  }
  const preamble = `TTS the following conversation between ${HOST_NAMES.A} (warm, quick, wry) and ${HOST_NAMES.B} (curious, upbeat):`;
  const body = lines
    .map((line) => `${HOST_NAMES[line.speaker]}: ${line.text}`)
    .join("\n");
  return `${preamble}\n${body}`;
}

// VibeVoice: plain "Speaker N:" lines, no bracket tags (it voices them
// literally) — emotion is emergent from wording and punctuation.
export function scriptToVibeVoiceText(lines: ScriptLine[]): string {
  return lines
    .map((line) => `Speaker ${line.speaker === "A" ? 1 : 2}: ${line.text}`)
    .join("\n");
}

export function scriptWordCount(lines: ScriptLine[]): number {
  return lines.reduce(
    (sum, line) => sum + line.text.split(/\s+/).filter(Boolean).length,
    0,
  );
}
