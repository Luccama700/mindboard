"use server";

import { createClient } from "@/utils/supabase/server";
import { readProviderKey } from "@/app/lib/connections/keys";

const BUCKET = "inventory-icons";

type GenResult = { error: string | null; url?: string };

function buildPrompt(raw: string): string {
  return `${raw.trim()} — a single centered icon, flat minimal style, simple solid background, no text or words.`;
}

// Reaching an image API and reading its body are both fallible — an offline
// network, or a gateway answering with an HTML error page. Everything else in
// this file reports through the typed { error } contract, so these must too:
// a throw escapes the server action and the client's error branch never runs.
async function readErrorBody(res: Response, provider: string): Promise<string> {
  const detail = await res.text().catch(() => "");
  return detail
    ? `${provider} ${res.status}: ${detail.slice(0, 300)}`
    : `${provider} ${res.status}`;
}

async function generateWithOpenAI(
  apiKey: string,
  model: string,
  prompt: string,
): Promise<{ b64: string } | { error: string }> {
  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt,
        size: "1024x1024",
        quality: "low",
        n: 1,
      }),
    });
  } catch {
    return { error: "could not reach the openai image api" };
  }

  if (!res.ok) return { error: await readErrorBody(res, "openai") };

  let json: { data?: { b64_json?: string }[] };
  try {
    json = (await res.json()) as { data?: { b64_json?: string }[] };
  } catch {
    return { error: "openai returned an unreadable response" };
  }
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) return { error: "openai returned no image" };
  return { b64 };
}

async function generateWithGoogle(
  apiKey: string,
  model: string,
  prompt: string,
): Promise<{ b64: string } | { error: string }> {
  let res: Response;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model,
      )}:generateContent`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        }),
      },
    );
  } catch {
    return { error: "could not reach the google image api" };
  }

  if (!res.ok) return { error: await readErrorBody(res, "google") };

  type GoogleImagePayload = {
    candidates?: {
      content?: {
        parts?: {
          inlineData?: { data?: string };
          inline_data?: { data?: string };
        }[];
      };
    }[];
  };
  let json: GoogleImagePayload;
  try {
    json = (await res.json()) as GoogleImagePayload;
  } catch {
    return { error: "google returned an unreadable response" };
  }

  const parts = json.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const data = part.inlineData?.data ?? part.inline_data?.data;
    if (data) return { b64: data };
  }
  return { error: "google returned no image" };
}

export async function generateItemIcon(input: {
  id: string;
  prompt: string;
  provider: "openai" | "google";
  model: string;
}): Promise<GenResult> {
  const prompt = input.prompt?.trim();
  if (!prompt) return { error: "prompt required" };

  if (input.provider !== "openai" && input.provider !== "google") {
    return { error: "invalid provider" };
  }
  const model = input.model?.trim();
  if (!model) return { error: "missing model" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const apiKey = await readProviderKey(supabase, user.id, input.provider);
  if (!apiKey) {
    return {
      error: `no ${input.provider === "google" ? "google ai" : "openai"} key connected — add it in settings → connections`,
    };
  }

  const full = buildPrompt(prompt);
  const generated =
    input.provider === "openai"
      ? await generateWithOpenAI(apiKey, model, full)
      : await generateWithGoogle(apiKey, model, full);

  if ("error" in generated) return { error: generated.error };

  const bytes = Buffer.from(generated.b64, "base64");
  const path = `${user.id}/${input.id}/${crypto.randomUUID()}.png`;

  // storage-js already routes request failures — a rejected fetch included —
  // into a StorageError and returns them through `error` (_handleRequest wraps
  // them, handleOperation returns anything isStorageError). What it rethrows is
  // everything else: a throw while it builds the request body, or any error at
  // all under shouldThrowOnError. Defense in depth so nothing can escape this
  // action's typed contract, not a claim that the common path throws.
  let uploadError: { message: string } | null;
  try {
    ({ error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(path, bytes, { contentType: "image/png", upsert: false }));
  } catch {
    return { error: "could not upload the generated icon" };
  }

  if (uploadError) return { error: uploadError.message };

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return { error: null, url: data.publicUrl };
}
