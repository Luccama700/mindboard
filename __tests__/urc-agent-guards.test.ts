// The PC's own guards (worker/urc-guards.mjs) — layer 3 of URC. These are the
// checks that hold even if the server is wrong or hostile: the owner id, the
// folder key, the folder's existence and trust state, the kill switch, the
// local rate limit, and above all that the permission mode comes from urc.env
// and nothing else.
import { describe, expect, test } from "vitest";

import {
  bootstrapFile,
  bootstrapRunnerArgs,
  buildBootstrap,
  buildSpawnArgs,
  checkJob,
  classifySessions,
  configProblem,
  decideSpawn,
  envFlag,
  lockDecision,
  isFolderTrusted,
  isUuid,
  matchSession,
  parseEnvText,
  parseFolders,
  parseProcessTable,
  pidBelongsToSession,
  processQueryFor,
  psQuote,
  readConfig,
  recordSpawn,
  redact,
  sessionIsLive,
  sessionNameFor,
  sessionUrlFor,
  spawnAllowed,
  untrackedStopsToAck,
  URC_BOM,
  URC_ENV_PREFIXES,
  URC_ENV_SENTINELS,
  URC_MODEL,
  windowsTerminalArgs,
} from "../worker/urc-guards.mjs";

const OWNER = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "aabbccdd-1111-4222-8333-444455556666";
const FOLDER = "C:\\Users\\U\\Documents\\mindboard\\mindboard";

const CONFIG = {
  url: "https://mindboard.example",
  token: "urcd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ownerUserId: OWNER,
  enabled: true,
  bypass: false,
};

const FOLDERS = { mindboard: FOLDER };

function job(over: Record<string, unknown> = {}) {
  return { id: JOB_ID, user_id: OWNER, folder_key: "mindboard", ...over };
}

describe("urc.env parsing", () => {
  test("reads KEY=VALUE, skips comments and tolerates CRLF + quotes", () => {
    const env = parseEnvText(
      [
        "# a comment",
        "",
        "MINDBOARD_URL=https://mindboard.example/",
        'URC_DEVICE_TOKEN="urcd_tok"',
        "URC_OWNER_USER_ID = " + OWNER,
        "URC_ENABLED=true",
        "URC_BYPASS_PERMISSIONS=false",
        "not a line",
      ].join("\r\n"),
    );
    expect(readConfig(env)).toEqual({
      url: "https://mindboard.example",
      token: "urcd_tok",
      ownerUserId: OWNER,
      enabled: true,
      bypass: false,
    });
  });

  test("flags are opt-in: anything unexpected reads as off", () => {
    for (const yes of ["true", "TRUE", " yes ", "1", "on"]) expect(envFlag(yes)).toBe(true);
    for (const no of ["false", "0", "", "maybe", undefined, null, "treu"]) {
      expect(envFlag(no)).toBe(false);
    }
  });

  test("an incomplete config is reported instead of guessed", () => {
    expect(configProblem({ ...CONFIG, url: "" })).toMatch(/MINDBOARD_URL/);
    expect(configProblem({ ...CONFIG, token: "" })).toMatch(/URC_DEVICE_TOKEN/);
    expect(configProblem({ ...CONFIG, ownerUserId: "me" })).toMatch(/URC_OWNER_USER_ID/);
    expect(configProblem(CONFIG)).toBeNull();
  });
});

describe("urc.folders.json parsing", () => {
  test("keeps well-formed entries and reports the rest", () => {
    const { folders, problems } = parseFolders(
      JSON.stringify({
        mindboard: FOLDER,
        "bad key": "C:\\x",
        empty: "",
        vault: "C:\\Users\\U\\Documents\\2ndBrain",
      }),
    );
    expect(folders).toEqual({ mindboard: FOLDER, vault: "C:\\Users\\U\\Documents\\2ndBrain" });
    expect(problems).toHaveLength(2);
  });

  test("broken JSON yields no folders rather than throwing", () => {
    expect(parseFolders("{nope").folders).toEqual({});
    expect(parseFolders("[]").problems[0]).toMatch(/\{ key: path \}/);
  });
});

describe("session naming", () => {
  test("the name is urc- plus the first 8 hex of the job id", () => {
    expect(sessionNameFor(JOB_ID)).toBe("urc-aabbccdd");
    expect(sessionNameFor("AABBCCDD-1111-4222-8333-444455556666")).toBe("urc-aabbccdd");
  });

  test("the link is built from the bridge session id", () => {
    expect(sessionUrlFor("session_01ABC")).toBe("https://claude.ai/code/session_01ABC");
  });

  test("only a uuid is a job id", () => {
    expect(isUuid(JOB_ID)).toBe(true);
    for (const bad of ["", "urc-aabbccdd", "../../x", null, 7, `${JOB_ID} ;rm -rf`]) {
      expect(isUuid(bad)).toBe(false);
    }
  });
});

describe("permission mode comes from urc.env only", () => {
  test("bypass off means no permission flags at all", () => {
    const args = buildSpawnArgs({ sessionName: "urc-aabbccdd", bypass: false });
    expect(args).toEqual([
      "--remote-control",
      "urc-aabbccdd",
      "--name",
      "urc-aabbccdd",
      "--model",
      URC_MODEL,
    ]);
    expect(args.join(" ")).not.toMatch(/permission/i);
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  test("bypass on appends exactly the one flag", () => {
    expect(buildSpawnArgs({ sessionName: "urc-aabbccdd", bypass: true })).toEqual([
      "--remote-control",
      "urc-aabbccdd",
      "--name",
      "urc-aabbccdd",
      "--model",
      URC_MODEL,
      "--dangerously-skip-permissions",
    ]);
  });

  // The whole point of reporting bypass rather than accepting it: a job (or a
  // compromised server) cannot talk the PC into a bypass session.
  test("a job claiming bypass cannot turn it on", () => {
    const hostile = job({
      bypass_permissions: true,
      bypass: true,
      dangerously_skip_permissions: true,
      args: ["--dangerously-skip-permissions"],
      permission_mode: "bypassPermissions",
    });
    const plan = decideSpawn(hostile, CONFIG);
    expect(plan.bypass).toBe(false);
    expect(plan.args).not.toContain("--dangerously-skip-permissions");
    expect(plan.args).toEqual(buildSpawnArgs({ sessionName: "urc-aabbccdd", bypass: false }));
  });

  test("and a job claiming normal permissions cannot turn bypass off", () => {
    const plan = decideSpawn(job({ bypass_permissions: false }), { ...CONFIG, bypass: true });
    expect(plan.bypass).toBe(true);
    expect(plan.args).toContain("--dangerously-skip-permissions");
  });

  test("no starting prompt is ever passed", () => {
    const plan = decideSpawn(job({ prompt: "rm -rf /", starting_prompt: "do evil" }), CONFIG);
    expect(plan.args.join(" ")).not.toMatch(/rm -rf|do evil/);
    expect(plan.args).toHaveLength(6);
  });
});

describe("bootstrap script", () => {
  const plan = decideSpawn(job(), CONFIG);
  const script = buildBootstrap({
    folder: "C:\\Users\\U\\it's a folder",
    sessionName: plan.sessionName,
    args: plan.args,
  });

  test("single-quotes and escapes the path", () => {
    expect(psQuote("C:\\it's")).toBe("'C:\\it''s'");
    expect(script).toContain("Set-Location -LiteralPath 'C:\\Users\\U\\it''s a folder'");
  });

  test("scrubs the inherited session sentinels and auth routing", () => {
    expect(script).toContain("$sentinels = @('CLAUDECODE'");
    expect(script).toContain("$prefixes = @('ANTHROPIC_*')");
    expect(script).toContain('Remove-Item ("Env:" + $name)');
  });

  test("invokes the user-local claude.exe with the planned argv", () => {
    expect(script).toContain('& "$env:USERPROFILE\\.local\\bin\\claude.exe"');
    expect(script).toContain("'--remote-control' 'urc-aabbccdd'");
    expect(script).toContain(`'--model' '${URC_MODEL}'`);
  });

  test("is ASCII with CRLF line endings (PowerShell 5.1 reads BOM-less UTF-8 as ANSI)", () => {
    expect(script).toMatch(/\r\n/);
    expect(/^[\t\n\r\x20-\x7e]*$/.test(script)).toBe(true);
  });
});

describe("job guards", () => {
  test("a well-formed job for the right owner is accepted", () => {
    expect(
      checkJob({ job: job(), config: CONFIG, folders: FOLDERS }),
    ).toEqual({ ok: true, folder: FOLDER, sessionName: "urc-aabbccdd" });
  });

  test("a job for any other user is ignored", () => {
    const result = checkJob({
      job: job({ user_id: "22222222-2222-4222-8222-222222222222" }),
      config: CONFIG,
      folders: FOLDERS,
    });
    expect(result).toEqual({
      ok: false,
      error: "job does not belong to this PC's URC owner",
    });
  });

  test("a job with no user is ignored", () => {
    expect(
      checkJob({ job: job({ user_id: null }), config: CONFIG, folders: FOLDERS }).ok,
    ).toBe(false);
  });

  test("an unknown folder key is refused", () => {
    const result = checkJob({
      job: job({ folder_key: "secrets" }),
      config: CONFIG,
      folders: FOLDERS,
    });
    expect(result).toEqual({
      ok: false,
      error: 'this PC has no folder registered as "secrets"',
    });
  });

  test("a folder key that is really a path or an argument is refused", () => {
    for (const key of ["C:\\Users\\U", "../../secrets", "mindboard --dangerously-skip-permissions", ""]) {
      const result = checkJob({
        job: job({ folder_key: key }),
        config: CONFIG,
        folders: { ...FOLDERS, [key]: "C:\\anything" },
      });
      expect(result).toEqual({ ok: false, error: "folder key is not allowed" });
    }
  });

  test("a folder that no longer exists is refused", () => {
    const result = checkJob({
      job: job(),
      config: CONFIG,
      folders: FOLDERS,
      pathExists: () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no longer exists/);
  });

  test("an untrusted folder is refused up front", () => {
    const result = checkJob({
      job: job(),
      config: CONFIG,
      folders: FOLDERS,
      isTrusted: () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not trusted in Claude Code yet/);
  });

  test("the kill switch refuses everything", () => {
    const result = checkJob({
      job: job(),
      config: { ...CONFIG, enabled: false },
      folders: FOLDERS,
    });
    expect(result).toEqual({
      ok: false,
      error: "the URC agent is disabled on the PC (URC_ENABLED)",
    });
  });

  test("a non-uuid job id is refused", () => {
    expect(checkJob({ job: job({ id: "x" }), config: CONFIG, folders: FOLDERS })).toEqual({
      ok: false,
      error: "job id is not a uuid",
    });
    expect(checkJob({ job: null, config: CONFIG, folders: FOLDERS }).ok).toBe(false);
  });
});

describe("trust lookup in ~/.claude.json", () => {
  const claudeJson = JSON.stringify(
    {
      numStartups: 7,
      projects: {
        "C:/Users/U/Documents/other": { hasTrustDialogAccepted: false },
        "c:/Users/U/Documents/mindboard/mindboard": {
          hasTrustDialogAccepted: true,
          allowedTools: ["Bash(git status)"],
        },
      },
    },
    null,
    2,
  );

  test("matches a backslash path against a forward-slash, lower-drive key", () => {
    expect(isFolderTrusted(claudeJson, FOLDER)).toBe(true);
    expect(isFolderTrusted(claudeJson, `${FOLDER}\\`)).toBe(true);
  });

  test("an untrusted project is not trusted", () => {
    expect(isFolderTrusted(claudeJson, "C:\\Users\\U\\Documents\\other")).toBe(false);
  });

  test("an unknown project is not trusted", () => {
    expect(isFolderTrusted(claudeJson, "C:\\Users\\U\\Documents\\nowhere")).toBe(false);
  });

  // ~/.claude.json legitimately holds duplicate keys that differ only in
  // drive-letter case, which is why the file is scanned as text.
  test("a duplicate key that accepts trust wins", () => {
    const duplicated =
      '{ "projects": { "C:/tmp/p": { "hasTrustDialogAccepted": false },' +
      ' "c:/tmp/p": { "hasTrustDialogAccepted": true } } }';
    expect(isFolderTrusted(duplicated, "C:\\tmp\\p")).toBe(true);
  });

  test("a nested object does not confuse the block scan", () => {
    const nested =
      '{ "projects": { "c:/tmp/p": { "mcpServers": { "x": { "hasTrustDialogAccepted": true } },' +
      ' "hasTrustDialogAccepted": false } } }';
    expect(isFolderTrusted(nested, "C:\\tmp\\p")).toBe(false);
  });

  test("an unreadable or empty file is not trust", () => {
    expect(isFolderTrusted("", FOLDER)).toBe(false);
    expect(isFolderTrusted("not json at all", FOLDER)).toBe(false);
    expect(isFolderTrusted(claudeJson, "")).toBe(false);
  });
});

describe("local rate limits", () => {
  const now = Date.parse("2026-10-21T18:00:00.000Z");

  test("four live sessions block a fifth", () => {
    expect(spawnAllowed({ state: { spawns: [] }, nowMs: now, liveCount: 4 })).toEqual({
      ok: false,
      error: "4 local sessions are already live",
    });
    expect(spawnAllowed({ state: { spawns: [] }, nowMs: now, liveCount: 3 }).ok).toBe(true);
  });

  test("five spawns within the hour block the sixth", () => {
    const spawns = [1, 2, 3, 4, 5].map((i) => now - i * 60_000);
    expect(spawnAllowed({ state: { spawns }, nowMs: now, liveCount: 0 })).toEqual({
      ok: false,
      error: "local rate limit: 5 sessions in the last hour",
    });
  });

  test("spawns older than an hour fall out of the window", () => {
    const spawns = [1, 2, 3, 4, 5].map((i) => now - 60 * 60_000 - i * 1000);
    expect(spawnAllowed({ state: { spawns }, nowMs: now, liveCount: 0 }).ok).toBe(true);
  });

  test("recording a spawn prunes the window and keeps the rest of the state", () => {
    const state = { sessions: [{ jobId: JOB_ID }], spawns: [now - 2 * 60 * 60_000, now - 60_000] };
    const next = recordSpawn(state, now);
    expect(next.spawns).toEqual([now - 60_000, now]);
    expect(next.sessions).toEqual(state.sessions);
  });

  test("a missing or corrupt state file is treated as empty", () => {
    expect(spawnAllowed({ state: undefined, nowMs: now, liveCount: 0 }).ok).toBe(true);
    expect(spawnAllowed({ state: { spawns: "nope" }, nowMs: now, liveCount: 0 }).ok).toBe(true);
  });
});

describe("session registration matching", () => {
  const entry = {
    pid: 4242,
    name: "urc-aabbccdd",
    cwd: FOLDER,
    bridgeSessionId: "session_01ABC",
  };

  test("matches on name, folder, pid and bridge id", () => {
    expect(matchSession(entry, { sessionName: "urc-aabbccdd", folder: FOLDER })).toBe(true);
    expect(
      matchSession({ ...entry, cwd: "C:/Users/U/Documents/mindboard/mindboard" }, {
        sessionName: "urc-aabbccdd",
        folder: FOLDER,
      }),
    ).toBe(true);
  });

  test("rejects a different name, a different folder, or a session that never bridged", () => {
    expect(matchSession(entry, { sessionName: "urc-other", folder: FOLDER })).toBe(false);
    expect(matchSession({ ...entry, cwd: "C:\\somewhere\\else" }, {
      sessionName: "urc-aabbccdd",
      folder: FOLDER,
    })).toBe(false);
    expect(
      matchSession({ ...entry, bridgeSessionId: "" }, {
        sessionName: "urc-aabbccdd",
        folder: FOLDER,
      }),
    ).toBe(false);
    expect(
      matchSession({ ...entry, pid: 0 }, { sessionName: "urc-aabbccdd", folder: FOLDER }),
    ).toBe(false);
    expect(matchSession(null, { sessionName: "urc-aabbccdd", folder: FOLDER })).toBe(false);
  });
});

// urc-state.json outlives a reboot and Windows recycles pids, so a recorded
// pid is only ever killed while the live process still carries the session's
// name. This is the guard that keeps a wrong taskkill off this machine.
describe("pid verification before any kill", () => {
  const table = parseProcessTable(
    [
      '4242|"C:\\Users\\U\\.local\\bin\\claude.exe" --remote-control urc-aabbccdd --name urc-aabbccdd --model claude-opus-5-5',
      "4240|powershell.exe -NoExit -ExecutionPolicy Bypass -File C:\\Temp\\mindboard-urc\\urc-aabbccdd.ps1",
      "7777|C:\\Windows\\System32\\notepad.exe",
      "garbage line",
      "",
    ].join("\r\n"),
  );

  test("parses the pid|command-line dump", () => {
    expect(table.size).toBe(3);
    expect(table.get(4242)).toContain("--remote-control urc-aabbccdd");
  });

  test("the session's own claude and parent powershell are recognised", () => {
    const entry = { pid: 4242, parentPid: 4240, sessionName: "urc-aabbccdd" };
    expect(sessionIsLive(table, entry)).toBe(true);
    expect(pidBelongsToSession(table, entry.parentPid, entry.sessionName)).toBe(true);
  });

  test("a recycled pid running something else does NOT belong to the session", () => {
    expect(sessionIsLive(table, { pid: 7777, sessionName: "urc-aabbccdd" })).toBe(false);
    expect(pidBelongsToSession(table, 7777, "urc-aabbccdd")).toBe(false);
  });

  test("a pid that is simply gone does not belong either", () => {
    expect(sessionIsLive(table, { pid: 31337, sessionName: "urc-aabbccdd" })).toBe(false);
  });

  test("another URC session's process does not match this session", () => {
    expect(sessionIsLive(table, { pid: 4242, sessionName: "urc-99999999" })).toBe(false);
  });

  test("a missing pid, name or table is never a match", () => {
    expect(pidBelongsToSession(table, undefined, "urc-aabbccdd")).toBe(false);
    expect(pidBelongsToSession(table, 0, "urc-aabbccdd")).toBe(false);
    expect(pidBelongsToSession(table, 4242, "")).toBe(false);
    expect(pidBelongsToSession(null, 4242, "urc-aabbccdd")).toBe(false);
    expect(sessionIsLive(table, null)).toBe(false);
  });
});

// A failed process query must not look like "nothing is running": that would
// report every live session stopped, drop the pids the kill switch needs, and
// make URC_ENABLED=false silently kill nothing.
describe("an unreadable process table is unknown, not empty", () => {
  const sessions = [
    { jobId: "j1", sessionName: "urc-aabbccdd", pid: 4242, parentPid: 4240 },
    { jobId: "j2", sessionName: "urc-eeffaabb", pid: 5555, parentPid: 5550 },
  ];

  test("null means unknown — callers keep their state", () => {
    expect(classifySessions(null, sessions)).toBeNull();
    expect(classifySessions(undefined, sessions)).toBeNull();
    expect(classifySessions("", sessions)).toBeNull();
  });

  test("an empty table is a real answer: nothing of ours is running", () => {
    const split = classifySessions(new Map(), sessions);
    expect(split?.live).toEqual([]);
    expect(split?.gone).toHaveLength(2);
  });

  test("a session is kept while EITHER of its pids still carries its name", () => {
    const onlyParent = parseProcessTable(
      "4240|powershell.exe -ExecutionPolicy Bypass -File C:\\T\\urc-aabbccdd.ps1",
    );
    const split = classifySessions(onlyParent, sessions);
    expect(split?.live.map((s) => s.jobId)).toEqual(["j1"]);
    expect(split?.gone.map((s) => s.jobId)).toEqual(["j2"]);
  });

  test("a recycled pid does not keep a session alive", () => {
    const recycled = parseProcessTable("4242|C:\\Windows\\notepad.exe\n4240|C:\\Windows\\cmd.exe");
    const split = classifySessions(recycled, sessions);
    expect(split?.live).toEqual([]);
    expect(split?.gone).toHaveLength(2);
  });
});

describe("single-instance lock", () => {
  const alive = (pid: number) => pid === 1234;

  test("a live holder means do not start", () => {
    expect(lockDecision({ text: "1234\n", selfPid: 999, isAlive: alive })).toEqual({
      action: "exit",
      holder: 1234,
    });
  });

  test("a dead holder's lock is stale and takeable", () => {
    expect(lockDecision({ text: "4321", selfPid: 999, isAlive: alive })).toEqual({
      action: "take",
      stale: true,
      holder: 4321,
    });
  });

  test("a missing or malformed lock is takeable", () => {
    expect(lockDecision({ text: "", selfPid: 999, isAlive: alive }).action).toBe("take");
    expect(lockDecision({ text: "not a pid", selfPid: 999, isAlive: alive })).toEqual({
      action: "take",
      stale: true,
    });
  });

  test("our own pid is not a foreign holder", () => {
    expect(lockDecision({ text: "1234", selfPid: 1234, isAlive: alive })).toEqual({
      action: "take",
      stale: false,
    });
  });
});

describe("acking a stop for an untracked job", () => {
  const now = Date.parse("2026-10-21T18:00:00.000Z");
  const old = new Date(now - 61_000).toISOString();
  const fresh = new Date(now - 5_000).toISOString();

  test("a tracked job is handled by killing it, not by acking", () => {
    expect(
      untrackedStopsToAck({
        jobIds: ["j1"],
        trackedIds: ["j1"],
        requestedAt: { j1: old },
        nowMs: now,
      }),
    ).toEqual([]);
  });

  test("a fresh request is left for whoever owns it (a sibling mid-spawn)", () => {
    expect(
      untrackedStopsToAck({ jobIds: ["j2"], trackedIds: [], requestedAt: { j2: fresh }, nowMs: now }),
    ).toEqual([]);
  });

  test("an aged request is acked so the server leaves 'stopping'", () => {
    expect(
      untrackedStopsToAck({ jobIds: ["j2"], trackedIds: [], requestedAt: { j2: old }, nowMs: now }),
    ).toEqual(["j2"]);
  });

  test("a request with no timestamp is never acked", () => {
    expect(
      untrackedStopsToAck({ jobIds: ["j3"], trackedIds: [], requestedAt: {}, nowMs: now }),
    ).toEqual([]);
  });
});

describe("the bootstrap file as written to disk", () => {
  const plan = decideSpawn(job(), CONFIG);
  const accented = "C:\\Users\\U\\Documents\\São Paulo";
  const file = bootstrapFile({
    folder: accented,
    sessionName: plan.sessionName,
    args: plan.args,
  });

  test("starts with a UTF-8 BOM so PS 5.1 does not read it as ANSI", () => {
    expect(file.startsWith(URC_BOM)).toBe(true);
    expect([...Buffer.from(file, "utf8").subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  test("a non-ASCII folder path survives into Set-Location", () => {
    expect(file).toContain(`Set-Location -LiteralPath '${accented}'`);
    const roundTrip = Buffer.from(file, "utf8").toString("utf8");
    expect(roundTrip).toContain("São Paulo");
  });

  test("stops on error and exits 1 rather than running claude in the wrong folder", () => {
    expect(file).toContain('$ErrorActionPreference = "Stop"');
    expect(file).toMatch(/try \{[\s\S]*Set-Location[\s\S]*\} catch \{[\s\S]*exit 1[\s\S]*\}/);
    const claudeAt = file.indexOf("claude.exe");
    expect(file.indexOf("exit 1")).toBeLessThan(claudeAt);
  });

  test("the window closes when claude exits (no -NoExit)", () => {
    const args = windowsTerminalArgs("urc-aabbccdd", "C:\\T\\urc-aabbccdd.ps1");
    expect(args).toEqual([
      "--title",
      "urc-aabbccdd",
      "powershell.exe",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\T\\urc-aabbccdd.ps1",
    ]);
    expect(bootstrapRunnerArgs("x.ps1")).not.toContain("-NoExit");
  });
});

// Mirrors overnight/run.mjs's CHILD_ENV scrub, overnight/rc-spike.ps1's $scrub
// and the newrc skill's list. A broad /^CLAUDE/ match would also strip
// legitimate configuration.
describe("environment scrub list", () => {
  test("carries the session sentinels those three lists name", () => {
    for (const name of [
      "CLAUDECODE",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDE_CODE_BRIDGE_SESSION_ID",
      "CLAUDE_CODE_HOST_SESSION_ID",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_PID",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "DISABLE_TELEMETRY",
      "DO_NOT_TRACK",
      "DISABLE_GROWTHBOOK",
    ]) {
      expect(URC_ENV_SENTINELS).toContain(name);
    }
  });

  test("strips all ANTHROPIC_* by prefix (auth routing disables remote control)", () => {
    expect(URC_ENV_PREFIXES).toEqual(["ANTHROPIC_"]);
    const script = buildBootstrap({
      folder: "C:\\x",
      sessionName: "urc-aabbccdd",
      args: ["--name", "urc-aabbccdd"],
    });
    expect(script).toContain("'ANTHROPIC_*'");
    expect(script).toContain("$sentinels -contains $name");
  });

  test("leaves legitimate CLAUDE_CODE_* configuration alone", () => {
    for (const keep of [
      "CLAUDE_CODE_SUBAGENT_MODEL",
      "CLAUDE_CODE_GIT_BASH_PATH",
      "CLAUDE_CODE_EXECPATH",
    ]) {
      expect(URC_ENV_SENTINELS).not.toContain(keep);
    }
  });
});

describe("log redaction", () => {
  test("the device token never survives into a log line", () => {
    const line = `heartbeat failed with Bearer ${CONFIG.token} on https://x`;
    expect(redact(line, [CONFIG.token])).toBe(
      "heartbeat failed with Bearer [redacted] on https://x",
    );
  });

  test("short or missing secrets are left alone", () => {
    expect(redact("plain text", [])).toBe("plain text");
    expect(redact("abc", ["abc"])).toBe("abc");
  });
});


describe("chat-chosen session name on the PC", () => {
  test("a valid label gives <label>-<6 hex>", () => {
    expect(sessionNameFor(JOB_ID, "fix-tests")).toBe("fix-tests-aabbcc");
  });

  test("no label keeps the default", () => {
    expect(sessionNameFor(JOB_ID)).toBe("urc-aabbccdd");
    expect(sessionNameFor(JOB_ID, null)).toBe("urc-aabbccdd");
  });

  test("a label the PC doesn't accept falls back to the default and never reaches argv", () => {
    for (const bad of ["Fix", "a b", "x'; calc", "-lead", "trail-", "a".repeat(25), "Ã©", "$(whoami)", ""]) {
      expect(sessionNameFor(JOB_ID, bad)).toBe("urc-aabbccdd");
    }
  });

  test("decideSpawn uses the label for the name, and drops a hostile one", () => {
    const plan = decideSpawn({ id: JOB_ID, label: "fix-tests" }, { bypass: false });
    expect(plan.sessionName).toBe("fix-tests-aabbcc");
    expect(plan.args.slice(0, 4)).toEqual(["--remote-control", "fix-tests-aabbcc", "--name", "fix-tests-aabbcc"]);
    const hostile = decideSpawn({ id: JOB_ID, label: 'x"; calc' }, { bypass: false });
    expect(hostile.sessionName).toBe("urc-aabbccdd");
  });
});


describe("process query covers named sessions", () => {
  test("searches each tracked name, not a urc- prefix", () => {
    const q = processQueryFor([{ sessionName: "fix-tests-aabbcc" }, { sessionName: "urc-aabbccdd" }]);
    expect(q).toContain("-like '*fix-tests-aabbcc*'");
    expect(q).toContain("-like '*urc-aabbccdd*'");
  });

  test("a named session in the table is live (the orphan regression)", () => {
    const table = parseProcessTable(
      '4242|"C:\\Users\\U\\.local\\bin\\claude.exe" --remote-control fix-tests-aabbcc --name fix-tests-aabbcc --model claude-opus-5-5',
    );
    expect(sessionIsLive(table, { pid: 4242, sessionName: "fix-tests-aabbcc" })).toBe(true);
  });

  test("names that could break the -like pattern are never embedded", () => {
    expect(processQueryFor([{ sessionName: "x'*; calc" }])).toBeNull();
    expect(processQueryFor([])).toBeNull();
    const q = processQueryFor([{ sessionName: "ok-name-abc123" }, { sessionName: "bad'name" }]);
    expect(q).toContain("ok-name-abc123");
    expect(q).not.toContain("bad'name");
  });
});
