import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { createServiceClient } from "@/utils/supabase/service";
import { ownerUserId, workerAllowedUserIds } from "@/app/lib/mcp/config";
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
  vancouverStamp,
} from "@/app/lib/mcp/course-ops";
import { scriptToVibeVoiceText } from "@/app/lib/learn/podcast-script";
import {
  SOURCE_COLUMNS,
  type CourseSource,
} from "@/app/_components/learn-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The home worker's only door into the app. The PC holds no database key —
// just this bearer (the same static MCP_BEARER_TOKEN used by MCP tooling).
// Claims are atomic via claim_next_job() (FOR UPDATE SKIP LOCKED + stale-
// heartbeat reclaim); results land either in the request body (ocr markdown)
// or directly in storage via a signed upload URL (tts audio — too big for a
// route body). All vault/Postgres finalization stays here, in one code path.

type JobRow = {
  id: string;
  user_id: string;
  kind: "ocr" | "tts" | "reel";
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
};

function authorized(request: Request): boolean {
  const expected = process.env.MCP_BEARER_TOKEN;
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

async function markSeen(info: Record<string, unknown> = {}) {
  const supabase = createServiceClient();
  await supabase.from("worker_status").upsert(
    { user_id: ownerUserId(), last_seen_at: new Date().toISOString(), info },
    { onConflict: "user_id" },
  );
}

async function loadJob(jobId: string): Promise<JobRow | null> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("jobs")
    .select("id, user_id, kind, payload, status, attempts")
    .eq("id", jobId)
    .maybeSingle();
  return (data as JobRow | null) ?? null;
}

async function failJob(job: JobRow, message: string) {
  const supabase = createServiceClient();
  const dead = job.attempts >= 3;
  await supabase
    .from("jobs")
    .update({ status: dead ? "failed" : "queued", error: message })
    .eq("id", job.id);

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
            stampIso: vancouverStamp(new Date()).created,
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

  if (job.kind === "reel") {
    // The worker downloads the reel itself (yt-dlp); it only needs the URL.
    // Transcript + frame notes + a cover thumbnail come back in the complete
    // body — no signed URL to hand out.
    return {
      job: { id: job.id, kind: job.kind },
      reel: {
        url: String(job.payload.url ?? ""),
        shortcode: String(job.payload.shortcode ?? ""),
      },
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
    stamp: vancouverStamp(new Date()),
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
    stampIso: vancouverStamp(new Date()).created,
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
        await failJob(job, message);
        return NextResponse.json({ job: null, skipped: message });
      }
    }

    if (op === "heartbeat") {
      const jobId = String(body.job_id ?? "");
      if (!jobId) return bad("job_id required");
      await supabase
        .from("jobs")
        .update({ heartbeat_at: new Date().toISOString() })
        .eq("id", jobId)
        .eq("status", "processing");
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
            : await completeTts(job, body);

      await supabase
        .from("jobs")
        .update({ status: "done", result, error: null })
        .eq("id", job.id);
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
