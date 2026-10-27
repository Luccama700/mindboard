// Claim guards for the home worker (audit 2026-10-26, C1 + M7). Pure logic,
// unit-tested in __tests__/worker-claims.test.ts.
//
// The invariant: NOTHING a client can write may reach the PC as-is. `jobs`
// RLS let any signed-in session insert or update its own row with any payload
// (0056 closes that; this layer holds either way), so /api/worker re-derives
// every value it hands out — a reel URL from the canonicalizer, a PDF path
// from the job's own account prefix — rather than forwarding `jobs.payload`.

import { extractInstagramUrl, type ReelRef } from "@/app/lib/reels/detect";
import type { Result } from "@/app/lib/mcp/validate";

// A reel payload is honoured only when its url IS the canonicalizer's own
// output. extractInstagramUrl finds the first Instagram link anywhere in a
// string, so equality — not "contains a match" — is what rejects a forged
// `https://www.instagram.com/reel/abc/ & powershell -enc …`, which the worker
// used to splice into a shell command line verbatim.
export function canonicalReelRef(rawUrl: unknown): Result<ReelRef> {
  const url = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!url) return { ok: false, error: "reel job carries no url" };
  const ref = extractInstagramUrl(url);
  if (!ref || ref.url !== url) {
    return { ok: false, error: "reel url is not a canonical instagram link" };
  }
  return { ok: true, value: ref };
}

// attachSourceFile writes `{user_id}/{source_id}/…` and checks that prefix,
// but `course_sources` RLS lets the same user PATCH storage_path afterwards —
// so an allowlisted tenant who knows another tenant's object path could have
// the service role sign a download for it. Re-check before signing.
export function storagePathBelongsTo(
  userId: string,
  sourceId: string,
  path: unknown,
): boolean {
  return typeof path === "string" && path.startsWith(`${userId}/${sourceId}/`);
}
