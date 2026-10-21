import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/utils/supabase/service";
import type { Result } from "../mcp/validate";
import { logUrcEvent, URC_FOLDER_KEY_PATTERN, type UrcJobRow } from "./jobs";
import { isUuid, isValidSessionUrl, URC_LIVE_STATUSES } from "./preview";

// Layer 2 of URC's three gates: the PC's own credential. The device token only
// ever works on POST /api/urc/device — it is not an MCP token, cannot read any
// Mindboard data, and resolves to exactly one urc_devices row, which carries
// the user id every op is then scoped to. Only the SHA-256 hash is stored, so a
// database leak yields nothing usable.
//
// Like the home worker, the PC pulls: nothing in Mindboard can reach into this
// machine, so a compromised server can at most queue a job the agent then
// refuses (wrong owner, unknown folder, untrusted folder, switch off).

export const URC_DEVICE_TOKEN_PREFIX = "urcd_";

export type UrcDeviceAuth = {
  id: string;
  user_id: string;
  name: string;
};

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function looksLikeDeviceToken(token: string): boolean {
  return token.startsWith(URC_DEVICE_TOKEN_PREFIX) && token.length > 24;
}

function hashesMatch(presented: string, stored: unknown): boolean {
  if (typeof stored !== "string" || stored.length !== presented.length) return false;
  try {
    return timingSafeEqual(Buffer.from(presented, "utf8"), Buffer.from(stored, "utf8"));
  } catch {
    return false;
  }
}

// Resolve a presented device token. The candidate set is this deployment's
// registered devices (a handful of rows), and the hash comparison is
// constant-time per row, so a near-miss token leaks no timing signal.
export async function authenticateDevice(
  token: string | null | undefined,
): Promise<UrcDeviceAuth | null> {
  if (typeof token !== "string" || !looksLikeDeviceToken(token)) return null;
  const presented = hashDeviceToken(token);

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("urc_devices")
    .select("id, user_id, name, token_hash");
  if (error) throw new Error(error.message);

  let found: UrcDeviceAuth | null = null;
  for (const row of (data ?? []) as (UrcDeviceAuth & { token_hash: string })[]) {
    if (hashesMatch(presented, row.token_hash) && !found) {
      found = { id: row.id, user_id: row.user_id, name: row.name };
    }
  }
  return found;
}

function parseFolderKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const keys = raw
    .filter((k): k is string => typeof k === "string")
    .map((k) => k.trim())
    .filter((k) => URC_FOLDER_KEY_PATTERN.test(k));
  return [...new Set(keys)].slice(0, 50);
}

function parseFolderLabels(raw: unknown, keys: string[]): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const labels: Record<string, string> = {};
  for (const key of keys) {
    const label = source[key];
    if (typeof label === "string" && label.trim()) {
      labels[key] = label.trim().slice(0, 400);
    }
  }
  return labels;
}

async function loadDeviceJob(
  supabase: SupabaseClient,
  device: UrcDeviceAuth,
  jobId: string,
): Promise<UrcJobRow | null> {
  const { data } = await supabase
    .from("urc_jobs")
    .select(
      "id, user_id, device_id, folder_key, status, session_url, error, created_at, expires_at, claimed_at, started_at, stop_requested_at, stopped_at",
    )
    .eq("id", jobId)
    .eq("user_id", device.user_id)
    .eq("device_id", device.id)
    .maybeSingle();
  return (data as UrcJobRow | null) ?? null;
}

function jobIdOf(body: Record<string, unknown>): Result<string> {
  const jobId = body.job_id ?? body.jobId;
  if (!isUuid(jobId)) return { ok: false, error: "job_id must be a uuid" };
  return { ok: true, value: jobId };
}

// heartbeat: the PC's liveness ping, its folder inventory, and its permission
// mode. bypass_permissions is REPORTED here and nowhere else — the server has
// no way to set it, which is why a bypass session can only ever be enabled at
// the machine itself.
export async function deviceHeartbeat(
  device: UrcDeviceAuth,
  body: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const supabase = createServiceClient();
  const folderKeys = parseFolderKeys(body.folder_keys);
  const folderLabels = parseFolderLabels(body.folder_labels, folderKeys);

  const { error } = await supabase
    .from("urc_devices")
    .update({
      last_seen: new Date().toISOString(),
      folder_keys: folderKeys,
      folder_labels: folderLabels,
      bypass_permissions: body.bypass_permissions === true,
    })
    .eq("id", device.id)
    .eq("user_id", device.user_id);
  if (error) return { ok: false, error: error.message };

  const { data: stopping, error: stopError } = await supabase
    .from("urc_jobs")
    .select("id, stop_requested_at")
    .eq("user_id", device.user_id)
    .eq("device_id", device.id)
    .in("status", [...URC_LIVE_STATUSES])
    .not("stop_requested_at", "is", null);
  if (stopError) return { ok: false, error: stopError.message };

  const rows = (stopping ?? []) as { id: string; stop_requested_at: string | null }[];
  const requestedAt: Record<string, string> = {};
  for (const row of rows) {
    if (row.stop_requested_at) requestedAt[row.id] = row.stop_requested_at;
  }

  return {
    ok: true,
    value: {
      ok: true,
      stop_requested: rows.map((row) => row.id),
      // When each stop was asked for. The agent needs this to tell "a job I
      // never tracked" from "a job another agent is still spawning": it only
      // acknowledges a stop it cannot act on once the request has aged.
      stop_requested_at: requestedAt,
    },
  };
}

export async function deviceClaim(
  device: UrcDeviceAuth,
): Promise<Result<Record<string, unknown>>> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("claim_urc_job", { p_device: device.id });
  if (error) return { ok: false, error: error.message };

  const rows = (data ?? []) as UrcJobRow[];
  const job = rows[0];
  // Belt and braces: the RPC already scopes to the device's user.
  if (!job || job.user_id !== device.user_id || job.device_id !== device.id) {
    return { ok: true, value: { job: null } };
  }
  return {
    ok: true,
    value: {
      job: { id: job.id, user_id: job.user_id, folder_key: job.folder_key },
    },
  };
}

export async function deviceStarted(
  device: UrcDeviceAuth,
  body: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const parsed = jobIdOf(body);
  if (!parsed.ok) return parsed;
  const sessionUrl = body.session_url;
  if (!isValidSessionUrl(sessionUrl)) {
    return { ok: false, error: "session_url must be https://claude.ai/code/session_..." };
  }
  const pidHint =
    Number.isInteger(body.pid_hint) && Number(body.pid_hint) > 0
      ? Number(body.pid_hint)
      : null;

  const supabase = createServiceClient();
  const job = await loadDeviceJob(supabase, device, parsed.value);
  if (!job) return { ok: false, error: "job not found" };
  // Idempotent for the exact same session: the agent retries this report when a
  // response is lost, and the retry must not read as a failure.
  if (job.status === "running" && job.session_url === sessionUrl) {
    return { ok: true, value: { ok: true } };
  }
  if (job.status !== "claimed") return { ok: false, error: `job is ${job.status}` };

  const { data: updated, error } = await supabase
    .from("urc_jobs")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      session_url: sessionUrl,
      pid_hint: pidHint,
      // Recorded from the PC's report, which is the only authority on it.
      bypass_permissions: body.bypass_permissions === true,
    })
    .eq("id", job.id)
    .eq("user_id", device.user_id)
    .eq("device_id", device.id)
    .eq("status", "claimed")
    .select("id");
  if (error) return { ok: false, error: error.message };
  if ((updated ?? []).length === 0) return { ok: false, error: "job is no longer claimed" };

  await logUrcEvent(supabase, device.user_id, "started", {
    jobId: job.id,
    folderKey: job.folder_key,
    detail: `session live on ${device.name}${
      body.bypass_permissions === true ? " (permissions bypassed on the PC)" : ""
    }`,
  });
  return { ok: true, value: { ok: true } };
}

export async function deviceFailed(
  device: UrcDeviceAuth,
  body: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const parsed = jobIdOf(body);
  if (!parsed.ok) return parsed;
  const message =
    typeof body.error === "string" && body.error.trim()
      ? body.error.trim().slice(0, 500)
      : "the PC reported a failure";

  const supabase = createServiceClient();
  const job = await loadDeviceJob(supabase, device, parsed.value);
  if (!job) return { ok: false, error: "job not found" };
  if (job.status === "failed") return { ok: true, value: { ok: true } };
  if (!["claimed", "running", "stopping"].includes(job.status)) {
    return { ok: false, error: `job is ${job.status}` };
  }

  const { error } = await supabase
    .from("urc_jobs")
    .update({ status: "failed", error: message, stopped_at: new Date().toISOString() })
    .eq("id", job.id)
    .eq("user_id", device.user_id)
    .eq("device_id", device.id);
  if (error) return { ok: false, error: error.message };

  await logUrcEvent(supabase, device.user_id, "failed", {
    jobId: job.id,
    folderKey: job.folder_key,
    detail: message,
  });
  return { ok: true, value: { ok: true } };
}

export async function deviceStopped(
  device: UrcDeviceAuth,
  body: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const parsed = jobIdOf(body);
  if (!parsed.ok) return parsed;

  const supabase = createServiceClient();
  const job = await loadDeviceJob(supabase, device, parsed.value);
  if (!job) return { ok: false, error: "job not found" };
  // Already final. 'failed' and 'expired' matter here: the agent reports
  // `stopped` for every session whose process it finds gone, which includes one
  // it has just reported `failed` — and that error is the only explanation the
  // chat ever gets, so it must not be overwritten by a generic stop.
  if (["stopped", "failed", "expired"].includes(job.status)) {
    return { ok: true, value: { ok: true } };
  }

  const { error } = await supabase
    .from("urc_jobs")
    .update({ status: "stopped", stopped_at: new Date().toISOString() })
    .eq("id", job.id)
    .eq("user_id", device.user_id)
    .eq("device_id", device.id);
  if (error) return { ok: false, error: error.message };

  await logUrcEvent(supabase, device.user_id, "stopped", {
    jobId: job.id,
    folderKey: job.folder_key,
    detail: typeof body.detail === "string" ? body.detail.slice(0, 200) : null,
  });
  return { ok: true, value: { ok: true } };
}

export async function handleDeviceOp(
  device: UrcDeviceAuth,
  body: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  switch (String(body.op ?? "")) {
    case "heartbeat":
      return deviceHeartbeat(device, body);
    case "claim":
      return deviceClaim(device);
    case "started":
      return deviceStarted(device, body);
    case "failed":
      return deviceFailed(device, body);
    case "stopped":
      return deviceStopped(device, body);
    default:
      return { ok: false, error: "unknown op" };
  }
}
