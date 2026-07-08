import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptSecret } from "@/app/lib/assistant/crypto";
import type { KeyProvider } from "@/app/lib/connections/types";

// One read path for every provider key. All keys are AES-256-GCM encrypted
// at rest (the 0015 anthropic pattern) and decrypted only inside server code;
// a key never reaches the client — at most its last-4 hint does.

export type { KeyProvider };

export const KEY_COLUMNS: Record<KeyProvider, string> = {
  anthropic: "anthropic_api_key",
  google: "google_ai_api_key",
  openai: "openai_api_key",
};

export async function readProviderKey(
  supabase: SupabaseClient,
  userId: string,
  provider: KeyProvider,
): Promise<string | null> {
  const column = KEY_COLUMNS[provider];
  const { data } = await supabase
    .from("user_settings")
    .select(column)
    .eq("user_id", userId)
    .maybeSingle();
  const encrypted = (data as Record<string, string | null> | null)?.[column];
  if (!encrypted) return null;
  try {
    return decryptSecret(encrypted);
  } catch {
    return null;
  }
}

export function keyHint(key: string): string {
  return key.length >= 4 ? `…${key.slice(-4)}` : "…";
}
