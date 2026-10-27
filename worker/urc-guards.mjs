// Pure logic for the URC agent (worker/urc-agent.mjs): config parsing, the
// job guards, the spawn plan, the bootstrap script, local rate limits, trust
// lookup. No I/O, no clock of its own — the agent passes `now` in — so every
// guard is unit-tested in __tests__/urc-agent-guards.test.ts.
//
// Layer 3 of URC's three gates (see supabase/migrations/0054_urc.sql): the PC
// decides. The server can only ever hand over a folder KEY, and nothing in a
// job payload can change what gets run: the permission mode comes from
// worker/urc.env at spawn time and from nowhere else.

export const URC_MODEL = "claude-opus-5-5";
export const URC_SESSION_PREFIX = "urc-";
export const URC_CLAUDE_EXE = "$env:USERPROFILE\\.local\\bin\\claude.exe";

export const URC_MAX_LIVE_SESSIONS = 4;
export const URC_MAX_SPAWNS_PER_HOUR = 5;
export const URC_SPAWNS_WINDOW_MS = 60 * 60_000;

// Same charset the server enforces (app/lib/urc/jobs.ts).
export const FOLDER_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

// KEY=VALUE lines, # comments, optional surrounding quotes, CRLF tolerant.
export function parseEnvText(text) {
  const env = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

// Opt-in only: anything that is not an explicit yes reads as off. A typo in
// urc.env therefore disables URC rather than enabling bypass.
export function envFlag(value) {
  return ["true", "1", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

export function readConfig(env) {
  return {
    url: String(env.MINDBOARD_URL ?? "").trim().replace(/\/+$/, ""),
    token: String(env.URC_DEVICE_TOKEN ?? "").trim(),
    ownerUserId: String(env.URC_OWNER_USER_ID ?? "").trim(),
    enabled: envFlag(env.URC_ENABLED),
    bypass: envFlag(env.URC_BYPASS_PERMISSIONS),
  };
}

export function configProblem(config) {
  if (!config.url) return "MINDBOARD_URL is not set in worker/urc.env";
  if (!config.token) return "URC_DEVICE_TOKEN is not set in worker/urc.env";
  if (!isUuid(config.ownerUserId)) {
    return "URC_OWNER_USER_ID in worker/urc.env must be a Supabase user uuid";
  }
  return null;
}

// { "key": "C:\\path" } — keys must match the server's charset, paths must be
// non-empty strings. A malformed entry is dropped with a reason rather than
// silently reshaping the folder list.
export function parseFolders(text) {
  let raw;
  try {
    raw = JSON.parse(String(text ?? ""));
  } catch {
    return { folders: {}, problems: ["urc.folders.json is not valid JSON"] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { folders: {}, problems: ["urc.folders.json must be a { key: path } object"] };
  }
  const folders = {};
  const problems = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!FOLDER_KEY_PATTERN.test(key)) {
      problems.push(`folder key "${key}" is not allowed (letters, digits, . _ -)`);
      continue;
    }
    if (typeof value !== "string" || !value.trim()) {
      problems.push(`folder key "${key}" has no path`);
      continue;
    }
    folders[key] = value.trim();
  }
  return { folders, problems };
}

// Same rule as app/lib/urc/preview.ts URC_LABEL_PATTERN. The PC re-checks the
// chat-chosen name itself: it ends up in argv and the bootstrap, and the server
// is not trusted to have checked it. Anything that doesn't match is dropped and
// the default name is used, so a bad name can't fail (or reach) a launch.
export const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;

export function sessionNameFor(jobId, label) {
  const hex = String(jobId).replace(/-/g, "").toLowerCase();
  if (typeof label === "string" && LABEL_PATTERN.test(label)) {
    return `${label}-${hex.slice(0, 6)}`;
  }
  return `${URC_SESSION_PREFIX}${hex.slice(0, 8)}`;
}

// The process query used to verify tracked sessions. It searches for each
// tracked session's exact name. (It used to search for "urc-", which a
// chat-named session like fix-tests-41c72e doesn't contain, so a live named
// session was read as gone, reported stopped, and orphaned.) Names are
// embedded in a PowerShell -like pattern, so only names matching the strict
// session-name charset are used; null when none qualify.
const SESSION_NAME_SAFE = /^[a-z0-9][a-z0-9-]{0,40}$/;
export function processQueryFor(sessions) {
  const names = [...new Set((sessions || []).map((s) => s && s.sessionName))].filter(
    (name) => typeof name === "string" && SESSION_NAME_SAFE.test(name),
  );
  if (names.length === 0) return null;
  const match = names.map((name) => `$_.CommandLine -like '*${name}*'`).join(" -or ");
  return (
    `Get-CimInstance Win32_Process | Where-Object { ($_.CommandLine) -and (${match}) -and ` +
    `$_.CommandLine -notlike '*Get-CimInstance*' } | ` +
    `ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`
  );
}

export function sessionUrlFor(bridgeSessionId) {
  return `https://claude.ai/code/${bridgeSessionId}`;
}

// The argv handed to claude.exe. `bypass` is a plain boolean the caller reads
// out of urc.env — the job never reaches this function, which is what makes
// "the server cannot turn bypass on" structural rather than a code review note.
export function buildSpawnArgs({ sessionName, bypass }) {
  const args = [
    "--remote-control",
    sessionName,
    "--name",
    sessionName,
    "--model",
    URC_MODEL,
  ];
  if (bypass) args.push("--dangerously-skip-permissions");
  return args;
}

// The whole spawn decision, taking the job AND the local config, so a test can
// hand it a hostile job payload and assert argv is unchanged.
export function decideSpawn(job, config) {
  const sessionName = sessionNameFor(job.id, job.label);
  const bypass = config.bypass === true;
  return {
    sessionName,
    bypass,
    args: buildSpawnArgs({ sessionName, bypass }),
  };
}

export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// The per-session sentinels a parent Claude Code session exports, which make a
// spawned session believe it is nested (and, via ANTHROPIC_BASE_URL, disable
// remote control outright because RC needs the real subscription). This list is
// the union of the three that already exist in this repo and its tooling —
// overnight/run.mjs's CHILD_ENV scrub, overnight/rc-spike.ps1's $scrub, and the
// newrc skill's — plus the messaging/attendance handles observed in a live
// session on this box, which are per-session values of the same family. It is
// deliberately a NAME LIST and not the old `^CLAUDE` prefix match: legitimate
// configuration (CLAUDE_CODE_SUBAGENT_MODEL, CLAUDE_CODE_GIT_BASH_PATH, feature
// flags) must reach the new session untouched. ANTHROPIC_ stays a prefix: every
// one of those is auth routing.
export const URC_ENV_SENTINELS = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_PID",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "DISABLE_TELEMETRY",
  "DO_NOT_TRACK",
  "DISABLE_GROWTHBOOK",
];

export const URC_ENV_PREFIXES = ["ANTHROPIC_"];

// PowerShell 5.1 reads a BOM-less UTF-8 file as ANSI, which mangles any
// non-ASCII path (`C:\Users\U\Documents\São Paulo` becomes garbage and
// Set-Location fails). The script body is ASCII apart from the folder path, and
// bootstrapFile() prefixes the BOM that makes PS decode it as UTF-8.
export function buildBootstrap({ folder, sessionName, args }) {
  const quoted = args.map(psQuote).join(" ");
  const drop = URC_ENV_SENTINELS.map((name) => psQuote(name)).join(", ");
  const prefixes = URC_ENV_PREFIXES.map((prefix) => psQuote(`${prefix}*`)).join(", ");
  return [
    "# Generated by worker/urc-agent.mjs for URC session " + sessionName + ".",
    "# Rewritten on every spawn; safe to delete. Saved as UTF-8 WITH BOM so",
    "# PowerShell 5.1 decodes the folder path correctly.",
    '$ErrorActionPreference = "Stop"',
    "# A Claude Code session that spawned this agent would otherwise leak its",
    "# own sentinels and auth routing into the child, which disables remote",
    "# control and makes the child think it is nested. Legitimate CLAUDE_CODE_*",
    "# configuration is left alone.",
    "$sentinels = @(" + drop + ")",
    "$prefixes = @(" + prefixes + ")",
    // The names are collected into an array first: removing items while the
    // Env: drive is still being enumerated is how this breaks intermittently.
    "$drop = @(Get-ChildItem Env: | ForEach-Object { $_.Name } | Where-Object {",
    "  $name = $_",
    "  ($sentinels -contains $name) -or (@($prefixes | Where-Object { $name -like $_ }).Count -gt 0)",
    "})",
    'foreach ($name in $drop) { Remove-Item ("Env:" + $name) -ErrorAction SilentlyContinue }',
    "# A folder that cannot be entered must NOT fall through to claude running",
    "# in whatever directory this window happened to start in.",
    "try {",
    "  Set-Location -LiteralPath " + psQuote(folder),
    "} catch {",
    '  Write-Output ("urc: cannot enter the session folder: " + $_.Exception.Message)',
    "  exit 1",
    "}",
    '& "' + URC_CLAUDE_EXE + '" ' + quoted,
    "",
  ].join("\r\n");
}

// What actually gets written to disk: the script body behind a UTF-8 BOM.
export const URC_BOM = "\uFEFF";

export function bootstrapFile(input) {
  return `${URC_BOM}${buildBootstrap(input)}`;
}

// How the window is launched. No `-NoExit`: the window must close when claude
// exits, otherwise every ended session leaves a dead console on the desktop
// that nothing tracks and the next stop request has nothing to kill.
export function bootstrapRunnerArgs(bootstrapPath) {
  return ["-ExecutionPolicy", "Bypass", "-File", bootstrapPath];
}

export function windowsTerminalArgs(sessionName, bootstrapPath) {
  return [
    "--title",
    sessionName,
    "powershell.exe",
    ...bootstrapRunnerArgs(bootstrapPath),
  ];
}

export function normalizeTrustKey(folderPath) {
  return String(folderPath ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

// Is `"<key>": true` present at the TOP level of this object block? Scanning
// the raw text means a nested object (projects.<p>.mcpServers.<s>.<key>) must
// not be mistaken for the project's own flag, so depth is tracked rather than
// regex-matching the whole block.
function topLevelFlagIsTrue(block, key) {
  const needle = `"${key}"`;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < block.length; i += 1) {
    const char = block[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      if (depth === 1 && block.startsWith(needle, i)) {
        const match = block.slice(i + needle.length).match(/^\s*:\s*(true|false)/);
        if (match) {
          if (match[1] === "true") return true;
          i += needle.length;
          continue;
        }
      }
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
  }
  return false;
}

function blockEnd(text, open) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Read-only trust lookup in ~/.claude.json. The file is scanned as text, not
// JSON.parse'd, because it legitimately holds several keys for the same folder
// that differ only in drive-letter case; the folder counts as trusted when ANY
// of them says so. A session launched into an untrusted folder parks on the
// trust prompt and never registers with the bridge, so the agent refuses up
// front instead of waiting out the 60s timeout. It NEVER writes this file —
// Lucca trusts a folder by opening claude there once himself.
export function isFolderTrusted(claudeJsonText, folderPath) {
  const text = String(claudeJsonText ?? "");
  const wanted = normalizeTrustKey(folderPath);
  if (!wanted) return false;

  const keyPattern = /"([^"\\]+)"\s*:\s*\{/g;
  let match;
  while ((match = keyPattern.exec(text)) !== null) {
    if (normalizeTrustKey(match[1]) !== wanted) continue;
    const open = match.index + match[0].length - 1;
    const close = blockEnd(text, open);
    if (close < 0) continue;
    const block = text.slice(open, close + 1);
    if (topLevelFlagIsTrue(block, "hasTrustDialogAccepted")) return true;
  }
  return false;
}

// Everything the PC checks about a claimed job before it spawns anything.
// `trustedLookup` is injected so the test can drive it without a real
// ~/.claude.json, and `pathExists` likewise.
export function checkJob({
  job,
  config,
  folders,
  pathExists = () => true,
  isTrusted = () => true,
}) {
  if (!config.enabled) {
    return { ok: false, error: "the URC agent is disabled on the PC (URC_ENABLED)" };
  }
  if (!job || !isUuid(job.id)) {
    return { ok: false, error: "job id is not a uuid" };
  }
  if (!job.user_id || job.user_id !== config.ownerUserId) {
    return { ok: false, error: "job does not belong to this PC's URC owner" };
  }
  const key = typeof job.folder_key === "string" ? job.folder_key : "";
  if (!FOLDER_KEY_PATTERN.test(key)) {
    return { ok: false, error: "folder key is not allowed" };
  }
  const folder = folders[key];
  if (!folder) {
    return { ok: false, error: `this PC has no folder registered as "${key}"` };
  }
  if (!pathExists(folder)) {
    return { ok: false, error: `the folder for "${key}" no longer exists on this PC` };
  }
  if (!isTrusted(folder)) {
    return {
      ok: false,
      error: `the folder for "${key}" is not trusted in Claude Code yet - open claude there once and accept the trust prompt`,
    };
  }
  return { ok: true, folder, sessionName: sessionNameFor(job.id, job.label) };
}

export function recentSpawns(spawns, nowMs) {
  return (Array.isArray(spawns) ? spawns : [])
    .filter((at) => Number.isFinite(at) && nowMs - at < URC_SPAWNS_WINDOW_MS)
    .sort((a, b) => a - b);
}

// Local limits, enforced independently of the server's: the PC is the thing
// that actually pays for a runaway loop.
export function spawnAllowed({ state, nowMs, liveCount }) {
  if (liveCount >= URC_MAX_LIVE_SESSIONS) {
    return { ok: false, error: `${URC_MAX_LIVE_SESSIONS} local sessions are already live` };
  }
  const recent = recentSpawns(state?.spawns, nowMs);
  if (recent.length >= URC_MAX_SPAWNS_PER_HOUR) {
    return {
      ok: false,
      error: `local rate limit: ${URC_MAX_SPAWNS_PER_HOUR} sessions in the last hour`,
    };
  }
  return { ok: true };
}

export function recordSpawn(state, nowMs) {
  const spawns = recentSpawns(state?.spawns, nowMs);
  spawns.push(nowMs);
  return { ...(state ?? {}), spawns };
}

// A registered session writes ~/.claude/sessions/<pid>.json. Match on the name
// AND the folder: a stale file from an earlier session with the same name must
// not be reported as this one's.
export function matchSession(entry, { sessionName, folder }) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.name !== sessionName) return false;
  if (typeof entry.bridgeSessionId !== "string" || !entry.bridgeSessionId) return false;
  if (!Number.isInteger(entry.pid) || entry.pid <= 0) return false;
  if (folder && normalizeTrustKey(entry.cwd) !== normalizeTrustKey(folder)) return false;
  return true;
}

// Windows recycles PIDs and worker/urc-state.json survives a reboot, so a
// recorded pid is NOT evidence on its own: the process it names may be
// something else entirely by now, and this agent must never taskkill that.
// These two turn one `Get-CimInstance` dump ("<pid>|<command line>" lines) into
// a decision per recorded session.
export function parseProcessTable(text) {
  const table = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const separator = line.indexOf("|");
    if (separator <= 0) continue;
    const pid = Number(line.slice(0, separator).trim());
    if (!Number.isInteger(pid) || pid <= 0) continue;
    table.set(pid, line.slice(separator + 1).trim());
  }
  return table;
}

// A pid belongs to a session only while the live process still carries its
// name — the claude.exe as `--remote-control urc-xxxxxxxx`, the parent
// powershell as `-File …\urc-xxxxxxxx.ps1`.
export function pidBelongsToSession(table, pid, sessionName) {
  if (!Number.isInteger(pid) || pid <= 0 || !sessionName) return false;
  const commandLine = table instanceof Map ? table.get(pid) : undefined;
  return typeof commandLine === "string" && commandLine.includes(sessionName);
}

export function sessionIsLive(table, entry) {
  return pidBelongsToSession(table, entry?.pid, entry?.sessionName);
}

// Split tracked sessions into still-ours and finished, or return null when the
// process table could not be read at all.
//
// That null is the whole point: an empty table and a FAILED query look the same
// if a failure is flattened to "no processes", and then one timed-out
// Get-CimInstance would report every live session stopped (dropping the pids
// the kill switch needs) while the kill switch itself quietly killed nothing.
// A null means "unknown" — callers keep their state and try again next tick.
export function classifySessions(table, sessions) {
  if (!(table instanceof Map)) return null;
  const live = [];
  const gone = [];
  for (const entry of sessions ?? []) {
    // Either of our two pids still carrying the session's name means something
    // of ours is running; the entry is kept so the kill switch can reach it.
    const ours =
      sessionIsLive(table, entry) ||
      pidBelongsToSession(table, entry?.parentPid, entry?.sessionName);
    (ours ? live : gone).push(entry);
  }
  return { live, gone };
}

// --- single instance -------------------------------------------------------
// Two agents polling the same device double every limit and race every claim,
// and the second one's kill switch would not know the first one's pids.

// `isAlive` is injected so this stays pure and testable. A pidfile holding a
// live OTHER pid means "do not start"; anything else (missing, malformed, a
// dead pid, or our own pid from a crashed-and-restarted run) is takeable.
export function lockDecision({ text, selfPid, isAlive }) {
  const pid = Number(String(text ?? "").trim().split(/\s+/)[0]);
  if (!Number.isInteger(pid) || pid <= 0) return { action: "take", stale: Boolean(text) };
  if (pid === selfPid) return { action: "take", stale: false };
  if (isAlive(pid)) return { action: "exit", holder: pid };
  return { action: "take", stale: true, holder: pid };
}

// Stops for jobs this agent does not track are acknowledged only once they
// have had time to reach the agent that DOES own them: a sibling mid-spawn has
// not recorded its session yet, and acking its stop would strand a live window
// with the server believing it closed.
export const URC_UNTRACKED_STOP_AGE_MS = 60_000;

export function untrackedStopsToAck({ jobIds, trackedIds, requestedAt, nowMs }) {
  const tracked = new Set(trackedIds ?? []);
  const ages = requestedAt ?? {};
  return (jobIds ?? []).filter((jobId) => {
    if (tracked.has(jobId)) return false;
    const at = Date.parse(ages[jobId] ?? "");
    if (Number.isNaN(at)) return false;
    return nowMs - at > URC_UNTRACKED_STOP_AGE_MS;
  });
}

// The device token must never reach a log file.
export function redact(text, secrets) {
  let out = String(text ?? "");
  for (const secret of secrets ?? []) {
    if (typeof secret === "string" && secret.length >= 8) {
      out = out.split(secret).join("[redacted]");
    }
  }
  return out;
}
