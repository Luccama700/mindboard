"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/utils/supabase/server";
import { encryptSecret } from "@/app/lib/assistant/crypto";
import { KEY_COLUMNS, type KeyProvider } from "@/app/lib/connections/keys";

// Unified save/clear for every provider API key. Keys are validated by shape,
// verified with one cheap live call, encrypted, and upserted into
// user_settings. This is the single write path — the /plan onboarding form
// and the settings connection cards both land here.

const KEY_SHAPES: Record<KeyProvider, RegExp> = {
  anthropic: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
  google: /^AIza[A-Za-z0-9_-]{30,}$/,
  openai: /^sk-[A-Za-z0-9_-]{20,}$/,
};

const SHAPE_ERRORS: Record<KeyProvider, string> = {
  anthropic: "that does not look like an anthropic api key (sk-ant-…)",
  google: "that does not look like a google ai api key (AIza…)",
  openai: "that does not look like an openai api key (sk-…)",
};

async function verifyKey(
  provider: KeyProvider,
  key: string,
): Promise<string | null> {
  try {
    let response: Response;
    if (provider === "anthropic") {
      response = await fetch("https://api.anthropic.com/v1/models?limit=1", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
    } else if (provider === "google") {
      response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
        { headers: { "x-goog-api-key": key } },
      );
    } else {
      response = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
      });
    }
    if (response.status === 401 || response.status === 403) {
      return `${provider} rejected the key`;
    }
    if (!response.ok) return `${provider} verification failed (${response.status})`;
    return null;
  } catch {
    return `could not reach ${provider} to verify the key`;
  }
}

export async function saveProviderKey(input: {
  provider: KeyProvider;
  key: string;
}): Promise<{ error: string | null }> {
  const provider = input.provider;
  if (!KEY_COLUMNS[provider]) return { error: "unknown provider" };

  const key = input.key?.trim() ?? "";
  if (!KEY_SHAPES[provider].test(key)) return { error: SHAPE_ERRORS[provider] };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const verifyError = await verifyKey(provider, key);
  if (verifyError) return { error: verifyError };

  let encrypted: string;
  try {
    encrypted = encryptSecret(key);
  } catch {
    return {
      error: "server key storage is not configured (ASSISTANT_KEY_SECRET)",
    };
  }

  const { error } = await supabase.from("user_settings").upsert(
    {
      user_id: user.id,
      [KEY_COLUMNS[provider]]: encrypted,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) return { error: error.message };

  revalidatePath("/settings");
  revalidatePath("/plan");
  return { error: null };
}

export async function clearProviderKey(input: {
  provider: KeyProvider;
}): Promise<{ error: string | null }> {
  const provider = input.provider;
  if (!KEY_COLUMNS[provider]) return { error: "unknown provider" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("user_settings")
    .update({
      [KEY_COLUMNS[provider]]: null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", user.id);
  if (error) return { error: error.message };

  revalidatePath("/settings");
  revalidatePath("/plan");
  return { error: null };
}
