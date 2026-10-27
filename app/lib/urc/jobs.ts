import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/utils/supabase/service";
import { recordProposal, type ExecutorContext } from "../mcp/audit";
import type { Result } from "../mcp/validate";
import { urcAuth } from "./auth";
import {
  isDeviceOnline,
  isUuid,
  normalizeUrcLabel,
  renderSpawnPreview,
  URC_CLOCK_SKEW_MS,
  URC_CONCURRENCY_STATUSES,
  URC_JOB_TTL_MS,
  URC_MAX_LIVE_SESSIONS,
  URC_MAX_SPAWNS_PER_HOUR,
  URC_OFFLINE,
  URC_PROPOSAL_TTL_MS,
  URC_SPAWNS_WINDOW_MS,
  urcSessionName,
} from "./preview";

// The four URC tools' server side: propose a spawn, execute a confirmed one,
// read a job, list recent jobs, request a stop. Everything here runs on the
// service client (RLS-bypassing), so every single query filters by user_id —
// the multi-tenant MCP invariant.
//
// The confirm executor deliberately re-derives EVERYTHING (owner, device,
// online state, folder, limits) from server state and reads only the folder key
// out of the stored proposal input, because an ai_audit_log 'proposed' row is
// forgeable by any signed-in user.

const DEVICE_COLUMNS =
  "id, user_id, name, folder_keys, folder_labels, bypass_permissions, last_seen";

const JOB_COLUMNS =
  "id, user_id, device_id, folder_key, label, status, session_url, error, bypass_permissions, created_at, expires_at, claimed_at, started_at, stop_requested_at, stopped_at";

export type UrcDeviceRow = {
  id: string;
  user_id: string;
  name: string;
  folder_keys: string[] | null;
  folder_labels: Record<string, string> | null;
  bypass_permissions: boolean | null;
  last_seen: string | null;
};

export type UrcJobRow = {
  id: string;
  user_id: string;
  device_id: string;
  folder_key: string;
  // Chat-chosen session name (normalized), or null for the default urc-<id>.
  label?: string | null;
  status: string;
  session_url: string | null;
  error: string | null;
  created_at: string;
  expires_at: string;
  claimed_at: string | null;
  started_at: string | null;
  stop_requested_at: string | null;
  stopped_at: string | null;
  bypass_permissions: boolean | null;
};

export type UrcProposal = { proposalId: string; preview: string };

// Folder keys are the PC's own labels, but they land in logs and previews, so
// the server keeps them to a conservative charset rather than echoing anything
// the agent reports.
export const URC_FOLDER_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;

export type UrcLogEvent =
  | "spawn_confirmed"
  | "started"
  | "failed"
  | "stop_requested"
  | "stopped"
  | "expired";

export async function logUrcEvent(
  supabase: SupabaseClient,
  userId: string,
  event: UrcLogEvent,
  fields: {
    jobId?: string | null;
    folderKey?: string | null;
    confirmedAuth?: string | null;
    detail?: string | null;
  } = {},
): Promise<void> {
  await supabase.from("urc_log").insert({
    user_id: userId,
    job_id: fields.jobId ?? null,
    event,
    folder_key: fields.folderKey ?? null,
    confirmed_auth: fields.confirmedAuth ?? null,
    detail: fields.detail ? fields.detail.slice(0, 500) : null,
  });
}

function parseFolder(raw: unknown): Result<string> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const folder = typeof input.folder === "string" ? input.folder.trim() : "";
  if (!folder) return { ok: false, error: "folder is required" };
  if (!URC_FOLDER_KEY_PATTERN.test(folder)) {
    return {
      ok: false,
      error: "folder must be a folder key the PC reported (letters, digits, . _ -)",
    };
  }
  return { ok: true, value: folder };
}

async function loadDevices(
  supabase: SupabaseClient,
  userId: string,
): Promise<UrcDeviceRow[]> {
  const { data, error } = await supabase
    .from("urc_devices")
    .select(DEVICE_COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as UrcDeviceRow[];
}

function folderKeysOf(device: UrcDeviceRow): string[] {
  return Array.isArray(device.folder_keys) ? device.folder_keys : [];
}

function folderLabelOf(device: UrcDeviceRow, key: string): string | null {
  const labels = device.folder_labels;
  if (!labels || typeof labels !== "object") return null;
  const label = (labels as Record<string, unknown>)[key];
  return typeof label === "string" && label ? label : null;
}

// Pure device selection: v1 expects one registered PC, so a folder key offered
// by two devices is an error rather than a guess.
export function pickDeviceForFolder(
  devices: UrcDeviceRow[],
  folderKey: string,
): Result<UrcDeviceRow> {
  if (devices.length === 0) {
    return { ok: false, error: "no PC is registered for URC on this account" };
  }
  const matches = devices.filter((d) => folderKeysOf(d).includes(folderKey));
  if (matches.length === 0) {
    const available = [...new Set(devices.flatMap(folderKeysOf))];
    return {
      ok: false,
      error: available.length
        ? `that folder isn't available on your PC — it offers: ${available.join(", ")}`
        : "your PC hasn't reported any folders yet",
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: "more than one registered PC offers that folder — URC v1 expects one",
    };
  }
  return { ok: true, value: matches[0] };
}

// Close out jobs that can no longer go anywhere, so they stop occupying the
// concurrency limit. Two cases: a queued job nobody claimed inside its two
// minutes (the PC was off), and a claimed job the PC never started — a crash
// or a reboot mid-spawn, which would otherwise hold a slot forever since only
// the PC can move it on. Runs before any limit is counted, and on reads.
export async function sweepStaleJobs(
  supabase: SupabaseClient,
  userId: string,
  nowMs: number,
): Promise<void> {
  const nowIso = new Date(nowMs).toISOString();
  const { data: expired } = await supabase
    .from("urc_jobs")
    .update({ status: "expired" })
    .eq("user_id", userId)
    .eq("status", "queued")
    .lt("expires_at", nowIso)
    .select("id, folder_key");
  for (const row of (expired ?? []) as { id: string; folder_key: string }[]) {
    await logUrcEvent(supabase, userId, "expired", {
      jobId: row.id,
      folderKey: row.folder_key,
      detail: "not claimed before expires_at",
    });
  }

  const staleClaim = new Date(nowMs - URC_JOB_TTL_MS).toISOString();
  const { data: stuck } = await supabase
    .from("urc_jobs")
    .update({
      status: "failed",
      error: "the PC claimed the job but never started it",
      stopped_at: nowIso,
    })
    .eq("user_id", userId)
    .eq("status", "claimed")
    .is("started_at", null)
    .lt("claimed_at", staleClaim)
    .select("id, folder_key");
  for (const row of (stuck ?? []) as { id: string; folder_key: string }[]) {
    await logUrcEvent(supabase, userId, "failed", {
      jobId: row.id,
      folderKey: row.folder_key,
      detail: "claimed but never started",
    });
  }
}

async function checkLimits(
  supabase: SupabaseClient,
  userId: string,
  nowMs: number,
): Promise<Result<null>> {
  await sweepStaleJobs(supabase, userId, nowMs);

  const { data: live, error: liveError } = await supabase
    .from("urc_jobs")
    .select("id")
    .eq("user_id", userId)
    .in("status", [...URC_CONCURRENCY_STATUSES]);
  if (liveError) return { ok: false, error: liveError.message };
  if ((live ?? []).length >= URC_MAX_LIVE_SESSIONS) {
    return {
      ok: false,
      error: `${URC_MAX_LIVE_SESSIONS} sessions are already live — stop one first (stop_urc)`,
    };
  }

  const since = new Date(nowMs - URC_SPAWNS_WINDOW_MS).toISOString();
  const { data: recent, error: recentError } = await supabase
    .from("urc_jobs")
    .select("id")
    .eq("user_id", userId)
    .gte("created_at", since);
  if (recentError) return { ok: false, error: recentError.message };
  if ((recent ?? []).length >= URC_MAX_SPAWNS_PER_HOUR) {
    return {
      ok: false,
      error: `URC is rate limited to ${URC_MAX_SPAWNS_PER_HOUR} sessions an hour — try again later`,
    };
  }
  return { ok: true, value: null };
}

// Everything the server must agree with before a session may start. Run at
// propose time for a useful preview, and again at confirm time as the real
// gate — the propose-time pass is a courtesy, not a decision.
async function resolveSpawn(
  supabase: SupabaseClient,
  userId: string,
  folderKey: string,
  nowMs: number,
): Promise<Result<{ device: UrcDeviceRow; folderLabel: string | null }>> {
  const devices = await loadDevices(supabase, userId);
  const picked = pickDeviceForFolder(devices, folderKey);
  if (!picked.ok) return picked;
  const device = picked.value;

  if (!isDeviceOnline(device.last_seen, nowMs)) {
    return { ok: false, error: URC_OFFLINE };
  }

  const limits = await checkLimits(supabase, userId, nowMs);
  if (!limits.ok) return limits;

  return {
    ok: true,
    value: { device, folderLabel: folderLabelOf(device, folderKey) },
  };
}

export async function proposeSpawnUrc(
  userId: string,
  authKind: string,
  raw: unknown,
): Promise<Result<UrcProposal>> {
  const auth = urcAuth(userId, authKind);
  if (!auth.ok) return auth;

  const folder = parseFolder(raw);
  if (!folder.ok) return folder;
  const label = normalizeUrcLabel((raw as Record<string, unknown> | null)?.name);
  if (!label.ok) return label;

  const supabase = createServiceClient();
  const resolved = await resolveSpawn(supabase, userId, folder.value, Date.now());
  if (!resolved.ok) return resolved;

  const preview = renderSpawnPreview({
    deviceName: resolved.value.device.name,
    folderKey: folder.value,
    folderLabel: resolved.value.folderLabel,
    bypass: resolved.value.device.bypass_permissions === true,
    label: label.value,
  });

  const proposalId = await recordProposal(
    supabase,
    userId,
    "spawn_urc",
    { folder: folder.value, deviceId: resolved.value.device.id, name: label.value },
    preview,
  );
  return { ok: true, value: { proposalId, preview } };
}

// EXECUTORS.spawn_urc. Reached only through confirmAction, which has already
// claimed the proposal (single-use) and scoped it to this user.
export async function executeSpawnUrc(
  supabase: SupabaseClient,
  ownerId: string,
  input: Record<string, unknown>,
  context?: ExecutorContext,
): Promise<Result<Record<string, unknown>>> {
  const auth = urcAuth(ownerId, context?.authKind);
  if (!auth.ok) return auth;

  const nowMs = Date.now();
  const proposedAtMs = context?.proposedAt ? Date.parse(context.proposedAt) : NaN;
  if (Number.isNaN(proposedAtMs) || nowMs - proposedAtMs > URC_PROPOSAL_TTL_MS) {
    return {
      ok: false,
      error: "this session request is more than 5 minutes old — ask for a new one",
    };
  }
  // A future timestamp is not a fresh proposal, it is a forged one: ai_audit_log
  // lets a signed-in user insert their own row, and a created_at an hour ahead
  // would otherwise make the 5-minute window last an hour.
  if (proposedAtMs - nowMs > URC_CLOCK_SKEW_MS) {
    return { ok: false, error: "this session request is dated in the future — ask again" };
  }

  const folder = parseFolder(input);
  if (!folder.ok) return folder;
  // Re-normalized from the stored input like the folder: the proposal row is
  // forgeable, so the name is held to the same allowlist again here.
  const label = normalizeUrcLabel(input.name);
  if (!label.ok) return label;

  const resolved = await resolveSpawn(supabase, ownerId, folder.value, nowMs);
  if (!resolved.ok) return resolved;

  const { data, error } = await supabase
    .from("urc_jobs")
    .insert({
      user_id: ownerId,
      device_id: resolved.value.device.id,
      folder_key: folder.value,
      label: label.value,
      status: "queued",
      audit_id: context?.proposalId ?? null,
      confirmed_auth: auth.value.confirmedAuth,
      expires_at: new Date(nowMs + URC_JOB_TTL_MS).toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) {
    // urc_jobs_audit_unique: this proposal already produced a job.
    const conflict =
      (error as { code?: string } | null)?.code === "23505" ||
      /duplicate key|already exists/i.test(error?.message ?? "");
    if (conflict) {
      return { ok: false, error: "this session request has already been confirmed" };
    }
    return { ok: false, error: error?.message ?? "could not queue the session" };
  }
  const jobId = data.id as string;

  await logUrcEvent(supabase, ownerId, "spawn_confirmed", {
    jobId,
    folderKey: folder.value,
    confirmedAuth: auth.value.confirmedAuth,
    detail: `device ${resolved.value.device.name}`,
  });

  return {
    ok: true,
    value: {
      jobId,
      sessionName: urcSessionName(jobId, label.value),
      folder: folder.value,
      status: "queued",
      message: "queued on your PC — check get_urc_status in a few seconds",
    },
  };
}

async function loadJob(
  supabase: SupabaseClient,
  userId: string,
  jobId: string,
): Promise<UrcJobRow | null> {
  const { data } = await supabase
    .from("urc_jobs")
    .select(JOB_COLUMNS)
    .eq("id", jobId)
    .eq("user_id", userId)
    .maybeSingle();
  return (data as UrcJobRow | null) ?? null;
}

function parseJobId(raw: unknown): Result<string> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const jobId = input.jobId ?? input.job_id;
  if (!isUuid(jobId)) return { ok: false, error: "jobId must be a uuid" };
  return { ok: true, value: jobId };
}

export async function getUrcStatus(
  userId: string,
  authKind: string,
  raw: unknown,
): Promise<Result<Record<string, unknown>>> {
  const auth = urcAuth(userId, authKind);
  if (!auth.ok) return auth;
  const parsed = parseJobId(raw);
  if (!parsed.ok) return parsed;

  const supabase = createServiceClient();
  // Lazily close out anything that can no longer progress — a queued job the PC
  // never claimed, or a claimed one it never started — so a read never reports
  // a session as pending forever. claim_urc_job does the queued half on the
  // other side of the queue.
  await sweepStaleJobs(supabase, userId, Date.now());

  const job = await loadJob(supabase, userId, parsed.value);
  if (!job) return { ok: false, error: "session not found" };
  const status = job.status;

  return {
    ok: true,
    value: {
      jobId: job.id,
      sessionName: urcSessionName(job.id, job.label),
      status,
      folder: job.folder_key,
      createdAt: job.created_at,
      startedAt: job.started_at,
      stoppedAt: job.stopped_at,
      stopRequestedAt: job.stop_requested_at,
      error: job.error,
      // What the PC reported it actually started with (null before it starts).
      bypassPermissions: job.bypass_permissions,
      // The link is a live handle to a session on Lucca's PC, so it is returned
      // only while there is a session to open.
      sessionUrl: status === "running" ? job.session_url : null,
    },
  };
}

export async function listUrcSessions(
  userId: string,
  authKind: string,
): Promise<Result<Record<string, unknown>>> {
  const auth = urcAuth(userId, authKind);
  if (!auth.ok) return auth;

  const supabase = createServiceClient();
  const nowMs = Date.now();
  await sweepStaleJobs(supabase, userId, nowMs);
  const since = new Date(nowMs - 24 * 60 * 60_000).toISOString();

  const [devices, jobs] = await Promise.all([
    loadDevices(supabase, userId),
    supabase
      .from("urc_jobs")
      .select(JOB_COLUMNS)
      .eq("user_id", userId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);
  if (jobs.error) return { ok: false, error: jobs.error.message };

  return {
    ok: true,
    value: {
      devices: devices.map((device) => ({
        name: device.name,
        online: isDeviceOnline(device.last_seen, nowMs),
        lastSeen: device.last_seen,
        folders: folderKeysOf(device),
        bypassPermissions: device.bypass_permissions === true,
      })),
      sessions: ((jobs.data ?? []) as UrcJobRow[]).map((job) => ({
        jobId: job.id,
        sessionName: urcSessionName(job.id, job.label),
        status: job.status,
        folder: job.folder_key,
        createdAt: job.created_at,
        startedAt: job.started_at,
        stoppedAt: job.stopped_at,
        error: job.error,
      })),
      // Least exposure: the list is a browsing surface, so it never carries a
      // link that can open a live session. Ask get_urc_status for one job.
      note: "session links come only from get_urc_status, and only while a session is running",
    },
  };
}

export async function stopUrc(
  userId: string,
  authKind: string,
  raw: unknown,
): Promise<Result<Record<string, unknown>>> {
  const auth = urcAuth(userId, authKind);
  if (!auth.ok) return auth;
  const parsed = parseJobId(raw);
  if (!parsed.ok) return parsed;

  const supabase = createServiceClient();
  const job = await loadJob(supabase, userId, parsed.value);
  if (!job) return { ok: false, error: "session not found" };

  if (job.status === "stopped" || job.status === "failed" || job.status === "expired") {
    return {
      ok: true,
      value: { jobId: job.id, status: job.status, alreadyFinished: true },
    };
  }

  const nowIso = new Date().toISOString();
  // 'queued' is the ONLY state with nothing running anywhere: it goes straight
  // to stopped, which also pulls it out of the queue (only queued rows are
  // claimable). A 'claimed' job must go to 'stopping' even though started_at is
  // still null — the PC may be mid-spawn, and 'stopping' is what the heartbeat
  // hands it so the agent kills the window it is about to have.
  const neverStarted = job.status === "queued";
  const { data: updated, error } = await supabase
    .from("urc_jobs")
    .update({
      status: neverStarted ? "stopped" : "stopping",
      stop_requested_at: job.stop_requested_at ?? nowIso,
      stopped_at: neverStarted ? nowIso : job.stopped_at,
    })
    .eq("id", job.id)
    .eq("user_id", userId)
    .eq("status", job.status)
    .select("id, status");
  if (error) return { ok: false, error: error.message };
  if ((updated ?? []).length === 0) {
    return { ok: false, error: "that session just changed state — check get_urc_status" };
  }

  await logUrcEvent(supabase, userId, "stop_requested", {
    jobId: job.id,
    folderKey: job.folder_key,
    confirmedAuth: auth.value.confirmedAuth,
    detail: neverStarted ? "stopped before it started" : "stop requested",
  });
  if (neverStarted) {
    await logUrcEvent(supabase, userId, "stopped", {
      jobId: job.id,
      folderKey: job.folder_key,
      detail: "never started",
    });
  }

  return {
    ok: true,
    value: {
      jobId: job.id,
      status: neverStarted ? "stopped" : "stopping",
      message: neverStarted
        ? "that session never started — it won't run"
        : "stop requested; your PC closes it within a few seconds",
    },
  };
}
