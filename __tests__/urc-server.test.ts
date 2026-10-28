// URC server guards: who may use the tools, which credential may confirm one,
// how long a confirm stays valid, and what the confirm re-derives rather than
// trusting. The confirm path is driven through the real confirmAction rail, so
// the ExecutorContext plumbing (MCP clientId → EXECUTORS) is exercised too.
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createServiceClient: vi.fn() }));

vi.mock("@/utils/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));

import { confirmAction } from "@/app/lib/mcp/writes";
import {
  getUrcStatus,
  listUrcSessions,
  proposeSpawnUrc,
  stopUrc,
} from "@/app/lib/urc/jobs";
import { URC_NOT_AVAILABLE, URC_OFFLINE } from "@/app/lib/urc/preview";
import { makeDb, type FakeDb, type Row } from "./urc-fake-db";

const OWNER = "11111111-1111-4111-8111-111111111111";
const INTRUDER = "22222222-2222-4222-8222-222222222222";
const DEVICE = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-21T18:00:00.000Z");

const OAUTH = "mcp:client-abc";
const PAT = "mcp:pat";
const STATIC = "mcp:static";

function device(over: Partial<Row> = {}): Row {
  return {
    id: DEVICE,
    user_id: OWNER,
    name: "home-pc",
    token_hash: "deadbeef",
    folder_keys: ["mindboard", "vault"],
    folder_labels: { mindboard: "C:\\Users\\U\\Documents\\mindboard\\mindboard" },
    bypass_permissions: false,
    last_seen: new Date(NOW.getTime() - 3_000).toISOString(),
    created_at: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

function job(over: Partial<Row> = {}): Row {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    user_id: OWNER,
    device_id: DEVICE,
    folder_key: "mindboard",
    status: "queued",
    session_url: null,
    error: null,
    audit_id: null,
    confirmed_auth: "oauth:client-abc",
    created_at: new Date(NOW.getTime() - 10_000).toISOString(),
    expires_at: new Date(NOW.getTime() + 110_000).toISOString(),
    claimed_at: null,
    started_at: null,
    stop_requested_at: null,
    stopped_at: null,
    ...over,
  };
}

function proposal(over: Partial<Row> = {}): Row {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    user_id: OWNER,
    tool_name: "spawn_urc",
    input: { folder: "mindboard", deviceId: DEVICE },
    summary: "Start a Claude Code remote-control session on home-pc.",
    status: "proposed",
    result: null,
    created_at: new Date(NOW.getTime() - 30_000).toISOString(),
    resolved_at: null,
    ...over,
  };
}

function install(tables: Partial<Record<string, Row[]>> = {}): FakeDb {
  const db = makeDb({
    urc_devices: tables.urc_devices ?? [device()],
    urc_jobs: tables.urc_jobs ?? [],
    urc_log: tables.urc_log ?? [],
    ai_audit_log: tables.ai_audit_log ?? [],
  });
  mocks.createServiceClient.mockReturnValue(db);
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env.URC_OWNER_USER_ID = OWNER;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.URC_OWNER_USER_ID;
});

describe("ownership", () => {
  test("a non-owner is refused by all four tools", async () => {
    install();
    const refusals = await Promise.all([
      proposeSpawnUrc(INTRUDER, OAUTH, { folder: "mindboard" }),
      getUrcStatus(INTRUDER, OAUTH, { jobId: job().id }),
      listUrcSessions(INTRUDER, OAUTH),
      stopUrc(INTRUDER, OAUTH, { jobId: job().id }),
    ]);
    for (const result of refusals) {
      expect(result).toEqual({ ok: false, error: URC_NOT_AVAILABLE });
    }
  });

  test("with no URC owner configured even the owner is refused", async () => {
    delete process.env.URC_OWNER_USER_ID;
    install();
    await expect(proposeSpawnUrc(OWNER, OAUTH, { folder: "mindboard" })).resolves.toEqual({
      ok: false,
      error: URC_NOT_AVAILABLE,
    });
  });

  test("a personal access token is refused by all four tools", async () => {
    install({ urc_jobs: [job()] });
    const refusals = await Promise.all([
      proposeSpawnUrc(OWNER, PAT, { folder: "mindboard" }),
      getUrcStatus(OWNER, PAT, { jobId: job().id }),
      listUrcSessions(OWNER, PAT),
      stopUrc(OWNER, PAT, { jobId: job().id }),
    ]);
    for (const result of refusals) {
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/personal access token/);
    }
  });

  test("the static bearer is refused by all four tools", async () => {
    install({ urc_jobs: [job()] });
    const refusals = await Promise.all([
      proposeSpawnUrc(OWNER, STATIC, { folder: "mindboard" }),
      getUrcStatus(OWNER, STATIC, { jobId: job().id }),
      listUrcSessions(OWNER, STATIC),
      stopUrc(OWNER, STATIC, { jobId: job().id }),
    ]);
    for (const result of refusals) {
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/static MCP token/);
    }
  });

  test("a non-MCP credential is refused", async () => {
    install();
    const result = await proposeSpawnUrc(OWNER, "assistant", { folder: "mindboard" });
    expect(result).toEqual({
      ok: false,
      error: "URC sessions can only be started from the Mindboard MCP server",
    });
  });
});

describe("proposeSpawnUrc", () => {
  test("records a proposal whose preview carries the literal command", async () => {
    const db = install();
    const result = await proposeSpawnUrc(OWNER, OAUTH, { folder: "mindboard" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(db.tables.ai_audit_log).toHaveLength(1);
    const row = db.tables.ai_audit_log[0];
    expect(row.tool_name).toBe("spawn_urc");
    expect(row.status).toBe("proposed");
    expect(row.input).toEqual({ folder: "mindboard", deviceId: DEVICE, name: null });

    expect(result.value.preview).toContain("home-pc");
    expect(result.value.preview).toContain(
      "claude --remote-control urc-<id> --name urc-<id> --model claude-opus-5-5",
    );
    expect(result.value.preview).toContain("C:\\Users\\U\\Documents\\mindboard\\mindboard");
    expect(result.value.preview).toContain("No starting prompt (v1)");
    expect(result.value.preview).toContain(
      "Permissions: normal; the session asks before acting",
    );
    expect(result.value.preview).not.toContain("--dangerously-skip-permissions");
  });

  test("the preview shows bypass only when the PC reported it", async () => {
    install({ urc_devices: [device({ bypass_permissions: true })] });
    const result = await proposeSpawnUrc(OWNER, OAUTH, { folder: "mindboard" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.preview).toContain(
      "--model claude-opus-5-5 --dangerously-skip-permissions",
    );
    expect(result.value.preview).toContain("Permissions: BYPASS (set on the PC)");
  });

  test("an offline device fails immediately", async () => {
    const db = install({
      urc_devices: [device({ last_seen: new Date(NOW.getTime() - 25_000).toISOString() })],
    });
    await expect(proposeSpawnUrc(OWNER, OAUTH, { folder: "mindboard" })).resolves.toEqual({
      ok: false,
      error: URC_OFFLINE,
    });
    expect(db.tables.ai_audit_log).toHaveLength(0);
  });

  test("a device that never heartbeat is offline", async () => {
    install({ urc_devices: [device({ last_seen: null })] });
    await expect(proposeSpawnUrc(OWNER, OAUTH, { folder: "mindboard" })).resolves.toEqual({
      ok: false,
      error: URC_OFFLINE,
    });
  });

  test("a folder key the PC never reported is refused, with the real list", async () => {
    install();
    const result = await proposeSpawnUrc(OWNER, OAUTH, { folder: "secrets" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      "that folder isn't available on your PC — it offers: mindboard, vault",
    );
  });

  test("a folder key outside the allowed charset is refused before any lookup", async () => {
    install();
    const result = await proposeSpawnUrc(OWNER, OAUTH, { folder: "C:\\Users\\U" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/folder key the PC reported/);
  });

  test("another account's device is invisible", async () => {
    install({ urc_devices: [device({ user_id: INTRUDER })] });
    const result = await proposeSpawnUrc(OWNER, OAUTH, { folder: "mindboard" });
    expect(result).toEqual({
      ok: false,
      error: "no PC is registered for URC on this account",
    });
  });

  test("four live sessions block a fifth", async () => {
    install({
      urc_jobs: [
        job({ id: "a", status: "running", started_at: NOW.toISOString() }),
        job({ id: "b", status: "stopping" }),
        job({ id: "c", status: "claimed", claimed_at: NOW.toISOString() }),
        job({ id: "d", status: "running", started_at: NOW.toISOString() }),
      ],
    });
    const result = await proposeSpawnUrc(OWNER, OAUTH, { folder: "mindboard" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/4 sessions are already live/);
  });

  test("three live sessions still allow a fourth", async () => {
    install({
      urc_jobs: [
        job({ id: "a", status: "running", started_at: NOW.toISOString() }),
        job({ id: "b", status: "running", started_at: NOW.toISOString() }),
        job({ id: "c", status: "running", started_at: NOW.toISOString() }),
      ],
    });
    await expect(
      proposeSpawnUrc(OWNER, OAUTH, { folder: "mindboard" }),
    ).resolves.toMatchObject({ ok: true });
  });

  test("finished sessions do not count against the live limit", async () => {
    install({
      urc_jobs: [
        job({ id: "a", status: "stopped" }),
        job({ id: "b", status: "failed" }),
        job({ id: "c", status: "expired" }),
      ],
    });
    await expect(
      proposeSpawnUrc(OWNER, OAUTH, { folder: "mindboard" }),
    ).resolves.toMatchObject({ ok: true });
  });

  // A queued job is a session about to open, so it holds a slot.
  test("queued sessions count against the live-session limit", async () => {
    install({
      urc_jobs: ["q1", "q2", "q3", "q4"].map((id) => job({ id, status: "queued" })),
    });
    const result = await proposeSpawnUrc(OWNER, OAUTH, { folder: "mindboard" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/4 sessions are already live/);
  });

  // Only the PC can move a claimed job on, so a crash mid-spawn would hold a
  // slot forever without this sweep.
  test("a claimed job the PC never started is swept to failed and frees its slot", async () => {
    const db = install({
      urc_jobs: [
        job({
          id: "33333333-3333-4333-8333-333333333331",
          status: "claimed",
          claimed_at: new Date(NOW.getTime() - 3 * 60_000).toISOString(),
          started_at: null,
        }),
        job({ id: "33333333-3333-4333-8333-333333333332", status: "running" }),
      ],
    });
    await expect(
      proposeSpawnUrc(OWNER, OAUTH, { folder: "mindboard" }),
    ).resolves.toMatchObject({ ok: true });

    const swept = db.tables.urc_jobs.find(
      (row) => row.id === "33333333-3333-4333-8333-333333333331",
    );
    expect(swept?.status).toBe("failed");
    expect(swept?.error).toBe("the PC claimed the job but never started it");
    expect(db.tables.urc_log.map((row) => row.event)).toContain("failed");
  });

  test("a freshly claimed job is left alone by the sweep", async () => {
    const db = install({
      urc_jobs: [
        job({ status: "claimed", claimed_at: new Date(NOW.getTime() - 20_000).toISOString() }),
      ],
    });
    await proposeSpawnUrc(OWNER, OAUTH, { folder: "mindboard" });
    expect(db.tables.urc_jobs[0].status).toBe("claimed");
  });

  test("five spawns in the last hour block the sixth", async () => {
    const recent = Array.from({ length: 5 }, (_, i) =>
      job({
        id: `old-${i}`,
        status: "stopped",
        created_at: new Date(NOW.getTime() - (i + 1) * 60_000).toISOString(),
      }),
    );
    install({ urc_jobs: recent });
    const result = await proposeSpawnUrc(OWNER, OAUTH, { folder: "mindboard" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/rate limited to 5 sessions an hour/);
  });

  test("spawns older than an hour do not count", async () => {
    const old = Array.from({ length: 5 }, (_, i) =>
      job({
        id: `ancient-${i}`,
        status: "stopped",
        created_at: new Date(NOW.getTime() - 61 * 60_000 - i * 1000).toISOString(),
      }),
    );
    install({ urc_jobs: old });
    await expect(
      proposeSpawnUrc(OWNER, OAUTH, { folder: "mindboard" }),
    ).resolves.toMatchObject({ ok: true });
  });

  test("another account's jobs do not count against the owner's limits", async () => {
    install({
      urc_jobs: [
        job({ id: "x", user_id: INTRUDER, status: "running" }),
        job({ id: "y", user_id: INTRUDER, status: "running" }),
      ],
    });
    await expect(
      proposeSpawnUrc(OWNER, OAUTH, { folder: "mindboard" }),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe("confirm (through confirmAction → EXECUTORS.spawn_urc)", () => {
  test("an OAuth confirm queues the job and logs the credential", async () => {
    const db = install({ ai_audit_log: [proposal()] });
    const result = await confirmAction(OWNER, proposal().id, OAUTH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(db.tables.urc_jobs).toHaveLength(1);
    const queued = db.tables.urc_jobs[0];
    expect(queued.status).toBe("queued");
    expect(queued.user_id).toBe(OWNER);
    expect(queued.device_id).toBe(DEVICE);
    expect(queued.folder_key).toBe("mindboard");
    expect(queued.confirmed_auth).toBe("oauth:client-abc");
    expect(queued.audit_id).toBe(proposal().id);
    // two minutes, from the app clock
    expect(queued.expires_at).toBe(new Date(NOW.getTime() + 120_000).toISOString());

    expect(db.tables.ai_audit_log[0].status).toBe("executed");
    expect(db.tables.urc_log).toHaveLength(1);
    expect(db.tables.urc_log[0]).toMatchObject({
      user_id: OWNER,
      event: "spawn_confirmed",
      folder_key: "mindboard",
      confirmed_auth: "oauth:client-abc",
    });
    expect(result.value.result.sessionName).toMatch(/^urc-[0-9a-f]{8}$/);
  });

  test("an OAuth confirm records oauth:<client>", async () => {
    const db = install({ ai_audit_log: [proposal()] });
    await confirmAction(OWNER, proposal().id, OAUTH);
    expect(db.tables.urc_jobs[0].confirmed_auth).toBe("oauth:client-abc");
  });

  test("the static bearer cannot confirm a spawn", async () => {
    const db = install({ ai_audit_log: [proposal()] });
    const result = await confirmAction(OWNER, proposal().id, STATIC);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/static MCP token/);
    expect(db.tables.urc_jobs).toHaveLength(0);
    // the proposal is burned either way: the claim happened before the executor
    expect(db.tables.ai_audit_log[0].status).toBe("error");
  });

  test("a personal access token cannot confirm a spawn", async () => {
    const db = install({ ai_audit_log: [proposal()] });
    const result = await confirmAction(OWNER, proposal().id, PAT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/personal access token/);
    expect(db.tables.urc_jobs).toHaveLength(0);
  });

  test("the in-app assistant and the watch cannot confirm a spawn", async () => {
    for (const kind of ["assistant", "watch"]) {
      const db = install({ ai_audit_log: [proposal()] });
      const result = await confirmAction(OWNER, proposal().id, kind);
      expect(result.ok).toBe(false);
      expect(db.tables.urc_jobs).toHaveLength(0);
    }
  });

  test("a proposal older than five minutes is refused", async () => {
    const db = install({
      ai_audit_log: [
        proposal({ created_at: new Date(NOW.getTime() - 5 * 60_000 - 1000).toISOString() }),
      ],
    });
    const result = await confirmAction(OWNER, proposal().id, OAUTH);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/more than 5 minutes old/);
    expect(db.tables.urc_jobs).toHaveLength(0);
  });

  test("a proposal just inside five minutes still runs", async () => {
    const db = install({
      ai_audit_log: [
        proposal({ created_at: new Date(NOW.getTime() - 4 * 60_000).toISOString() }),
      ],
    });
    await expect(confirmAction(OWNER, proposal().id, OAUTH)).resolves.toMatchObject({
      ok: true,
    });
    expect(db.tables.urc_jobs).toHaveLength(1);
  });

  test("another user's proposal cannot be confirmed", async () => {
    const db = install({ ai_audit_log: [proposal({ user_id: INTRUDER })] });
    await expect(confirmAction(OWNER, proposal().id, OAUTH)).resolves.toEqual({
      ok: false,
      error: "proposal not found or already resolved",
    });
    expect(db.tables.urc_jobs).toHaveLength(0);
    expect(db.tables.ai_audit_log[0].status).toBe("proposed");
  });

  test("a non-owner cannot confirm even their own spawn_urc proposal", async () => {
    const db = install({ ai_audit_log: [proposal({ user_id: INTRUDER })] });
    const result = await confirmAction(INTRUDER, proposal().id, OAUTH);
    expect(result).toEqual({ ok: false, error: URC_NOT_AVAILABLE });
    expect(db.tables.urc_jobs).toHaveLength(0);
  });

  test("a single-use proposal cannot be confirmed twice", async () => {
    const db = install({ ai_audit_log: [proposal()] });
    await confirmAction(OWNER, proposal().id, OAUTH);
    await expect(confirmAction(OWNER, proposal().id, OAUTH)).resolves.toEqual({
      ok: false,
      error: "proposal not found or already resolved",
    });
    expect(db.tables.urc_jobs).toHaveLength(1);
  });

  // The stored input is forgeable (ai_audit_log RLS lets a user insert their
  // own 'proposed' row), so the executor must re-derive the device and the
  // folder instead of believing the row.
  test("a forged proposal naming an unavailable folder is refused at confirm", async () => {
    const db = install({
      ai_audit_log: [
        proposal({ input: { folder: "secrets", deviceId: DEVICE } }),
      ],
    });
    const result = await confirmAction(OWNER, proposal().id, OAUTH);
    expect(result.ok).toBe(false);
    expect(db.tables.urc_jobs).toHaveLength(0);
  });

  test("a forged device id is ignored — the device comes from server state", async () => {
    const db = install({
      ai_audit_log: [
        proposal({ input: { folder: "mindboard", deviceId: "99999999-9999-4999-8999-999999999999" } }),
      ],
    });
    await confirmAction(OWNER, proposal().id, OAUTH);
    expect(db.tables.urc_jobs[0].device_id).toBe(DEVICE);
  });

  // created_at comes from Postgres, so a timestamp in the future is a forged
  // row — and would otherwise stretch the 5-minute window arbitrarily.
  test("a proposal dated in the future is refused", async () => {
    const db = install({
      ai_audit_log: [
        proposal({ created_at: new Date(NOW.getTime() + 2 * 60_000).toISOString() }),
      ],
    });
    const result = await confirmAction(OWNER, proposal().id, OAUTH);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/dated in the future/);
    expect(db.tables.urc_jobs).toHaveLength(0);
  });

  test("a trivial clock skew is tolerated", async () => {
    const db = install({
      ai_audit_log: [proposal({ created_at: new Date(NOW.getTime() + 5_000).toISOString() })],
    });
    await expect(confirmAction(OWNER, proposal().id, OAUTH)).resolves.toMatchObject({ ok: true });
    expect(db.tables.urc_jobs).toHaveLength(1);
  });

  // urc_jobs_audit_unique is the database's own backstop for a double confirm.
  test("a unique-violation on audit_id reads as already confirmed", async () => {
    const db = install({ ai_audit_log: [proposal()] });
    db.insertError = {
      table: "urc_jobs",
      error: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "urc_jobs_audit_unique"',
      },
    };
    const result = await confirmAction(OWNER, proposal().id, OAUTH);
    expect(result).toEqual({
      ok: false,
      error: "this session request has already been confirmed",
    });
    expect(db.tables.urc_jobs).toHaveLength(0);
  });

  test("a confirm after the PC went offline is refused", async () => {
    const db = install({
      urc_devices: [device({ last_seen: new Date(NOW.getTime() - 60_000).toISOString() })],
      ai_audit_log: [proposal()],
    });
    const result = await confirmAction(OWNER, proposal().id, OAUTH);
    expect(result).toEqual({ ok: false, error: URC_OFFLINE });
    expect(db.tables.urc_jobs).toHaveLength(0);
  });

  test("limits are re-checked at confirm, not only at propose", async () => {
    const db = install({
      urc_jobs: [
        job({ id: "a", status: "running" }),
        job({ id: "b", status: "running" }),
        job({ id: "c", status: "running" }),
        job({ id: "d", status: "claimed" }),
      ],
      ai_audit_log: [proposal()],
    });
    const result = await confirmAction(OWNER, proposal().id, OAUTH);
    expect(result.ok).toBe(false);
    expect(db.tables.urc_jobs).toHaveLength(4);
  });
});

describe("getUrcStatus", () => {
  test("returns the session link only while it is running", async () => {
    install({
      urc_jobs: [
        job({
          status: "running",
          started_at: NOW.toISOString(),
          session_url: "https://claude.ai/code/session_abc123",
        }),
      ],
    });
    const result = await getUrcStatus(OWNER, OAUTH, { jobId: job().id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("running");
    expect(result.value.sessionUrl).toBe("https://claude.ai/code/session_abc123");
    expect(result.value.folder).toBe("mindboard");
  });

  test("another OAuth client of the same account gets the status, not the link", async () => {
    install({
      urc_jobs: [
        job({
          status: "running",
          started_at: NOW.toISOString(),
          session_url: "https://claude.ai/code/session_abc123",
        }),
      ],
    });
    const result = await getUrcStatus(OWNER, "mcp:some-other-client", { jobId: job().id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("running");
    expect(result.value.sessionUrl).toBeNull();
  });

  test("a stopped session's link is withheld", async () => {
    install({
      urc_jobs: [
        job({
          status: "stopped",
          started_at: NOW.toISOString(),
          stopped_at: NOW.toISOString(),
          session_url: "https://claude.ai/code/session_abc123",
        }),
      ],
    });
    const result = await getUrcStatus(OWNER, OAUTH, { jobId: job().id });
    expect(result.ok && result.value.sessionUrl).toBeNull();
  });

  test("a queued job past its expiry is marked expired lazily", async () => {
    const db = install({
      urc_jobs: [
        job({ expires_at: new Date(NOW.getTime() - 1_000).toISOString() }),
      ],
    });
    const result = await getUrcStatus(OWNER, OAUTH, { jobId: job().id });
    expect(result.ok && result.value.status).toBe("expired");
    expect(db.tables.urc_jobs[0].status).toBe("expired");
    expect(db.tables.urc_log.map((row) => row.event)).toContain("expired");
  });

  test("another user's job is not found", async () => {
    install({ urc_jobs: [job({ user_id: INTRUDER })] });
    await expect(getUrcStatus(OWNER, OAUTH, { jobId: job().id })).resolves.toEqual({
      ok: false,
      error: "session not found",
    });
  });

  test("a non-uuid jobId is refused", async () => {
    install();
    await expect(getUrcStatus(OWNER, OAUTH, { jobId: "../../etc" })).resolves.toEqual({
      ok: false,
      error: "jobId must be a uuid",
    });
  });
});

describe("listUrcSessions", () => {
  test("lists the owner's recent jobs with device state and no links", async () => {
    install({
      urc_jobs: [
        job({
          id: "66666666-6666-4666-8666-666666666666",
          status: "running",
          session_url: "https://claude.ai/code/session_abc123",
        }),
        job({
          id: "77777777-7777-4777-8777-777777777777",
          status: "stopped",
          created_at: new Date(NOW.getTime() - 25 * 60 * 60_000).toISOString(),
        }),
        job({ id: "88888888-8888-4888-8888-888888888888", user_id: INTRUDER }),
      ],
    });
    const result = await listUrcSessions(OWNER, OAUTH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sessions = result.value.sessions as Row[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0].jobId).toBe("66666666-6666-4666-8666-666666666666");
    expect(JSON.stringify(result.value)).not.toContain("session_abc123");

    const devices = result.value.devices as Row[];
    expect(devices).toEqual([
      {
        name: "home-pc",
        online: true,
        lastSeen: device().last_seen,
        folders: ["mindboard", "vault"],
        bypassPermissions: false,
      },
    ]);
  });
});

describe("stopUrc", () => {
  test("a running session goes to stopping and is logged", async () => {
    const db = install({
      urc_jobs: [job({ status: "running", started_at: NOW.toISOString() })],
    });
    const result = await stopUrc(OWNER, OAUTH, { jobId: job().id });
    expect(result.ok && result.value.status).toBe("stopping");
    expect(db.tables.urc_jobs[0].status).toBe("stopping");
    expect(db.tables.urc_jobs[0].stop_requested_at).toBe(NOW.toISOString());
    expect(db.tables.urc_log.map((row) => row.event)).toEqual(["stop_requested"]);
  });

  // started_at is still null while the PC is mid-spawn, so a 'claimed' job must
  // NOT be closed behind the agent's back: it goes to 'stopping' so the
  // heartbeat hands it over and the window actually gets killed.
  test("a claimed session goes to stopping, not stopped", async () => {
    const db = install({
      urc_jobs: [job({ status: "claimed", claimed_at: NOW.toISOString(), started_at: null })],
    });
    const result = await stopUrc(OWNER, OAUTH, { jobId: job().id });
    expect(result.ok && result.value.status).toBe("stopping");
    expect(db.tables.urc_jobs[0].status).toBe("stopping");
    expect(db.tables.urc_jobs[0].stopped_at).toBeNull();
    expect(db.tables.urc_jobs[0].stop_requested_at).toBe(NOW.toISOString());
  });

  test("a session that never started is stopped outright", async () => {
    const db = install({ urc_jobs: [job({ status: "queued" })] });
    const result = await stopUrc(OWNER, OAUTH, { jobId: job().id });
    expect(result.ok && result.value.status).toBe("stopped");
    expect(db.tables.urc_jobs[0].status).toBe("stopped");
    expect(db.tables.urc_jobs[0].stopped_at).toBe(NOW.toISOString());
    expect(db.tables.urc_log.map((row) => row.event)).toEqual([
      "stop_requested",
      "stopped",
    ]);
  });

  test("stopping an already finished session is a no-op", async () => {
    const db = install({ urc_jobs: [job({ status: "failed", error: "boom" })] });
    await expect(stopUrc(OWNER, OAUTH, { jobId: job().id })).resolves.toEqual({
      ok: true,
      value: { jobId: job().id, status: "failed", alreadyFinished: true },
    });
    expect(db.tables.urc_log).toHaveLength(0);
  });

  test("another user's session cannot be stopped", async () => {
    const db = install({ urc_jobs: [job({ user_id: INTRUDER, status: "running" })] });
    await expect(stopUrc(OWNER, OAUTH, { jobId: job().id })).resolves.toEqual({
      ok: false,
      error: "session not found",
    });
    expect(db.tables.urc_jobs[0].status).toBe("running");
  });
});


describe("chat-chosen session name", () => {
  test("propose normalizes the name and shows it in the preview", async () => {
    const db = install();
    const result = await proposeSpawnUrc(OWNER, OAUTH, { folder: "mindboard", name: "  Fix the Tests!! " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(db.tables.ai_audit_log[0].input).toEqual({
      folder: "mindboard",
      deviceId: DEVICE,
      name: "fix-the-tests",
    });
    expect(result.value.preview).toContain("Session name: fix-the-tests-<id>");
    expect(result.value.preview).toContain(
      "claude --remote-control fix-the-tests-<id> --name fix-the-tests-<id>",
    );
  });

  test("a name with nothing usable in it is refused", async () => {
    install();
    const result = await proposeSpawnUrc(OWNER, OAUTH, { folder: "mindboard", name: "!!! ;;; '" });
    expect(result.ok).toBe(false);
  });

  test("shell metacharacters never survive into the name", async () => {
    const db = install();
    const result = await proposeSpawnUrc(OWNER, OAUTH, {
      folder: "mindboard",
      name: "x'; del /s /q; $(calc) `whoami` & echo",
    });
    expect(result.ok).toBe(true);
    const name = (db.tables.ai_audit_log[0].input as { name: string }).name;
    expect(name).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/);
  });

  test("confirm stores the label and returns <name>-<6 hex>", async () => {
    const db = install({
      ai_audit_log: [proposal({ input: { folder: "mindboard", deviceId: DEVICE, name: "fix-tests" } })],
    });
    const result = await confirmAction(OWNER, proposal().id, OAUTH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const queued = db.tables.urc_jobs[0];
    expect(queued.label).toBe("fix-tests");
    const hex = String(queued.id).replace(/-/g, "").slice(0, 6);
    expect(JSON.stringify(result)).toContain(`"sessionName":"fix-tests-${hex}"`);
  });

  test("a forged proposal with a hostile name is re-normalized at confirm", async () => {
    const db = install({
      ai_audit_log: [proposal({ input: { folder: "mindboard", deviceId: DEVICE, name: "a'b; rm -rf" } })],
    });
    const result = await confirmAction(OWNER, proposal().id, OAUTH);
    expect(result.ok).toBe(true);
    expect(db.tables.urc_jobs[0].label).toBe("a-b-rm-rf");
  });

  test("status and list report the named session", async () => {
    install({ urc_jobs: [job({ label: "fix-tests" })] });
    const status = await getUrcStatus(OWNER, OAUTH, { jobId: job().id });
    expect(status.ok && status.value.sessionName).toBe("fix-tests-444444");
    const list = await listUrcSessions(OWNER, OAUTH);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const sessions = list.value.sessions as { sessionName: string }[];
    expect(sessions[0].sessionName).toBe("fix-tests-444444");
  });
});
