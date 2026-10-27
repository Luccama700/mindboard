#!/usr/bin/env node
// URC agent — the PC side of "start a Claude Code remote-control session from a
// claude.ai chat". Pull-based like worker/worker.py: it polls
// POST <MINDBOARD_URL>/api/urc/device with its own device token, so nothing in
// Mindboard can reach into this machine. Setup, kill switch and testing:
// worker/URC.md.
//
// Every loop it RE-READS worker/urc.env, so flipping URC_ENABLED=false (or
// URC_BYPASS_PERMISSIONS) takes effect within one poll without a restart.
// Pure logic lives in worker/urc-guards.mjs (unit-tested); this file is the I/O.
//
// Invariants:
//   * it acts only when URC_ENABLED=true and only on jobs whose user_id is
//     URC_OWNER_USER_ID;
//   * the permission mode comes from urc.env at spawn time — a job field named
//     bypass_permissions is ignored (it never reaches decideSpawn);
//   * it kills only PIDs it recorded itself, never a pid echoed by the server;
//   * the device token is never written to the log.

import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bootstrapFile,
  checkJob,
  classifySessions,
  configProblem,
  decideSpawn,
  isFolderTrusted,
  lockDecision,
  matchSession,
  parseEnvText,
  parseFolders,
  parseProcessTable,
  pidBelongsToSession,
  readConfig,
  recordSpawn,
  redact,
  sessionIsLive,
  sessionUrlFor,
  spawnAllowed,
  untrackedStopsToAck,
  processQueryFor,
  windowsTerminalArgs,
} from "./urc-guards.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(HERE, "urc.env");
const FOLDERS_PATH = join(HERE, "urc.folders.json");
const STATE_PATH = join(HERE, "urc-state.json");
const LOCK_PATH = join(HERE, "urc-agent.pid");
const LOG_DIR = join(HERE, "logs");
const LOG_PATH = join(LOG_DIR, "urc-agent.log");

const SESSIONS_DIR = join(homedir(), ".claude", "sessions");
const CLAUDE_JSON = join(homedir(), ".claude.json");
const CLAUDE_EXE = join(homedir(), ".local", "bin", "claude.exe");
const BOOTSTRAP_DIR = join(process.env.TEMP || tmpdir(), "mindboard-urc");

const POLL_MS = 5_000;
const REGISTER_TIMEOUT_MS = 60_000;
const REGISTER_POLL_MS = 1_500;
const HEARTBEAT_MIN_GAP_MS = 4_000;
const START_REPORT_ATTEMPTS = 5;

let secrets = [];
let lastHeartbeatAt = 0;

function log(message) {
  const line = `${new Date().toISOString()} ${redact(message, secrets)}`;
  console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_PATH, `${line}\n`, { flag: "a" });
  } catch {
    // a log failure must never stop the loop
  }
}

// Config/folder complaints repeat on every 5s poll, so they are logged only
// when the message actually changes — otherwise a missing urc.env would write
// 17k identical lines a day.
const notices = new Map();

function notice(key, message) {
  if (notices.get(key) === message) return;
  notices.set(key, message);
  if (message) log(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function loadConfig() {
  const config = readConfig(parseEnvText(readText(ENV_PATH)));
  secrets = config.token ? [config.token] : [];
  return config;
}

function loadFolders() {
  const text = readText(FOLDERS_PATH);
  if (!text.trim()) return { folders: {}, problems: ["worker/urc.folders.json is missing"] };
  return parseFolders(text);
}

function readState() {
  try {
    const parsed = JSON.parse(readText(STATE_PATH) || "{}");
    return {
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      spawns: Array.isArray(parsed.spawns) ? parsed.spawns : [],
    };
  } catch {
    return { sessions: [], spawns: [] };
  }
}

function writeState(state) {
  try {
    writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch (e) {
    log(`WARN could not write urc-state.json: ${e.message}`);
  }
}

// ---------------------------------------------------------------- server calls

async function api(config, op, body = {}) {
  const response = await fetch(`${config.url}/api/urc/device`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ op, ...body }),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    throw new Error(`${op} failed (${response.status}): ${parsed?.error ?? text.slice(0, 200)}`);
  }
  return parsed ?? {};
}

async function heartbeat(config, folders) {
  const keys = Object.keys(folders);
  const labels = {};
  for (const key of keys) labels[key] = folders[key];
  const result = await api(config, "heartbeat", {
    folder_keys: keys,
    folder_labels: labels,
    bypass_permissions: config.bypass === true,
  });
  lastHeartbeatAt = Date.now();
  return {
    ids: Array.isArray(result.stop_requested) ? result.stop_requested : [],
    requestedAt:
      result.stop_requested_at && typeof result.stop_requested_at === "object"
        ? result.stop_requested_at
        : {},
  };
}

// Used during the registration wait: keeps the device from reading as offline
// for a minute, and surfaces a stop requested while the window is coming up.
async function maybeHeartbeat(config, folders) {
  if (Date.now() - lastHeartbeatAt < HEARTBEAT_MIN_GAP_MS) return null;
  try {
    return await heartbeat(config, folders);
  } catch {
    // the spawn in flight matters more than one missed ping
    return null;
  }
}

async function report(config, op, body) {
  try {
    await api(config, op, body);
    return true;
  } catch (e) {
    log(`WARN could not report ${op}: ${e.message}`);
    return false;
  }
}

// ------------------------------------------------------------------- processes

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// Returns null when the query could not be run (timeout, missing shell, a
// non-zero exit). Null is NOT "" — an empty string is a valid answer meaning
// "no matching processes", and conflating the two would make a single failed
// query look like "every session has exited".
function powershell(script) {
  try {
    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", timeout: 20_000, windowsHide: true },
    );
  } catch (e) {
    log(`WARN powershell query failed: ${e.message}`);
    return null;
  }
}

function parentPidOf(pid) {
  const out = powershell(
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").ParentProcessId`,
  );
  const parsed = Number(String(out).trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 20_000,
    });
  } catch {
    // already gone, or not ours to kill
  }
}

// One dump of every process whose command line mentions a URC session, so the
// recorded pids can be verified instead of trusted. Skipped entirely when
// nothing is tracked, which is the normal case. Returns null if the query
// failed — callers must then leave their state alone and retry next tick.
function processTableFor(sessions) {
  if (!sessions || sessions.length === 0) return new Map();
  const query = processQueryFor(sessions);
  // Nothing safe to search for: report "unknown" rather than an empty table,
  // so callers keep their state instead of declaring every session dead.
  if (!query) return null;
  const out = powershell(query);
  return out === null ? null : parseProcessTable(out);
}

// Killing the recorded parent powershell takes the claude child with it (/T)
// and closes the window. Two refusals here are load-bearing: a pid is killed
// only while the live process still carries this session's name (pids get
// recycled and the state file outlives a reboot), and WindowsTerminal.exe is
// never touched at all — it hosts every tab on this machine.
function killSession(entry, table) {
  if (pidBelongsToSession(table, entry.parentPid, entry.sessionName)) {
    killPid(entry.parentPid);
  }
  if (sessionIsLive(table, entry)) killPid(entry.pid);
}

// Cleanup for a session that never registered, where there is no recorded pid
// yet. The marker is the bootstrap file this agent just generated, so it can
// only ever match a process this agent launched.
function killByBootstrapMarker(marker) {
  const safe = String(marker).replace(/[^A-Za-z0-9._-]/g, "");
  if (!safe) return;
  const out = powershell(
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${safe}*' -and ` +
      // This very query carries the marker in its own command line, so it would
      // otherwise appear in its own results and shoot itself.
      `$_.CommandLine -notlike '*Get-CimInstance*' -and ` +
      `$_.Name -ne 'WindowsTerminal.exe' -and $_.Name -ne 'wt.exe' -and $_.Name -ne 'OpenConsole.exe' } | ` +
      `Select-Object -ExpandProperty ProcessId`,
  );
  for (const line of String(out).split(/\r?\n/)) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) killPid(pid);
  }
}

// -------------------------------------------------------------------- spawning

function readSessionEntries() {
  let files = [];
  try {
    files = readdirSync(SESSIONS_DIR).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const entries = [];
  for (const name of files) {
    try {
      entries.push(JSON.parse(readFileSync(join(SESSIONS_DIR, name), "utf8")));
    } catch {
      // a half-written session file; the next poll will see it complete
    }
  }
  return entries;
}

const WT_MISSING = "Windows Terminal (wt.exe) not found on the PC";

// wt.exe exits immediately after handing the tab to WindowsTerminal.exe, so
// its pid is useless — the session's real pid comes from the sessions dir.
// A missing wt.exe surfaces as an ASYNCHRONOUS 'error' event, not a throw, and
// an unhandled one would take the whole agent down; hence the handler and the
// shared `status` the caller polls.
//
// There is deliberately no fallback to a detached powershell console: a window
// spawned that way is not the launch path URC was verified against, so the job
// fails loudly instead of half-working. No `-NoExit` either — the window must
// close when claude exits, or untracked windows pile up on the desktop.
function launchWindow(sessionName, bootstrapPath) {
  const status = { error: null };
  try {
    const child = spawn("wt.exe", windowsTerminalArgs(sessionName, bootstrapPath), {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (e) => {
      status.error = e.code === "ENOENT" ? WT_MISSING : `wt.exe could not start: ${e.message}`;
    });
    child.unref();
  } catch (e) {
    status.error = e.code === "ENOENT" ? WT_MISSING : `wt.exe could not start: ${e.message}`;
  }
  return status;
}

// Waits up to a minute for the new session to register with the bridge, and
// stays responsive while it does: urc.env is re-read every poll (so the kill
// switch still works during the wait) and the heartbeat's stop list is honored
// for this job. Returns { entry } on success, { abort } when the launch should
// be torn down, or {} on timeout.
async function waitForRegistration(config, folders, sessionName, folder, jobId, launch) {
  const deadline = Date.now() + REGISTER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(REGISTER_POLL_MS);

    if (launch.error) return { abort: launch.error };

    for (const entry of readSessionEntries()) {
      if (matchSession(entry, { sessionName, folder }) && processAlive(entry.pid)) {
        return { entry };
      }
    }

    if (!loadConfig().enabled) {
      return { abort: "URC_ENABLED was turned off while the session was starting" };
    }

    const stops = await maybeHeartbeat(config, folders);
    if (stops?.ids.includes(jobId)) {
      return { abort: "a stop was requested while the session was starting" };
    }
  }
  return {};
}

async function spawnSession(config, folders, job, folder, state) {
  // The job is handed to decideSpawn together with the local config, and the
  // permission flag is read off the config only.
  const plan = decideSpawn(job, config);

  if (!existsSync(CLAUDE_EXE)) {
    await report(config, "failed", {
      job_id: job.id,
      error: `claude.exe is not installed at ${CLAUDE_EXE} on the PC`,
    });
    return state;
  }

  const bootstrapName = `${plan.sessionName}.ps1`;
  const bootstrapPath = join(BOOTSTRAP_DIR, bootstrapName);
  try {
    mkdirSync(BOOTSTRAP_DIR, { recursive: true });
    writeFileSync(
      bootstrapPath,
      // UTF-8 WITH BOM (bootstrapFile adds it) + CRLF: PowerShell 5.1 reads a
      // BOM-less file as ANSI and would mangle a non-ASCII folder path.
      bootstrapFile({ folder, sessionName: plan.sessionName, args: plan.args }),
      "utf8",
    );
  } catch (e) {
    await report(config, "failed", {
      job_id: job.id,
      error: `could not write the launch script: ${e.message}`,
    });
    return state;
  }

  log(
    `spawning ${plan.sessionName} in ${folder} (bypass=${plan.bypass ? "yes" : "no"}): claude ${plan.args.join(" ")}`,
  );
  const launch = launchWindow(plan.sessionName, bootstrapPath);
  let next = recordSpawn(state, Date.now());
  writeState(next);

  const outcome = await waitForRegistration(
    config,
    folders,
    plan.sessionName,
    folder,
    job.id,
    launch,
  );
  if (!outcome.entry) {
    const why =
      outcome.abort ?? "the session did not register with the remote-control bridge within 60s";
    log(`FAIL ${plan.sessionName}: ${why}; cleaning up`);
    killByBootstrapMarker(bootstrapName);
    await report(config, "failed", { job_id: job.id, error: why });
    return next;
  }
  const entry = outcome.entry;

  const parentPid = parentPidOf(entry.pid);
  const sessionUrl = sessionUrlFor(entry.bridgeSessionId);
  next = {
    ...next,
    sessions: [
      ...next.sessions,
      {
        jobId: job.id,
        sessionName: plan.sessionName,
        folder,
        pid: entry.pid,
        parentPid,
        sessionUrl,
        bypass: plan.bypass,
        startedAt: new Date().toISOString(),
      },
    ],
  };
  log(`STARTED ${plan.sessionName} pid ${entry.pid} (parent ${parentPid ?? "?"}) ${sessionUrl}`);
  const reported = await report(config, "started", {
    job_id: job.id,
    session_url: sessionUrl,
    pid_hint: entry.pid,
    // What the session was ACTUALLY started with, recorded on the job so the
    // chat can say which mode it is driving.
    bypass_permissions: plan.bypass,
  });
  next = {
    ...next,
    sessions: next.sessions.map((session) =>
      session.jobId === job.id ? { ...session, startedReported: reported } : session,
    ),
  };
  writeState(next);
  return next;
}

// A `started` report lost to a network blip would otherwise leave the chat
// looking at a 'claimed' job forever while the session is live on screen, so
// it is retried until it lands (the endpoint only accepts it while the job is
// still 'claimed', so a late duplicate is refused rather than confusing).
async function retryStarts(config, state) {
  const pending = state.sessions.filter(
    (entry) =>
      entry.startedReported === false && (entry.startedAttempts ?? 1) < START_REPORT_ATTEMPTS,
  );
  if (pending.length === 0) return state;
  const outcome = new Map();
  for (const entry of pending) {
    const ok = await report(config, "started", {
      job_id: entry.jobId,
      session_url: entry.sessionUrl,
      pid_hint: entry.pid,
      bypass_permissions: entry.bypass === true,
    });
    outcome.set(entry.jobId, ok);
    if (!ok && (entry.startedAttempts ?? 1) + 1 >= START_REPORT_ATTEMPTS) {
      // Giving up on the report, not on the session: the window stays open and
      // a stop request still reaches it. Retrying every 5s forever would just
      // fill the log, and the server has almost certainly moved the job on
      // (stopped by hand, or stopping) if it has refused this many times.
      log(`WARN gave up reporting ${entry.sessionName} as started; it is still running here`);
    }
  }
  const next = {
    ...state,
    sessions: state.sessions.map((entry) =>
      outcome.has(entry.jobId)
        ? {
            ...entry,
            startedReported: outcome.get(entry.jobId) === true,
            startedAttempts: (entry.startedAttempts ?? 1) + 1,
          }
        : entry,
    ),
  };
  writeState(next);
  return next;
}

// ---------------------------------------------------------------- reconcilers

async function reconcileDead(config, state, table) {
  const split = classifySessions(table, state.sessions);
  if (!split) {
    // Unknown, not empty: keep every tracked session so the kill switch can
    // still reach it, and try again on the next poll.
    notice("verify", "WARN cannot read the process table; leaving tracked sessions alone");
    return state;
  }
  notice("verify", "");
  if (split.gone.length === 0) return state;
  for (const entry of split.gone) {
    // Either the process exited, or its pid now belongs to something else —
    // both mean "this session is over and its pid is not ours to kill".
    log(`session ${entry.sessionName} is gone; reporting stopped`);
    await report(config, "stopped", { job_id: entry.jobId, detail: "process exited" });
  }
  const next = { ...state, sessions: split.live };
  writeState(next);
  return next;
}

async function handleStops(config, state, stops, table) {
  const jobIds = stops.ids;
  if (jobIds.length === 0) return state;
  if (!(table instanceof Map)) {
    notice("stopverify", "WARN stop requested but the process table is unreadable; retrying");
    return state;
  }
  notice("stopverify", "");

  const targets = state.sessions.filter((entry) => jobIds.includes(entry.jobId));
  for (const entry of targets) {
    log(`stop requested for ${entry.sessionName}; killing pid ${entry.parentPid ?? entry.pid}`);
    killSession(entry, table);
  }

  // Confirm the kill before telling the server it stopped. A session that
  // survived stays tracked and gets another go next poll (the server keeps
  // returning it while the job is 'stopping'), rather than being forgotten
  // while its window is still open.
  const after = targets.length > 0 ? processTableFor(state.sessions) : table;
  const split = classifySessions(after, targets);
  const keep = [];
  for (const entry of state.sessions) {
    if (!jobIds.includes(entry.jobId)) {
      keep.push(entry);
      continue;
    }
    const stillLive = !split || split.live.includes(entry);
    if (stillLive) {
      log(`WARN ${entry.sessionName} is still alive after the kill; retrying next poll`);
      keep.push(entry);
      continue;
    }
    await report(config, "stopped", { job_id: entry.jobId, detail: "stopped on request" });
  }

  // A stop for a job this agent never tracked (an agent restarted since, or a
  // window closed by hand): acknowledged so the server doesn't sit in
  // 'stopping' forever — but only once the request is old enough that an agent
  // which DOES own it would have acted already.
  for (const jobId of untrackedStopsToAck({
    jobIds,
    trackedIds: state.sessions.map((entry) => entry.jobId),
    requestedAt: stops.requestedAt,
    nowMs: Date.now(),
  })) {
    await report(config, "stopped", { job_id: jobId, detail: "not tracked locally" });
  }

  const next = { ...state, sessions: keep };
  writeState(next);
  return next;
}

// The kill switch. It must never report "stopped" for something it could not
// verify as dead, and must never drop a pid it has not killed — otherwise
// URC_ENABLED=false would silently leave a live session behind with nothing
// tracking it. Unverifiable or surviving sessions stay in the state file and
// the sweep runs again on the next poll.
async function killEverything(config, state, reason) {
  if (state.sessions.length === 0) return state;

  const table = processTableFor(state.sessions);
  if (!(table instanceof Map)) {
    notice("killsweep", `WARN ${reason}: cannot verify processes; retrying next poll`);
    return state;
  }

  for (const entry of state.sessions) {
    log(`${reason}: killing ${entry.sessionName} (pid ${entry.parentPid ?? entry.pid})`);
    killSession(entry, table);
  }

  const split = classifySessions(processTableFor(state.sessions), state.sessions);
  if (!split) {
    notice("killsweep", `WARN ${reason}: could not confirm the kills; retrying next poll`);
    return state;
  }
  notice("killsweep", "");
  for (const entry of split.gone) {
    await report(config, "stopped", { job_id: entry.jobId, detail: reason });
  }
  for (const entry of split.live) {
    log(`WARN ${entry.sessionName} survived the kill; retrying next poll`);
  }
  const next = { ...state, sessions: split.live };
  writeState(next);
  return next;
}

// --------------------------------------------------------------------- the loop

async function tick(state) {
  const config = loadConfig();

  if (!config.enabled) {
    // The kill switch. Local sessions die, the server is told, and the agent
    // stops heartbeating — which also ages last_seen past the server's 20s
    // window, so spawn_urc refuses from the other side too.
    return killEverything(config, state, "URC_ENABLED=false");
  }

  const problem = configProblem(config);
  notice("config", problem ? `config: ${problem}` : "");
  if (problem) return state;

  const { folders, problems } = loadFolders();
  notice("folders", problems.length ? `folders: ${problems.join("; ")}` : "");

  const stops = await heartbeat(config, folders);
  const table = processTableFor(state.sessions);
  let next = await reconcileDead(config, state, table);
  next = await handleStops(config, next, stops, table);
  next = await retryStarts(config, next);

  const gate = spawnAllowed({
    state: next,
    nowMs: Date.now(),
    liveCount: next.sessions.length,
  });
  if (!gate.ok) return next;

  const claimed = await api(config, "claim");
  const job = claimed?.job ?? null;
  if (!job) return next;

  const claudeJson = readText(CLAUDE_JSON);
  const verdict = checkJob({
    job,
    config,
    folders,
    pathExists: (path) => existsSync(path),
    isTrusted: (path) => isFolderTrusted(claudeJson, path),
  });
  if (!verdict.ok) {
    log(`REFUSED job ${job.id}: ${verdict.error}`);
    await report(config, "failed", { job_id: job.id, error: verdict.error });
    return next;
  }

  return spawnSession(config, folders, job, verdict.folder, next);
}

// Exactly one agent per PC. Two would double every limit, race every claim,
// and — worst — neither one's kill switch would know the other's pids. A
// pidfile is enough here: the only way to hold it is to be a live process.
function takeLock() {
  const decision = lockDecision({
    text: readText(LOCK_PATH),
    selfPid: process.pid,
    isAlive: (pid) => processAlive(pid),
  });
  if (decision.action === "exit") {
    log(`another urc-agent is already running (pid ${decision.holder}); exiting`);
    return false;
  }
  if (decision.stale) {
    log(`clearing a stale lock${decision.holder ? ` from pid ${decision.holder}` : ""}`);
  }
  try {
    writeFileSync(LOCK_PATH, `${process.pid}\n`, "utf8");
  } catch (e) {
    log(`WARN could not write the lock file: ${e.message}`);
  }
  return true;
}

function releaseLock() {
  try {
    const held = Number(String(readText(LOCK_PATH)).trim());
    if (held === process.pid) unlinkSync(LOCK_PATH);
  } catch {
    // the next start clears it as stale
  }
}

async function main() {
  log(`urc-agent starting (poll ${POLL_MS}ms, env ${ENV_PATH})`);
  if (!takeLock()) process.exit(1);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    process.on(signal, () => {
      releaseLock();
      process.exit(0);
    });
  }
  process.on("exit", releaseLock);

  // Sessions recorded by a previous run are left in place deliberately: the
  // first tick's reconcileDead verifies each one against the live process table
  // and reports the dead ones stopped. Filtering them here on `processAlive`
  // alone would silently adopt a recycled pid.
  let state = readState();

  for (;;) {
    try {
      state = await tick(state);
    } catch (e) {
      log(`ERROR ${e.message}`);
    }
    await sleep(POLL_MS);
  }
}

main().catch((e) => {
  log(`FATAL ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
