// Account deletion (audit finding M9): the pure half — the confirmation
// phrase, the deployment-owner refusal, and the storage walk that collects
// every object under a user's {user_id}/ prefix.
//
// Deliberately free of `server-only` and of any client import: the phrase
// helpers are the same on both sides of the wire (the form disables its
// button with exactly the check the server re-runs), and the walker takes an
// injected lister so it is unit-testable without Supabase.

// Buckets with {user_id}/… folder prefixes. Nothing else in the app writes
// user files, so this list is the whole blast radius of a delete.
export const USER_STORAGE_BUCKETS = [
  "inventory-icons",
  "course-files",
  "course-audio",
  "reel-media",
] as const;

export const ACCOUNT_DELETE_PHRASE = "delete my account";

// Case- and whitespace-insensitive. The gate exists to make the action
// deliberate, not to be a password: on iOS the keyboard capitalises the first
// letter of a field by default, and a case-sensitive compare would lock out
// every PWA user who did not notice.
export function matchesDeletePhrase(input: string): boolean {
  return input.trim().replace(/\s+/g, " ").toLowerCase() === ACCOUNT_DELETE_PHRASE;
}

// The deployment owner may NOT self-delete: their row is what
// MINDBOARD_OWNER_USER_ID (the legacy static MCP bearer, the worker heartbeat)
// and URC_OWNER_USER_ID resolve to, so removing it would break the deployment
// for everyone else rather than just for them.
export function isDeploymentOwner(
  userId: string,
  env: Record<string, string | undefined>,
): boolean {
  const owners = [env.MINDBOARD_OWNER_USER_ID, env.URC_OWNER_USER_ID]
    .map((id) => (id ?? "").trim())
    .filter(Boolean);
  return owners.includes(userId.trim());
}

export type StorageEntry = { name: string; id: string | null };

// Supabase storage has no recursive list and no prefix delete: `list` returns
// one level, folders come back with a null id, and a page shorter than the
// limit is the last one. course-files/course-audio/reel-media all nest a
// second level ({user}/{source}/file), so the walk has to recurse.
export async function collectObjectPaths(
  listPage: (
    prefix: string,
    offset: number,
    limit: number,
  ) => Promise<StorageEntry[]>,
  prefix: string,
  options: { pageSize?: number; maxDepth?: number; maxObjects?: number } = {},
): Promise<string[]> {
  const pageSize = options.pageSize ?? 100;
  const maxDepth = options.maxDepth ?? 5;
  const maxObjects = options.maxObjects ?? 50_000;

  const paths: string[] = [];
  const queue: { prefix: string; depth: number }[] = [{ prefix, depth: 0 }];

  while (queue.length > 0) {
    const folder = queue.shift() as { prefix: string; depth: number };
    let offset = 0;
    for (;;) {
      const page = await listPage(folder.prefix, offset, pageSize);
      for (const entry of page) {
        if (!entry.name) continue;
        const path = `${folder.prefix}/${entry.name}`;
        if (entry.id === null) {
          if (folder.depth < maxDepth) {
            queue.push({ prefix: path, depth: folder.depth + 1 });
          }
          continue;
        }
        paths.push(path);
      }
      // Never silently under-delete: a runaway listing throws so the caller
      // can refuse the delete instead of leaving files behind unannounced.
      if (paths.length > maxObjects) {
        throw new Error(`more than ${maxObjects} stored files under ${prefix}`);
      }
      if (page.length < pageSize) break;
      offset += page.length;
    }
  }

  return paths;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
