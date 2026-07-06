const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

export type VaultSettingsInput = {
  repo: string;
  branch: string;
  token: string;
};

export type NormalizedVaultSettings =
  | { ok: true; repo: string; branch: string; token: string | null }
  | { ok: false; error: string };

// token: null means "keep the stored token" (only valid when updating an
// existing connection — the action enforces that).
export function normalizeVaultSettingsInput(
  input: VaultSettingsInput,
): NormalizedVaultSettings {
  const repo = input.repo?.trim() ?? "";
  if (!repo) return { ok: false, error: "repo required (owner/name)" };
  if (!REPO_RE.test(repo)) {
    return { ok: false, error: "repo must look like owner/name" };
  }
  const branch = input.branch?.trim() || "main";
  if (/\s/.test(branch)) return { ok: false, error: "invalid branch name" };
  const token = input.token?.trim() ?? "";
  if (token && /\s/.test(token)) return { ok: false, error: "invalid token" };
  return { ok: true, repo, branch, token: token || null };
}
