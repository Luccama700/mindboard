"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/utils/supabase/server";
import { revokeAllConnectedApps, revokeConnectedApp } from "@/app/lib/mcp/oauth-store";

// Settings → connected apps. oauth_grants has RLS enabled with no policies, so
// the session client cannot touch it; the store runs on the service client and
// every statement filters user_id. The getUser() check here is what supplies
// that id — it is the only thing standing in for RLS on this path, so it must
// come first and the id must never come from the form.

//
// Both are useActionState actions: the result goes back to the button, so a
// revoke that failed says so instead of re-rendering the app as still listed.

export type RevokeState = { error: string | null };

export async function revokeConnection(
  _prev: RevokeState,
  formData: FormData,
): Promise<RevokeState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not signed in" };

  const id = formData.get("id");
  if (typeof id !== "string" || !id) return { error: "could not revoke this connection" };

  const { error } = await revokeConnectedApp(user.id, id);
  revalidatePath("/settings");
  return { error };
}

export async function revokeAllConnections(): Promise<RevokeState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not signed in" };

  const { error } = await revokeAllConnectedApps(user.id);
  revalidatePath("/settings");
  return { error };
}
