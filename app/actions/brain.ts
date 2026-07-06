"use server";

import { updateTag } from "next/cache";

import { createClient } from "@/utils/supabase/server";
import { normalizeVaultSettingsInput } from "@/app/lib/brain/settings";
import { githubHeaders, vaultTag } from "@/app/lib/brain/vault";

export type VaultActionResult = { error: string | null };

async function verifyVaultAccess(
  repo: string,
  token: string,
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: githubHeaders(token),
      cache: "no-store",
    });
  } catch {
    return "could not reach GitHub";
  }
  if (response.status === 401) return "token was rejected by GitHub";
  if (response.status === 403 || response.status === 404) {
    return "token cannot read that repo (check repo name and token scope)";
  }
  if (!response.ok) return `GitHub check failed (${response.status})`;
  return null;
}

export async function saveVaultSettings(input: {
  repo: string;
  branch: string;
  token: string;
}): Promise<VaultActionResult> {
  const normalized = normalizeVaultSettingsInput(input);
  if (!normalized.ok) return { error: normalized.error };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  let token = normalized.token;
  if (!token) {
    const { data: existing } = await supabase
      .from("vault_settings")
      .select("github_token")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!existing) return { error: "token required" };
    token = existing.github_token as string;
  }

  const accessError = await verifyVaultAccess(normalized.repo, token);
  if (accessError) return { error: accessError };

  const { error } = await supabase.from("vault_settings").upsert(
    {
      user_id: user.id,
      github_token: token,
      repo: normalized.repo,
      branch: normalized.branch,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) return { error: error.message };

  updateTag(vaultTag(user.id));
  return { error: null };
}

export async function disconnectVault(): Promise<VaultActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("vault_settings")
    .delete()
    .eq("user_id", user.id);
  if (error) return { error: error.message };

  updateTag(vaultTag(user.id));
  return { error: null };
}

export async function refreshVault() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  updateTag(vaultTag(user.id));
}
