import "server-only";

// The vault is one person's knowledge base with no RLS behind it, so /brain is
// gated to the deployment owner when MINDBOARD_OWNER_USER_ID is configured.
// Without the env var (local dev), any signed-in user may view.
export function isVaultOwner(userId: string): boolean {
  const owner = process.env.MINDBOARD_OWNER_USER_ID;
  return !owner || userId === owner;
}
