"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import {
  ingestExternalSessions,
  SESSION_BATCH_MAX,
  type ExternalSessionInput,
} from "@/app/lib/mindspace/sessions";

// Receives compact session records parsed client-side from a claude.ai data
// export (the raw file is tens of MB and never leaves the browser).

export async function importClaudeSessions(
  sessions: ExternalSessionInput[],
): Promise<{ error: string | null; imported: number; skipped: number }> {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return { error: "nothing to import", imported: 0, skipped: 0 };
  }
  if (sessions.length > SESSION_BATCH_MAX) {
    return {
      error: `send at most ${SESSION_BATCH_MAX} sessions per batch`,
      imported: 0,
      skipped: 0,
    };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated", imported: 0, skipped: 0 };

  const result = await ingestExternalSessions(
    supabase,
    user.id,
    "claude_ai",
    sessions,
  );
  if (!result.ok) {
    return {
      error: result.error ?? "import failed",
      imported: result.imported,
      skipped: result.skipped,
    };
  }

  revalidatePath("/mindspace");
  return { error: null, imported: result.imported, skipped: result.skipped };
}
