// The device endpoint's guards (app/lib/urc/device.ts): token authentication,
// and the fact that every op is scoped to the authenticated device's own user
// AND its own device id — a valid device token must not be able to touch
// another account's (or another machine's) session.
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";

const mocks = vi.hoisted(() => ({ createServiceClient: vi.fn() }));

vi.mock("@/utils/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));

import {
  authenticateDevice,
  deviceClaim,
  deviceFailed,
  deviceHeartbeat,
  deviceStarted,
  deviceStopped,
  handleDeviceOp,
} from "@/app/lib/urc/device";
import { makeDb, type FakeDb, type Row } from "./urc-fake-db";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const DEVICE_A = "33333333-3333-4333-8333-333333333333";
const DEVICE_B = "99999999-9999-4999-8999-999999999999";
const JOB = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-10-21T18:00:00.000Z");

const TOKEN_A = "urcd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B = "urcd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function hash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

const AUTH_A = { id: DEVICE_A, user_id: OWNER, name: "home-pc" };

function device(over: Partial<Row> = {}): Row {
  return {
    id: DEVICE_A,
    user_id: OWNER,
    name: "home-pc",
    token_hash: hash(TOKEN_A),
    folder_keys: ["mindboard"],
    folder_labels: {},
    bypass_permissions: false,
    last_seen: null,
    created_at: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

function job(over: Partial<Row> = {}): Row {
  return {
    id: JOB,
    user_id: OWNER,
    device_id: DEVICE_A,
    folder_key: "mindboard",
    status: "claimed",
    session_url: null,
    error: null,
    audit_id: null,
    confirmed_auth: "pat",
    created_at: new Date(NOW.getTime() - 20_000).toISOString(),
    expires_at: new Date(NOW.getTime() + 100_000).toISOString(),
    claimed_at: NOW.toISOString(),
    started_at: null,
    stop_requested_at: null,
    stopped_at: null,
    pid_hint: null,
    ...over,
  };
}

function install(tables: Partial<Record<string, Row[]>> = {}): FakeDb {
  const db = makeDb({
    urc_devices: tables.urc_devices ?? [device()],
    urc_jobs: tables.urc_jobs ?? [],
    urc_log: tables.urc_log ?? [],
  });
  // Mirrors claim_urc_job: expire the aged-out queued rows, then take the
  // oldest still-valid queued row for this device's user.
  db.rpcImpl.claim_urc_job = (args, self) => {
    const deviceId = args.p_device as string;
    const owner = (self.tables.urc_devices.find((row) => row.id === deviceId)?.user_id ??
      null) as string | null;
    if (!owner) return { data: [], error: null };
    const mine = self.tables.urc_jobs.filter(
      (row) => row.device_id === deviceId && row.user_id === owner,
    );
    for (const row of mine) {
      if (row.status === "queued" && String(row.expires_at) <= NOW.toISOString()) {
        row.status = "expired";
        self.tables.urc_log.push({
          user_id: owner,
          job_id: row.id,
          event: "expired",
          detail: "not claimed before expires_at",
        });
      }
    }
    const next = mine
      .filter((row) => row.status === "queued" && String(row.expires_at) > NOW.toISOString())
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
    if (!next) return { data: [], error: null };
    next.status = "claimed";
    next.claimed_at = NOW.toISOString();
    return { data: [{ ...next }], error: null };
  };
  mocks.createServiceClient.mockReturnValue(db);
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("authenticateDevice", () => {
  test("a registered token resolves to its device", async () => {
    install();
    await expect(authenticateDevice(TOKEN_A)).resolves.toEqual(AUTH_A);
  });

  test("the right device is picked out of several", async () => {
    install({
      urc_devices: [
        device(),
        device({ id: DEVICE_B, user_id: OTHER, name: "other-pc", token_hash: hash(TOKEN_B) }),
      ],
    });
    await expect(authenticateDevice(TOKEN_B)).resolves.toEqual({
      id: DEVICE_B,
      user_id: OTHER,
      name: "other-pc",
    });
  });

  test("an unknown token is refused", async () => {
    install();
    await expect(authenticateDevice(TOKEN_B)).resolves.toBeNull();
  });

  test("an MCP PAT is not a device token", async () => {
    install();
    await expect(authenticateDevice("mbp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa")).resolves.toBeNull();
  });

  test("a missing or stub token is refused", async () => {
    install();
    await expect(authenticateDevice(null)).resolves.toBeNull();
    await expect(authenticateDevice("")).resolves.toBeNull();
    await expect(authenticateDevice("urcd_short")).resolves.toBeNull();
  });
});

describe("heartbeat", () => {
  test("records liveness, folders and the PC's permission mode", async () => {
    const db = install();
    const result = await deviceHeartbeat(AUTH_A, {
      folder_keys: ["mindboard", "vault", "bad key", "mindboard"],
      folder_labels: { mindboard: "C:\\mindboard", nope: "C:\\nope" },
      bypass_permissions: true,
    });
    expect(result).toEqual({
      ok: true,
      value: { ok: true, stop_requested: [], stop_requested_at: {} },
    });

    const row = db.tables.urc_devices[0];
    expect(row.last_seen).toBe(NOW.toISOString());
    expect(row.folder_keys).toEqual(["mindboard", "vault"]);
    expect(row.folder_labels).toEqual({ mindboard: "C:\\mindboard" });
    expect(row.bypass_permissions).toBe(true);
  });

  test("a non-boolean bypass report reads as off", async () => {
    const db = install();
    await deviceHeartbeat(AUTH_A, { folder_keys: [], bypass_permissions: "true" });
    expect(db.tables.urc_devices[0].bypass_permissions).toBe(false);
  });

  // The agent needs the age of each request to decide whether a stop for a job
  // it does not track is safe to acknowledge.
  test("reports when each stop was requested", async () => {
    const requestedAt = new Date(NOW.getTime() - 90_000).toISOString();
    install({
      urc_jobs: [job({ id: "mine", status: "stopping", stop_requested_at: requestedAt })],
    });
    const result = await deviceHeartbeat(AUTH_A, { folder_keys: ["mindboard"] });
    expect(result.ok && result.value).toEqual({
      ok: true,
      stop_requested: ["mine"],
      stop_requested_at: { mine: requestedAt },
    });
  });

  test("returns only this device's stop requests", async () => {
    install({
      urc_jobs: [
        job({ id: "mine", status: "running", stop_requested_at: NOW.toISOString() }),
        job({ id: "quiet", status: "running" }),
        job({
          id: "other-device",
          device_id: DEVICE_B,
          status: "running",
          stop_requested_at: NOW.toISOString(),
        }),
        job({
          id: "other-user",
          user_id: OTHER,
          status: "running",
          stop_requested_at: NOW.toISOString(),
        }),
        job({ id: "done", status: "stopped", stop_requested_at: NOW.toISOString() }),
      ],
    });
    const result = await deviceHeartbeat(AUTH_A, { folder_keys: ["mindboard"] });
    expect(result.ok && result.value.stop_requested).toEqual(["mine"]);
  });
});

describe("claim", () => {
  test("claims a queued job for this device", async () => {
    const db = install({ urc_jobs: [job({ status: "queued", claimed_at: null })] });
    const result = await deviceClaim(AUTH_A);
    expect(result.ok && result.value.job).toEqual({
      id: JOB,
      user_id: OWNER,
      folder_key: "mindboard",
      label: null,
    });
    expect(db.tables.urc_jobs[0].status).toBe("claimed");
  });

  test("another device's queued job is never claimed", async () => {
    const db = install({
      urc_jobs: [job({ status: "queued", device_id: DEVICE_B, claimed_at: null })],
    });
    await expect(deviceClaim(AUTH_A)).resolves.toEqual({ ok: true, value: { job: null } });
    expect(db.tables.urc_jobs[0].status).toBe("queued");
  });

  test("an expired queued job is retired, not handed out", async () => {
    const db = install({
      urc_jobs: [
        job({
          status: "queued",
          claimed_at: null,
          expires_at: new Date(NOW.getTime() - 1).toISOString(),
        }),
      ],
    });
    await expect(deviceClaim(AUTH_A)).resolves.toEqual({ ok: true, value: { job: null } });
    expect(db.tables.urc_jobs[0].status).toBe("expired");
  });

  // Defense in depth: even if the RPC were to return a foreign row, the device
  // layer drops it rather than handing the PC someone else's job.
  test("a foreign row coming back from the rpc is discarded", async () => {
    const db = install();
    db.rpcImpl.claim_urc_job = () => ({
      data: [{ ...job({ user_id: OTHER, status: "claimed" }) }],
      error: null,
    });
    await expect(deviceClaim(AUTH_A)).resolves.toEqual({ ok: true, value: { job: null } });
  });
});

describe("started", () => {
  test("flips the job to running and stores the link", async () => {
    const db = install({ urc_jobs: [job()] });
    const result = await deviceStarted(AUTH_A, {
      job_id: JOB,
      session_url: "https://claude.ai/code/session_abc123",
      pid_hint: 4242,
    });
    expect(result).toEqual({ ok: true, value: { ok: true } });

    const row = db.tables.urc_jobs[0];
    expect(row.status).toBe("running");
    expect(row.started_at).toBe(NOW.toISOString());
    expect(row.session_url).toBe("https://claude.ai/code/session_abc123");
    expect(row.pid_hint).toBe(4242);
    expect(db.tables.urc_log[0]).toMatchObject({ event: "started", user_id: OWNER });
  });

  // The PC is the only authority on the permission mode, so the job records
  // what it reports — it is never set from the server side.
  test("records the permission mode the PC actually used", async () => {
    const db = install({ urc_jobs: [job()] });
    await deviceStarted(AUTH_A, {
      job_id: JOB,
      session_url: "https://claude.ai/code/session_abc123",
      bypass_permissions: true,
    });
    expect(db.tables.urc_jobs[0].bypass_permissions).toBe(true);
    expect(String(db.tables.urc_log[0].detail)).toContain("permissions bypassed on the PC");
  });

  test("a missing or non-boolean bypass report records false", async () => {
    const db = install({ urc_jobs: [job()] });
    await deviceStarted(AUTH_A, {
      job_id: JOB,
      session_url: "https://claude.ai/code/session_abc123",
      bypass_permissions: "yes",
    });
    expect(db.tables.urc_jobs[0].bypass_permissions).toBe(false);
  });

  // The agent retries this report when a response is lost.
  test("a repeat of the same start is accepted", async () => {
    const db = install({
      urc_jobs: [
        job({
          status: "running",
          started_at: NOW.toISOString(),
          session_url: "https://claude.ai/code/session_abc123",
        }),
      ],
    });
    await expect(
      deviceStarted(AUTH_A, {
        job_id: JOB,
        session_url: "https://claude.ai/code/session_abc123",
      }),
    ).resolves.toEqual({ ok: true, value: { ok: true } });
    expect(db.tables.urc_log).toHaveLength(0);
  });

  test("a DIFFERENT session url on a running job is refused", async () => {
    const db = install({
      urc_jobs: [
        job({
          status: "running",
          started_at: NOW.toISOString(),
          session_url: "https://claude.ai/code/session_abc123",
        }),
      ],
    });
    await expect(
      deviceStarted(AUTH_A, {
        job_id: JOB,
        session_url: "https://claude.ai/code/session_somethingelse",
      }),
    ).resolves.toEqual({ ok: false, error: "job is running" });
    expect(db.tables.urc_jobs[0].session_url).toBe("https://claude.ai/code/session_abc123");
  });

  test.each([
    "http://claude.ai/code/session_abc",
    "https://claude.ai/code/session_abc/../..",
    "https://evil.example/code/session_abc",
    "https://claude.ai/code/abc123",
    "https://claude.ai.evil.test/code/session_abc",
    "javascript:alert(1)",
    "",
  ])("refuses a session_url that is not a claude.ai code link (%s)", async (url) => {
    const db = install({ urc_jobs: [job()] });
    const result = await deviceStarted(AUTH_A, { job_id: JOB, session_url: url });
    expect(result.ok).toBe(false);
    expect(db.tables.urc_jobs[0].status).toBe("claimed");
    expect(db.tables.urc_jobs[0].session_url).toBeNull();
  });

  test("another user's job cannot be started", async () => {
    const db = install({ urc_jobs: [job({ user_id: OTHER })] });
    await expect(
      deviceStarted(AUTH_A, {
        job_id: JOB,
        session_url: "https://claude.ai/code/session_abc123",
      }),
    ).resolves.toEqual({ ok: false, error: "job not found" });
    expect(db.tables.urc_jobs[0].status).toBe("claimed");
  });

  test("another device's job cannot be started", async () => {
    install({ urc_jobs: [job({ device_id: DEVICE_B })] });
    await expect(
      deviceStarted(AUTH_A, {
        job_id: JOB,
        session_url: "https://claude.ai/code/session_abc123",
      }),
    ).resolves.toEqual({ ok: false, error: "job not found" });
  });

  test("only a claimed job can start", async () => {
    install({ urc_jobs: [job({ status: "queued" })] });
    await expect(
      deviceStarted(AUTH_A, {
        job_id: JOB,
        session_url: "https://claude.ai/code/session_abc123",
      }),
    ).resolves.toEqual({ ok: false, error: "job is queued" });
  });

  test("a non-uuid job_id is refused", async () => {
    install({ urc_jobs: [job()] });
    await expect(
      deviceStarted(AUTH_A, {
        job_id: "not-a-uuid",
        session_url: "https://claude.ai/code/session_abc123",
      }),
    ).resolves.toEqual({ ok: false, error: "job_id must be a uuid" });
  });
});

describe("failed / stopped", () => {
  test("failed records the message and closes the job", async () => {
    const db = install({ urc_jobs: [job()] });
    await expect(
      deviceFailed(AUTH_A, { job_id: JOB, error: "folder not trusted" }),
    ).resolves.toEqual({ ok: true, value: { ok: true } });
    expect(db.tables.urc_jobs[0].status).toBe("failed");
    expect(db.tables.urc_jobs[0].error).toBe("folder not trusted");
    expect(db.tables.urc_log[0]).toMatchObject({ event: "failed" });
  });

  test("failed cannot touch another user's job", async () => {
    const db = install({ urc_jobs: [job({ user_id: OTHER })] });
    await expect(deviceFailed(AUTH_A, { job_id: JOB, error: "x" })).resolves.toEqual({
      ok: false,
      error: "job not found",
    });
    expect(db.tables.urc_jobs[0].status).toBe("claimed");
  });

  test("stopped closes a stopping job and is idempotent", async () => {
    const db = install({
      urc_jobs: [job({ status: "stopping", started_at: NOW.toISOString() })],
    });
    await deviceStopped(AUTH_A, { job_id: JOB });
    expect(db.tables.urc_jobs[0].status).toBe("stopped");
    expect(db.tables.urc_jobs[0].stopped_at).toBe(NOW.toISOString());
    await expect(deviceStopped(AUTH_A, { job_id: JOB })).resolves.toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(db.tables.urc_log.filter((row) => row.event === "stopped")).toHaveLength(1);
  });

  // The agent reports `stopped` for any session whose process it finds gone,
  // which includes one it just reported `failed`.
  test("a late stopped report does not erase a recorded failure", async () => {
    const db = install({
      urc_jobs: [job({ status: "failed", error: "folder not trusted" })],
    });
    await expect(deviceStopped(AUTH_A, { job_id: JOB })).resolves.toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(db.tables.urc_jobs[0].status).toBe("failed");
    expect(db.tables.urc_jobs[0].error).toBe("folder not trusted");
    expect(db.tables.urc_log).toHaveLength(0);
  });

  test("a late stopped report does not revive an expired job", async () => {
    const db = install({ urc_jobs: [job({ status: "expired" })] });
    await deviceStopped(AUTH_A, { job_id: JOB });
    expect(db.tables.urc_jobs[0].status).toBe("expired");
  });

  test("stopped cannot touch another device's job", async () => {
    const db = install({ urc_jobs: [job({ device_id: DEVICE_B, status: "running" })] });
    await expect(deviceStopped(AUTH_A, { job_id: JOB })).resolves.toEqual({
      ok: false,
      error: "job not found",
    });
    expect(db.tables.urc_jobs[0].status).toBe("running");
  });
});

describe("handleDeviceOp", () => {
  test("an unknown op is refused", async () => {
    install();
    await expect(handleDeviceOp(AUTH_A, { op: "drop_tables" })).resolves.toEqual({
      ok: false,
      error: "unknown op",
    });
  });

  test("a missing op is refused", async () => {
    install();
    await expect(handleDeviceOp(AUTH_A, {})).resolves.toEqual({
      ok: false,
      error: "unknown op",
    });
  });
});
