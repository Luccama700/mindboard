"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/utils/supabase/server";
import { revokeAllConnectedApps, revokeConnectedApp } from "@/app/lib/mcp/oauth-store";

// Settings → connected apps. oauth_grants has RLS enabled with no policies, so
// the session client cannot touch it; the store runs on the service client and
// every statement filters user_id. The getUser() check here is what supplies
// that id — it is the only thing standing in for RLS on this path, so it must
// come first and the id must never come from the form.

export async function revokeConnection(formData: FormData): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const id = formData.get("id");
  if (typeof id !== "string" || !id) return;

  await revokeConnectedApp(user.id, id);
  revalidatePath("/settings");
}

export async function revokeAllConnections(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  await revokeAllConnectedApps(user.id);
  revalidatePath("/settings");
}
