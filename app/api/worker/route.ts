import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { createServiceClient } from "@/utils/supabase/service";
import { ownerUserId, todayKey, userTimeZone, workerAllowedUserIds } from "@/app/lib/mcp/config";
import { readVaultCredentials, revalidateVaultTree } from "@/app/lib/brain/vault";
import {
  createVaultBase64FileWithRetry,
  createVaultFileWithRetry,
  VAULT_NOT_CONFIGURED_MESSAGE,
} from "@/app/lib/mcp/capture";
import {
  buildReelDocument,
  buildReelFailureDocument,
  embedFor,
  reelFailureNotePath,
  reelNotePath,
  reelThumbnailPath,
  type ReelFrame,
} from "@/app/lib/reels/detect";
import {
  buildSourceDocument,
  courseSourcePath,
  zonedStamp,
} from "@/app/lib/mcp/course-ops";
import { scriptToVibeVoiceText } from "@/app/lib/learn/podcast-script";
import {
  canonicalReelRef,
  followupContext,
  parseFollowupResult,
  storagePathBelongsTo,
  type FollowupTaskRow,
} from "@/app/lib/worker/claims";
import { appendSection } from "@/app/lib/notes";
import { idempotentProposalId } from "@/app/lib/watch/protocol";
import {
  SOURCE_COLUMNS,
  type CourseSource,
} from "@/app/_components/learn-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The home worker's only door into the app. The PC holds no database key —
// just this bearer (WORKER_BEARER_TOKEN; it buys this API and nothing else).
// Claims are atomic via claim_next_job() (FOR UPDATE SKIP LOCKED + stale-
// heartbeat reclaim); results land either in the request body (ocr markdown)
// or directly in storage via a signed upload URL (tts audio — too big for a
// route body). All vault/Postgres finalization stays here, in one code path.

type JobRow = {
  id: string;
  user_id: string;
  kind: "ocr" | "tts" | "reel" | "followup";
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
};

function authorized(request: Request): boolean {
  // The worker has its own secret (audit 2026-10-26, H1: MCP_BEARER_TOKEN was
  // a skeleton key — every MCP tool as the owner, plus this whole API). The
  // old token is accepted ONLY while WORKER_BEARER_TOKEN is unset, so the
  // cutover is: set the new var, restart the PC's worker with it, then rotate
  // MCP_BEARER_TOKEN. Once WORKER_BEARER_TOKEN exists the old one is refused
  // here, with no overlap window to forget about.
  const expected = process.env.WORKER_BEARER_TOKEN || process.env.MCP_BEARER_TOKEN;
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

// A claim guard that re-derives a value and finds the row forged, or pointing
// outside its own account, is not a transient failure: a retry re-runs the
// same check against the same row. Dead-letter it on the first attempt instead
// of letting it sit at the queue head (it is the oldest queued row) for three
// more polls.
class ClaimRejected extends Error {}

// PostgREST returns an embedded one-to-one either as an object or as a
// one-element array depending on how it infers the relationship.
type GroupRel = { name: string } | { name: string }[] | null;
function groupName(rel: GroupRel): string | null {
  const row = Array.isArray(rel) ? (rel[0] ?? null) : rel;
  return row?.name ?? null;
}

// One worker_status row per tenant the worker actually serves, not just the
// owner: /settings reads the caller's own row, so an allowlisted user used to
// see "offline" and a stuck queue while their jobs were being drained.
async function markSeen(info: Record<string, unknown> = {}) {
  const supabase = createServiceClient();
  const lastSeenAt = new Date().toISOString();
  await supabase.from("worker_status").upsert(
    workerAllowedUserIds().map((userId) => ({ user_id: userId, last_seen_at: lastSeenAt, info })),
    { onConflict: "user_id" },
  );
}

// Post-claim ops address a job by its id alone, so they must re-assert the same
// allowlist `claim_next_job(allowed_users)` enforces on the way in — otherwise a
// bearer holder could heartbeat, complete, or fail a non-allowlisted tenant's
// job (whose completion writes that tenant's vault and Postgres rows) purely by
// guessing its id. Scoping the load is the single choke point: complete, fail,
// and the mid-finalize retry in the catch block all go through it.
async function loadJob(jobId: string): Promise<JobRow | null> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("jobs")
    .select("id, user_id, kind, payload, status, attempts")
    .eq("id", jobId)
    .in("user_id", workerAllowedUserIds())
    .maybeSingle();
  return (data as JobRow | null) ?? null;
}

async function failJob(job: JobRow, message: string, permanent = false) {
  const supabase = createServiceClient();
  const dead = permanent || job.attempts >= 3;
  await supabase
    .from("jobs")
    .update({ status: dead ? "failed" : "queued", error: message })
    .eq("id", job.id)
    .eq("user_id", job.user_id);

  if (!dead) return;
  // Dead-lettered: surface the failure on the thing the job was for.
  if (job.kind === "ocr" && typeof job.payload.source_id === "string") {
    await supabase
      .from("course_sources")
      .update({ status: "failed", error: `home worker: ${message}` })
      .eq("id", job.payload.source_id)
      .eq("user_id", job.user_id);
  }
  if (job.kind === "tts" && typeof job.payload.episode_id === "string") {
    await supabase
      .from("audio_episodes")
      .update({ status: "failed", error: `home worker: ${message}` })
      .eq("id", job.payload.episode_id)
      .eq("user_id", job.user_id);
  }
  // A reel has no DB row to mark; instead a dead-letter gets a visible,
  // create-only failure note in the vault (the plan's "reported outcome").
  // Best-effort: the jobs.error column records it regardless.
  if (job.kind === "reel") {
    try {
      const credentials = await readVaultCredentials(supabase, job.user_id);
      if (credentials) {
        const shortcode = String(job.payload.shortcode ?? "");
        const failureNote = await createVaultFileWithRetry(
          credentials,
          (attempt) => reelFailureNotePath(shortcode, attempt),
          buildReelFailureDocument({
            url: String(job.payload.url ?? ""),
            error: message,
            stampIso: zonedStamp(new Date(), await userTimeZone(supabase, job.user_id)).created,
          }),
          `Reel failed: ${shortcode}`,
        );
        if (failureNote.ok) revalidateVaultTree(job.user_id);
      }
    } catch {
      // best-effort — the job row still carries the error
    }
  }
}

async function enrichClaim(job: JobRow): Promise<Record<string, unknown>> {
  const supabase = createServiceClient();

  if (job.kind === "followup") {
    // The PC's run is research-only (web tools, no MCP, no credential), and
    // the write happens here on completion — so the claim carries nothing from
    // jobs.payload except the task id it is looked up by, and nothing the run
    // could write through. The owner gate is because the completion writes the
    // owner's Mindboard; a non-owner's follow-up has nowhere legitimate to go.
    if (job.user_id !== ownerUserId()) {
      throw new ClaimRejected("follow-ups only run for the deployment owner");
    }
    const taskId = String(job.payload.task_id ?? "");
    if (!taskId) throw new ClaimRejected("follow-up job carries no task id");
    const { data } = await supabase
      .from("tasks")
      .select("title, notes, priority, due_date, due_time, groups(name)")
      .eq("id", taskId)
      .eq("user_id", job.user_id)
      .maybeSingle();
    if (!data) throw new ClaimRejected("the follow-up's task no longer exists");
    const task = data as unknown as FollowupTaskRow & { groups: GroupRel };
    return {
      job: { id: job.id, kind: job.kind },
      followup: followupContext(task, groupName(task.groups), job.payload),
    };
  }

  if (job.kind === "reel") {
    // The worker downloads the reel itself (yt-dlp); it only needs the URL.
    // Transcript + frame notes + a cover thumbnail come back in the complete
    // body — no signed URL to hand out. The URL is re-derived through the same
    // canonicalizer the enqueue paths use, so what reaches the PC's command
    // line is always `https://www.instagram.com/reel/<shortcode>/` and never
    // whatever the row happened to hold.
    const ref = canonicalReelRef(job.payload.url);
    if (!ref.ok) throw new ClaimRejected(ref.error);
    return {
      job: { id: job.id, kind: job.kind },
      reel: { url: ref.value.url, shortcode: ref.value.shortcode },
    };
  }

  if (job.kind === "ocr") {
    const sourceId = String(job.payload.source_id ?? "");
    const { data: sourceRow } = await supabase
      .from("course_sources")
      .select(SOURCE_COLUMNS)
      .eq("id", sourceId)
      .eq("user_id", job.user_id)
      .maybeSingle();
    const source = sourceRow as CourseSource | null;
    if (!source?.storage_path) throw new Error("source has no stored pdf");
    // RLS lets a client PATCH storage_path after attachSourceFile checked it,
    // so re-assert the prefix before the service role signs a download for it
    // (audit M7; migration 0057 adds the matching CHECK).
    if (!storagePathBelongsTo(job.user_id, source.id, source.storage_path)) {
      throw new ClaimRejected("source pdf is stored outside this account's folder");
    }

    const { data: signed, error } = await supabase.storage
      .from("course-files")
      .createSignedUrl(source.storage_path, 3600);
    if (error || !signed) throw new Error("could not sign the pdf download");

    await supabase
      .from("course_sources")
      .update({ status: "converting", error: null })
      .eq("id", source.id)
      .eq("user_id", job.user_id);

    return {
      job: { id: job.id, kind: job.kind },
      source: { id: source.id, title: source.title },
      download_url: signed.signedUrl,
    };
  }

  const episodeId = String(job.payload.episode_id ?? "");
  const { data: episode } = await supabase
    .from("audio_episodes")
    .select("id, title, script")
    .eq("id", episodeId)
    .eq("user_id", job.user_id)
    .maybeSingle();
  const script = episode?.script as {
    lines?: { speaker: "A" | "B"; text: string }[];
  } | null;
  if (!script?.lines?.length) throw new Error("episode has no script");

  const audioPath = `${job.user_id}/${episodeId}.wav`;
  const { data: upload, error } = await supabase.storage
    .from("course-audio")
    .createSignedUploadUrl(audioPath, { upsert: true });
  if (error || !upload) throw new Error("could not sign the audio upload");

  await supabase
    .from("audio_episodes")
    .update({ status: "rendering", error: null })
    .eq("id", episodeId)
    .eq("user_id", job.user_id);

  return {
    job: { id: job.id, kind: job.kind },
    episode: {
      id: episodeId,
      title: episode?.title ?? "episode",
      text: scriptToVibeVoiceText(script.lines),
    },
    upload_url: upload.signedUrl,
    audio_path: audioPath,
  };
}

// The follow-up's write happens HERE, not on the PC: the run has no Mindboard
// credential and no MCP server, so it reports a validated result and the
// server creates exactly one task from it (audit 2026-10-26, C1 fix step 4).
async function completeFollowup(
  job: JobRow,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const supabase = createServiceClient();
  const parsed = parseFollowupResult(body.followup_result);
  if (!parsed.ok) throw new Error(parsed.error);
  const result = parsed.value;

  const taskId = String(job.payload.task_id ?? "");
  const { data: originalRow } = await supabase
    .from("tasks")
    .select("id, title, notes, priority, due_date, due_time, group_id")
    .eq("id", taskId)
    .eq("user_id", job.user_id)
    .maybeSingle();
  if (!originalRow) throw new Error("the follow-up's original task is gone");
  const original = originalRow as {
    id: string;
    notes: string | null;
    priority: string;
    due_date: string | null;
    due_time: string | null;
    group_id: string | null;
  };

  // "Exactly one follow-up task" as a database fact, not a prompt rule: the id
  // is derived from the job id, so a complete that blows up after the insert
  // (and is therefore requeued and re-run) collides instead of creating a
  // second task. On collision keep what already landed.
  const followupId = idempotentProposalId(job.user_id, "followup-task", job.id);
  const { error: insertError } = await supabase.from("tasks").insert({
    id: followupId,
    user_id: job.user_id,
    group_id: original.group_id,
    title: result.title,
    notes: result.notes || null,
    due_date: original.due_date,
    due_time: original.due_date ? original.due_time : null,
    priority: original.priority,
  });
  if (insertError && insertError.code !== "23505") {
    throw new Error(insertError.message);
  }

  let updatedOriginal = false;
  const update = result.original_update;
  if (update) {
    const patch: Record<string, unknown> = {
      ...(update.title ? { title: update.title } : {}),
      ...(update.due_date ? { due_date: update.due_date } : {}),
      ...(update.priority ? { priority: update.priority } : {}),
    };
    // A retried complete must not append the same section twice.
    if (update.notes_append && !(original.notes ?? "").includes(update.notes_append)) {
      const today = await todayKey(supabase, job.user_id);
      patch.notes = appendSection(original.notes, `Follow-up — ${today}`, update.notes_append);
    }
    const { error } = await supabase
      .from("tasks")
      .update(patch)
      .eq("id", original.id)
      .eq("user_id", job.user_id);
    if (error) throw new Error(error.message);
    updatedOriginal = true;
  }

  // Shape unchanged for whatever reads jobs.result (the watch's follow-up
  // receipt); only its provenance moved from the PC to here.
  return {
    created_task_ids: [followupId],
    updated_original: updatedOriginal,
    summary: typeof body.summary === "string" ? body.summary.slice(0, 500) : "",
    cost_usd: typeof body.cost_usd === "number" ? body.cost_usd : null,
  };
}

async function completeOcr(
  job: JobRow,
  body: { markdown?: unknown; page_count?: unknown },
): Promise<Record<string, unknown>> {
  const supabase = createServiceClient();
  const markdown = typeof body.markdown === "string" ? body.markdown.trim() : "";
  if (!markdown) throw new Error("markdown is required");
  const pageCount =
    Number.isInteger(Number(body.page_count)) && Number(body.page_count) > 0
      ? Number(body.page_count)
      : null;

  const sourceId = String(job.payload.source_id ?? "");
  const { data: sourceRow } = await supabase
    .from("course_sources")
    .select(SOURCE_COLUMNS)
    .eq("id", sourceId)
    .eq("user_id", job.user_id)
    .maybeSingle();
  const source = sourceRow as CourseSource | null;
  if (!source) throw new Error("source not found");

  const { data: courseRow } = await supabase
    .from("courses")
    .select("name")
    .eq("id", source.course_id)
    .eq("user_id", job.user_id)
    .maybeSingle();
  if (!courseRow) throw new Error("course not found");
  const courseName = courseRow.name as string;

  const credentials = await readVaultCredentials(supabase, job.user_id);
  if (!credentials) throw new Error(VAULT_NOT_CONFIGURED_MESSAGE);

  const document = buildSourceDocument({
    courseName,
    title: source.title,
    kind: source.kind,
    pageCount: pageCount ?? source.page_count,
    markdown,
    stamp: zonedStamp(new Date(), await userTimeZone(supabase, job.user_id)),
    via: "home worker",
  });

  const firstPath = courseSourcePath(courseName, source.title, 1);
  if (!firstPath.ok) throw new Error(firstPath.error);
  const written = await createVaultFileWithRetry(
    credentials,
    (attempt) => {
      const path = courseSourcePath(courseName, source.title, attempt);
      return path.ok ? path.value : firstPath.value;
    },
    document,
    `Course source: ${courseName} — ${source.title} (via home worker)`,
  );
  if (!written.ok) throw new Error(written.error);
  revalidateVaultTree(job.user_id);

  await supabase
    .from("course_sources")
    .update({
      status: "converted",
      vault_path: written.value.path,
      page_count: pageCount ?? source.page_count,
      error: null,
    })
    .eq("id", sourceId)
    .eq("user_id", job.user_id);

  return { vault_path: written.value.path };
}

async function completeTts(
  job: JobRow,
  body: { duration_sec?: unknown },
): Promise<Record<string, unknown>> {
  const supabase = createServiceClient();
  const episodeId = String(job.payload.episode_id ?? "");
  const durationSec =
    Number.isInteger(Number(body.duration_sec)) && Number(body.duration_sec) > 0
      ? Number(body.duration_sec)
      : null;

  const audioPath = `${job.user_id}/${episodeId}.wav`;
  // Trust nothing: confirm the worker actually uploaded the audio.
  const { data: signed } = await supabase.storage
    .from("course-audio")
    .createSignedUrl(audioPath, 60);
  if (!signed) throw new Error("audio not found in storage — upload failed?");

  await supabase
    .from("audio_episodes")
    .update({
      status: "done",
      storage_path: audioPath,
      duration_sec: durationSec,
      error: null,
    })
    .eq("id", episodeId)
    .eq("user_id", job.user_id);

  return { episode_id: episodeId };
}

const REEL_THUMB_EXT = new Set(["jpg", "jpeg", "png", "webp"]);

async function completeReel(
  job: JobRow,
  body: {
    title?: unknown;
    caption?: unknown;
    author?: unknown;
    duration_sec?: unknown;
    transcript?: unknown;
    frames?: unknown;
    thumbnail_base64?: unknown;
    thumbnail_ext?: unknown;
  },
): Promise<Record<string, unknown>> {
  const supabase = createServiceClient();
  const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
  const caption = typeof body.caption === "string" ? body.caption.trim() : "";
  // A reel with neither speech nor caption yielded nothing usable — fail so a
  // retry can run rather than committing an empty record.
  if (!transcript && !caption) throw new Error("no transcript or caption produced");

  const url = String(job.payload.url ?? "");
  const shortcode = String(job.payload.shortcode ?? "");
  const author = typeof body.author === "string" ? body.author.trim() : null;
  const durationSec =
    Number.isFinite(Number(body.duration_sec)) && Number(body.duration_sec) > 0
      ? Number(body.duration_sec)
      : null;
  const rawTitle = typeof body.title === "string" ? body.title.trim() : "";
  const title = rawTitle || (author ? `Reel by ${author}` : `Reel ${shortcode}`).slice(0, 120);

  const frames: ReelFrame[] = Array.isArray(body.frames)
    ? body.frames
        .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === "object")
        .map((f) => ({
          at: typeof f.at === "string" ? f.at : undefined,
          describe: typeof f.describe === "string" ? f.describe : undefined,
          text: typeof f.text === "string" ? f.text : undefined,
        }))
    : [];

  const credentials = await readVaultCredentials(supabase, job.user_id);
  if (!credentials) throw new Error(VAULT_NOT_CONFIGURED_MESSAGE);

  // Cover thumbnail: committed to the vault as an attachment (like shared
  // images), so the note embed resolves with no signed-URL expiry.
  let thumbnailEmbed: string | null = null;
  const thumbB64 = typeof body.thumbnail_base64 === "string" ? body.thumbnail_base64 : "";
  const thumbExtRaw = typeof body.thumbnail_ext === "string" ? body.thumbnail_ext : "jpg";
  const thumbExt = REEL_THUMB_EXT.has(thumbExtRaw.toLowerCase()) ? thumbExtRaw.toLowerCase() : "jpg";
  if (thumbB64) {
    const thumbWritten = await createVaultBase64FileWithRetry(
      credentials,
      (attempt) => reelThumbnailPath(title, thumbExt, attempt),
      thumbB64,
      `Reel thumbnail: ${title}`,
    );
    // Only embed a thumbnail that actually committed — a failed write must not
    // leave a broken image link in the note.
    thumbnailEmbed = thumbWritten.ok ? embedFor(thumbWritten.value.path) : null;
  }

  const document = buildReelDocument({
    url,
    title,
    author,
    caption: caption || null,
    durationSec,
    transcript,
    frames,
    thumbnailEmbed,
    stampIso: zonedStamp(new Date(), await userTimeZone(supabase, job.user_id)).created,
    via: "home worker",
  });

  const firstPath = reelNotePath(title, 1);
  const written = await createVaultFileWithRetry(
    credentials,
    (attempt) => reelNotePath(title, attempt),
    document,
    `Reel record: ${title} (via home worker)`,
  );
  if (!written.ok) throw new Error(written.error);
  // Covers the thumbnail commit above too — same tree, one invalidation.
  revalidateVaultTree(job.user_id);

  return { vault_path: written.value?.path ?? firstPath };
}

export async function POST(request: Request) {
  if (!authorized(request)) return bad("unauthorized", 401);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad("invalid json");
  }

  const supabase = createServiceClient();
  const op = String(body.op ?? "");

  try {
    if (op === "claim") {
      await markSeen((body.info as Record<string, unknown>) ?? {});
      const { data, error } = await supabase.rpc("claim_next_job", {
        allowed_users: workerAllowedUserIds(),
      });
      if (error) return bad(error.message, 500);
      const jobs = (data ?? []) as JobRow[];
      if (jobs.length === 0) return NextResponse.json({ job: null });
      const job = jobs[0];
      try {
        return NextResponse.json(await enrichClaim(job));
      } catch (e) {
        const message = e instanceof Error ? e.message : "claim enrichment failed";
        await failJob(job, message, e instanceof ClaimRejected);
        return NextResponse.json({ job: null, skipped: message });
      }
    }

    if (op === "heartbeat") {
      const jobId = String(body.job_id ?? "");
      if (!jobId) return bad("job_id required");
      // Same allowlist as loadJob, inlined so the heartbeat stays one round trip.
      await supabase
        .from("jobs")
        .update({ heartbeat_at: new Date().toISOString() })
        .eq("id", jobId)
        .eq("status", "processing")
        .in("user_id", workerAllowedUserIds());
      await markSeen();
      return NextResponse.json({ ok: true });
    }

    if (op === "complete") {
      const jobId = String(body.job_id ?? "");
      const job = await loadJob(jobId);
      if (!job) return bad("job not found", 404);
      if (job.status !== "processing") return bad(`job is ${job.status}`);

      const result =
        job.kind === "ocr"
          ? await completeOcr(job, body)
          : job.kind === "reel"
            ? await completeReel(job, body)
            : job.kind === "followup"
              ? await completeFollowup(job, body)
              : await completeTts(job, body);

      await supabase
        .from("jobs")
        .update({ status: "done", result, error: null })
        .eq("id", job.id)
        .eq("user_id", job.user_id);
      await markSeen();
      return NextResponse.json({ ok: true, ...result });
    }

    if (op === "fail") {
      const jobId = String(body.job_id ?? "");
      const job = await loadJob(jobId);
      if (!job) return bad("job not found", 404);
      if (job.status !== "processing") return bad(`job is ${job.status}`);
      await failJob(job, String(body.error ?? "worker reported failure"));
      await markSeen();
      return NextResponse.json({ ok: true });
    }

    return bad("unknown op");
  } catch (e) {
    const message = e instanceof Error ? e.message : "worker op failed";
    // A complete that blew up mid-finalize: put the job back for retry.
    if (op === "complete") {
      const job = await loadJob(String(body.job_id ?? ""));
      if (job && job.status === "processing") await failJob(job, message);
    }
    return bad(message, 500);
  }
}
