"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import { queueReel } from "@/app/lib/mcp/reels";

// Queue a saved reel (a vault note holding an Instagram link, or a direct
// URL) for the home worker to transcribe. Session-authed; the heavy lifting
// runs on the PC (docs/reel-capture-plan.md).
export async function processReel(input: {
  notePath?: string;
  url?: string;
}): Promise<{ error: string | null; url?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const result = await queueReel(user.id, input);
  if (!result.ok) return { error: result.error };

  revalidatePath("/brain");
  return { error: null, url: result.value.url };
}
