import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/utils/supabase/service";
import { readVaultCredentials } from "@/app/lib/brain/vault";
import { runCapture, type CaptureOutcome } from "./capture";
import type { Result } from "./validate";

// capture_to_brain executes directly instead of propose → confirm: it can only
// create new files under Inbox/ in the user's vault repo (never update or
// delete, never touch Mindboard tables), and the vault's review-and-file flow
// is itself the confirmation step. Credentials come from the same
// vault_settings read /brain uses — never from env.

export async function captureToBrainFor(
  supabase: SupabaseClient,
  userId: string,
  raw: unknown,
): Promise<Result<CaptureOutcome>> {
  const credentials = await readVaultCredentials(supabase, userId);
  return runCapture(credentials, raw, new Date());
}

export async function captureToBrain(
  userId: string,
  raw: unknown,
): Promise<Result<CaptureOutcome>> {
  return captureToBrainFor(createServiceClient(), userId, raw);
}
