import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceClient } from "@/utils/supabase/service";
import { workerAllowedUserIds } from "@/app/lib/mcp/config";
import { recordProposal } from "@/app/lib/mcp/audit";
import { readProviderKey } from "@/app/lib/connections/keys";
import { resolveCourse } from "@/app/lib/mcp/courses";
import type { Result } from "@/app/lib/mcp/validate";
import {
  COURSE_COLUMNS,
  type Course,
  type CourseSource,
} from "@/app/_components/learn-types";
import { loadConvertedSources, loadSourceDocuments } from "./context";
import { pcmDurationSeconds, pcmToWav } from "./audio";
import {
  FLAVOR_SPECS,
  GEMINI_VOICES,
  HOST_NAMES,
  SCRIPT_TOOL,
  scriptSystemPrompt,
  scriptToGeminiPrompt,
  scriptUserPrompt,
  speakersUsed,
  validateScript,
  type EpisodeFlavor,
  type ScriptLine,
} from "./podcast-script";

// Audio-overview pipeline (L2 of docs/education-plan.md): Claude writes the
// two-host script from the selected sources' vault markdown; the engine turns
// it into audio. 'gemini' renders synchronously in one multi-speaker request;
// 'vibevoice' queues a job for the home worker (L3).

const SCRIPT_MODEL = "claude-sonnet-5";
const GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";

export type EpisodeEngine = "gemini" | "vibevoice";

export type GenerateEpisodeInput = {
  course: string;
  sourceIds: string[] | null;
  flavor: EpisodeFlavor;
  engine: EpisodeEngine;
};

export function validateGenerateEpisode(raw: {
  course?: unknown;
  source_ids?: unknown;
  flavor?: unknown;
  engine?: unknown;
}): Result<GenerateEpisodeInput> {
  const course = typeof raw.course === "string" ? raw.course.trim() : "";
  if (!course) return { ok: false, error: "course is required" };

  let sourceIds: string[] | null = null;
  if (raw.source_ids != null) {
    if (
      !Array.isArray(raw.source_ids) ||
      raw.source_ids.some((id) => typeof id !== "string")
    ) {
      return { ok: false, error: "source_ids must be an array of ids" };
    }
    sourceIds = (raw.source_ids as string[]).filter(Boolean);
    if (sourceIds.length === 0) sourceIds = null;
  }

  const flavor = (raw.flavor ?? "deep-dive") as EpisodeFlavor;
  if (!FLAVOR_SPECS[flavor]) {
    return {
      ok: false,
      error: "flavor must be deep-dive, brief, debate, or solo",
    };
  }

  const engine = (raw.engine ?? "gemini") as EpisodeEngine;
  if (engine !== "gemini" && engine !== "vibevoice") {
    return { ok: false, error: "engine must be gemini or vibevoice" };
  }

  return { ok: true, value: { course, sourceIds, flavor, engine } };
}

async function fetchSourceMarkdown(
  supabase: SupabaseClient,
  userId: string,
  sources: CourseSource[],
): Promise<Result<string>> {
  const documents = await loadSourceDocuments(supabase, userId, sources);
  if (!documents.ok) return documents;
  return {
    ok: true,
    value: documents.value
      .map((doc) => `## SOURCE: ${doc.source.title}\n\n${doc.markdown}`)
      .join("\n\n"),
  };
}

async function writeScript(
  apiKey: string,
  input: {
    courseName: string;
    sourceTitles: string[];
    flavor: EpisodeFlavor;
    sourceMarkdown: string;
  },
): Promise<Result<{ title: string; lines: ScriptLine[] }>> {
  const client = new Anthropic({ apiKey });
  let message: Anthropic.Message;
  try {
    message = await client.messages
      .stream({
        model: SCRIPT_MODEL,
        max_tokens: 8_000,
        system: scriptSystemPrompt(input.flavor),
        tools: [SCRIPT_TOOL as Anthropic.Tool],
        tool_choice: { type: "tool", name: SCRIPT_TOOL.name },
        messages: [{ role: "user", content: scriptUserPrompt(input) }],
      })
      .finalMessage();
  } catch (error) {
    const detail =
      error instanceof Anthropic.APIError
        ? `anthropic ${error.status}: ${error.message.slice(0, 200)}`
        : "script generation failed";
    return { ok: false, error: detail };
  }

  const toolUse = message.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    return { ok: false, error: "script generation returned no script" };
  }
  return validateScript(toolUse.input);
}

type GeminiTtsPayload = {
  candidates?: {
    content?: { parts?: { inlineData?: { data?: string } }[] };
  }[];
};

async function renderWithGemini(
  apiKey: string,
  lines: ScriptLine[],
): Promise<Result<{ wav: Uint8Array; durationSec: number }>> {
  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: scriptToGeminiPrompt(lines) }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            // Gemini's multiSpeakerVoiceConfig requires exactly two speakers;
            // solo scripts render with a plain single voiceConfig instead.
            speechConfig:
              speakersUsed(lines).length === 1
                ? {
                    voiceConfig: {
                      prebuiltVoiceConfig: { voiceName: GEMINI_VOICES.A },
                    },
                  }
                : {
                    multiSpeakerVoiceConfig: {
                      speakerVoiceConfigs: (["A", "B"] as const).map(
                        (speaker) => ({
                          speaker: HOST_NAMES[speaker],
                          voiceConfig: {
                            prebuiltVoiceConfig: {
                              voiceName: GEMINI_VOICES[speaker],
                            },
                          },
                        }),
                      ),
                    },
                  },
          },
        }),
      },
    );
  } catch {
    return { ok: false, error: "could not reach the gemini tts api" };
  }

  // Reading the body is itself fallible — a gateway can answer with an HTML
  // error page (or die mid-stream) under any status. Neither read may throw:
  // the caller has already marked the episode row non-terminal, so an escaping
  // error would strand it there forever instead of failing it.
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return {
      ok: false,
      error: detail
        ? `gemini tts ${response.status}: ${detail.slice(0, 300)}`
        : `gemini tts ${response.status}`,
    };
  }

  let payload: GeminiTtsPayload;
  try {
    payload = (await response.json()) as GeminiTtsPayload;
  } catch {
    const kind = response.headers.get("content-type") ?? "unknown content type";
    return {
      ok: false,
      error: `gemini tts returned a non-json body (${kind}) — try again`,
    };
  }

  const base64 = payload.candidates?.[0]?.content?.parts?.find(
    (part) => part.inlineData?.data,
  )?.inlineData?.data;
  if (!base64) return { ok: false, error: "gemini tts returned no audio" };

  const pcm = new Uint8Array(Buffer.from(base64, "base64"));
  return {
    ok: true,
    value: { wav: pcmToWav(pcm), durationSec: pcmDurationSeconds(pcm.length) },
  };
}

export type EpisodeOutcome = {
  episode_id: string;
  title: string;
  status: string;
  duration_sec?: number;
  message: string;
};

// Once the row exists it is in a non-terminal status ('scripting' → 'rendering'
// / 'queued'), and only this function can move it out. An escaping throw would
// leave it stuck there with no UI affordance to fail or retry — and the user
// re-triggers a paid render — so every unexpected error becomes a real failure.
function unexpectedFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message.slice(0, 200) : "";
  return detail ? `episode generation failed — ${detail}` : "episode generation failed";
}

export async function generateEpisodeFor(
  supabase: SupabaseClient,
  userId: string,
  raw: Record<string, unknown>,
): Promise<Result<EpisodeOutcome>> {
  const parsed = validateGenerateEpisode(raw);
  if (!parsed.ok) return parsed;
  const input = parsed.value;

  const { data: courseRows } = await supabase
    .from("courses")
    .select(COURSE_COLUMNS)
    .eq("user_id", userId)
    .eq("archived", false);
  const resolved = resolveCourse((courseRows ?? []) as Course[], input.course);
  if (!resolved.ok) return resolved;
  const course = resolved.value;

  const sources = await loadConvertedSources(supabase, userId, course, input.sourceIds);
  if (!sources.ok) return sources;

  const anthropicKey = await readProviderKey(supabase, userId, "anthropic");
  if (!anthropicKey) {
    return {
      ok: false,
      error: "no anthropic key connected — add it in settings → connections",
    };
  }
  let googleKey: string | null = null;
  if (input.engine === "gemini") {
    googleKey = await readProviderKey(supabase, userId, "google");
    if (!googleKey) {
      return {
        ok: false,
        error: "no google ai key connected — add it in settings → connections",
      };
    }
  }

  const markdown = await fetchSourceMarkdown(supabase, userId, sources.value);
  if (!markdown.ok) return markdown;

  const { data: inserted, error: insertError } = await supabase
    .from("audio_episodes")
    .insert({
      user_id: userId,
      course_id: course.id,
      title: `${input.flavor} — ${course.name}`,
      source_ids: sources.value.map((s) => s.id),
      engine: input.engine,
      flavor: input.flavor,
      status: "scripting",
    })
    .select("id")
    .single();
  if (insertError || !inserted) {
    return { ok: false, error: insertError?.message ?? "could not create episode" };
  }
  const episodeId = inserted.id as string;

  const fail = async (message: string): Promise<Result<never>> => {
    await supabase
      .from("audio_episodes")
      .update({ status: "failed", error: message })
      .eq("id", episodeId)
      .eq("user_id", userId);
    return { ok: false, error: message };
  };

  try {
    const script = await writeScript(anthropicKey, {
      courseName: course.name,
      sourceTitles: sources.value.map((s) => s.title),
      flavor: input.flavor,
      sourceMarkdown: markdown.value,
    });
    if (!script.ok) return fail(script.error);

    // VibeVoice: the script is done on Vercel; the render is a queued job the
    // home PC pulls through /api/worker. The worker only serves allowlisted
    // users (owner-controlled env), so gate at enqueue too — a job outside the
    // allowlist would sit queued forever.
    if (input.engine === "vibevoice") {
      if (!workerAllowedUserIds().includes(userId)) {
        return fail(
          "the home-pc renderer isn't enabled for your account — use the gemini engine instead",
        );
      }
      await supabase
        .from("audio_episodes")
        .update({
          title: script.value.title,
          script: script.value,
          status: "queued",
        })
        .eq("id", episodeId)
        .eq("user_id", userId);

      const { error: jobError } = await supabase.from("jobs").insert({
        user_id: userId,
        kind: "tts",
        payload: { episode_id: episodeId },
      });
      if (jobError) return fail(jobError.message);

      return {
        ok: true,
        value: {
          episode_id: episodeId,
          title: script.value.title,
          status: "queued",
          message: `"${script.value.title}" is queued for the home pc — it renders when the worker is online (~20–45 min).`,
        },
      };
    }

    await supabase
      .from("audio_episodes")
      .update({
        title: script.value.title,
        script: script.value,
        status: "rendering",
      })
      .eq("id", episodeId)
      .eq("user_id", userId);

    const rendered = await renderWithGemini(googleKey as string, script.value.lines);
    if (!rendered.ok) return fail(rendered.error);

    const storagePath = `${userId}/${episodeId}.wav`;
    const upload = await supabase.storage
      .from("course-audio")
      .upload(storagePath, Buffer.from(rendered.value.wav), {
        contentType: "audio/wav",
        upsert: true,
      });
    if (upload.error) return fail(`audio upload failed — ${upload.error.message}`);

    const { error: doneError } = await supabase
      .from("audio_episodes")
      .update({
        status: "done",
        storage_path: storagePath,
        duration_sec: rendered.value.durationSec,
        error: null,
      })
      .eq("id", episodeId)
      .eq("user_id", userId);
    if (doneError) return fail(doneError.message);

    const minutes = Math.round(rendered.value.durationSec / 60);
    return {
      ok: true,
      value: {
        episode_id: episodeId,
        title: script.value.title,
        status: "done",
        duration_sec: rendered.value.durationSec,
        message: `"${script.value.title}" is ready (~${minutes} min) — play it in /learn.`,
      },
    };
  } catch (error) {
    return fail(unexpectedFailure(error));
  }
}

// ---- MCP surface: propose → confirm (it spends API money and writes rows) ----

export async function proposeGenerateAudioOverviewFor(
  supabase: SupabaseClient,
  userId: string,
  raw: unknown,
  options?: { source?: "mcp" | "assistant"; conversationId?: string | null },
): Promise<Result<{ proposalId: string; preview: string }>> {
  const parsed = validateGenerateEpisode((raw ?? {}) as Record<string, unknown>);
  if (!parsed.ok) return parsed;

  const { data: courseRows } = await supabase
    .from("courses")
    .select(COURSE_COLUMNS)
    .eq("user_id", userId)
    .eq("archived", false);
  const resolved = resolveCourse((courseRows ?? []) as Course[], parsed.value.course);
  if (!resolved.ok) return resolved;

  const scope = parsed.value.sourceIds
    ? `${parsed.value.sourceIds.length} selected source(s)`
    : "all converted sources";
  const summary = `Generate a ${parsed.value.flavor} audio overview of ${resolved.value.name} (${scope}, ${parsed.value.engine} voices).`;
  const proposalId = await recordProposal(
    supabase,
    userId,
    "generate_audio_overview",
    parsed.value as unknown as Record<string, unknown>,
    summary,
    options,
  );
  return { ok: true, value: { proposalId, preview: summary } };
}

export async function proposeGenerateAudioOverview(userId: string, raw: unknown) {
  return proposeGenerateAudioOverviewFor(createServiceClient(), userId, raw);
}

// EXECUTORS-shaped: confirm re-runs from the stored proposal input.
export async function executeGenerateAudioOverview(
  supabase: SupabaseClient,
  ownerId: string,
  input: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const raw: Record<string, unknown> = {
    course: input.course,
    source_ids: input.sourceIds ?? null,
    flavor: input.flavor,
    engine: input.engine,
  };
  const outcome = await generateEpisodeFor(supabase, ownerId, raw);
  if (!outcome.ok) return outcome;
  return { ok: true, value: outcome.value as unknown as Record<string, unknown> };
}
