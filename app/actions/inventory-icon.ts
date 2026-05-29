"use server";

import { createClient } from "@/utils/supabase/server";

const BUCKET = "inventory-icons";

type GenResult = { error: string | null; url?: string };

function buildPrompt(raw: string): string {
  return `${raw.trim()} — a single centered icon, flat minimal style, simple solid background, no text or words.`;
}

async function generateWithOpenAI(
  apiKey: string,
  model: string,
  prompt: string,
): Promise<{ b64: string } | { error: string }> {
  const res = await fetch("https://api.openai.com/v1/images/generations", {
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

  if (!res.ok) {
    const detail = await res.text();
    return { error: `openai ${res.status}: ${detail.slice(0, 300)}` };
  }

  const json = (await res.json()) as {
    data?: { b64_json?: string }[];
  };
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) return { error: "openai returned no image" };
  return { b64 };
}

async function generateWithGoogle(
  apiKey: string,
  model: string,
  prompt: string,
): Promise<{ b64: string } | { error: string }> {
  const res = await fetch(
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

  if (!res.ok) {
    const detail = await res.text();
    return { error: `google ${res.status}: ${detail.slice(0, 300)}` };
  }

  const json = (await res.json()) as {
    candidates?: {
      content?: {
        parts?: {
          inlineData?: { data?: string };
          inline_data?: { data?: string };
        }[];
      };
    }[];
  };

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
  apiKey: string;
  model: string;
}): Promise<GenResult> {
  const prompt = input.prompt?.trim();
  if (!prompt) return { error: "prompt required" };

  const apiKey = input.apiKey?.trim();
  if (!apiKey) return { error: "missing api key" };

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

  const full = buildPrompt(prompt);
  const generated =
    input.provider === "openai"
      ? await generateWithOpenAI(apiKey, model, full)
      : await generateWithGoogle(apiKey, model, full);

  if ("error" in generated) return { error: generated.error };

  const bytes = Buffer.from(generated.b64, "base64");
  const path = `${user.id}/${input.id}/${crypto.randomUUID()}.png`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: "image/png", upsert: false });

  if (uploadError) return { error: uploadError.message };

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return { error: null, url: data.publicUrl };
}
