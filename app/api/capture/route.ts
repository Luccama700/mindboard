import { NextResponse } from "next/server";

import { createServiceClient } from "@/utils/supabase/service";
import { ownerUserId, workerAllowedUserIds } from "@/app/lib/mcp/config";
import { extractInstagramUrl } from "@/app/lib/reels/detect";
import { readVaultCredentials, revalidateVaultTree } from "@/app/lib/brain/vault";
import { VAULT_NOT_CONFIGURED_MESSAGE } from "@/app/lib/mcp/capture";
import {
  bearerAuthorized,
  createQuickNote,
  createRateLimiter,
  validateQuickNote,
} from "@/app/lib/mcp/quick-note";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Public door for the iOS capture Shortcuts (Siri dictation and share-sheet
// links/files → vault Inbox/). The static CAPTURE_SECRET bearer maps to the
// deployment owner, the
// same way the legacy static MCP token does; vault credentials come from that
// user's vault_settings, never from env. The write reuses capture_to_brain's
// create-only Inbox/ writer, so this endpoint can never update or delete
// anything — and, matching capture_to_brain, it records no ai_audit_log row:
// the vault repo's commit history is the audit trail.

const allowRequest = createRateLimiter(20, 60_000);

export async function POST(request: Request) {
  if (
    !bearerAuthorized(
      request.headers.get("authorization"),
      process.env.CAPTURE_SECRET,
    )
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!allowRequest(Date.now())) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const parsed = validateQuickNote(raw);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const credentials = await readVaultCredentials(
    createServiceClient(),
    ownerUserId(),
  );
  if (!credentials) {
    return NextResponse.json(
      { error: VAULT_NOT_CONFIGURED_MESSAGE },
      { status: 503 },
    );
  }

  const written = await createQuickNote(credentials, parsed.value, new Date());
  if (!written.ok) {
    return NextResponse.json({ error: written.error }, { status: 502 });
  }
  revalidateVaultTree(ownerUserId());

  // A shared Instagram reel/post link gets queued for the home worker to
  // download + transcribe (docs/reel-capture-plan.md). Best-effort: a failed
  // enqueue never fails the capture — the note (with the link) is already
  // saved. Only when the worker serves this owner.
  const reel = extractInstagramUrl(parsed.value.text);
  let reelQueued = false;
  if (reel && workerAllowedUserIds().includes(ownerUserId())) {
    const { error } = await createServiceClient()
      .from("jobs")
      .insert({
        user_id: ownerUserId(),
        kind: "reel",
        payload: {
          url: reel.url,
          shortcode: reel.shortcode,
          source_note: written.value.path,
        },
      });
    reelQueued = !error;
  }

  return NextResponse.json({
    ok: true,
    path: written.value.path,
    ...(written.value.filePath ? { file_path: written.value.filePath } : {}),
    ...(reelQueued ? { reel_queued: true } : {}),
  });
}
