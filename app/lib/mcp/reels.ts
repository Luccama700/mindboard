// Reel capture queueing (docs/reel-capture-plan.md), shared by the in-app
// action and the MCP process_reel tool. Multi-tenant: takes the caller's
// userId and scopes every query to it. Enqueues a worker job (operational,
// like queueSourceConversion) — no propose→confirm, but allowlist-gated
// because only a serviced user's home worker can run it.

import { createServiceClient } from "@/utils/supabase/service";
import { workerAllowedUserIds } from "@/app/lib/mcp/config";
import type { Result } from "@/app/lib/mcp/validate";
import {
  readVaultCredentials,
  readVaultNoteRaw,
  vaultTag,
} from "@/app/lib/brain/vault";
import { extractInstagramUrl } from "@/app/lib/reels/detect";

// Queue a reel for the home worker. Pass a direct `url`, or a `notePath` to
// a vault note whose body holds the reel link (the backlog / retry path).
export async function queueReel(
  userId: string,
  input: { notePath?: string; url?: string },
): Promise<Result<{ url: string }>> {
  if (!workerAllowedUserIds().includes(userId)) {
    return { ok: false, error: "the home worker isn't enabled for your account" };
  }
  const supabase = createServiceClient();

  let ref = input.url ? extractInstagramUrl(input.url) : null;
  let sourceNote: string | null = input.notePath ?? null;

  if (!ref && input.notePath) {
    const credentials = await readVaultCredentials(supabase, userId);
    if (!credentials) return { ok: false, error: "vault not connected — set it up on /brain" };
    const note = await readVaultNoteRaw(credentials, vaultTag(userId), input.notePath.trim());
    if (!note) return { ok: false, error: `no note at "${input.notePath}"` };
    ref = extractInstagramUrl(note.markdown);
    sourceNote = note.path;
  }

  if (!ref) return { ok: false, error: "no Instagram reel link found to process" };

  const { error } = await supabase.from("jobs").insert({
    user_id: userId,
    kind: "reel",
    payload: { url: ref.url, shortcode: ref.shortcode, source_note: sourceNote },
  });
  if (error) return { ok: false, error: error.message };

  return { ok: true, value: { url: ref.url } };
}
