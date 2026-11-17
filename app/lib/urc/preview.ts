// Pure URC helpers: the limits, the session-name derivation, the literal
// command the PC will run, and the propose preview. No I/O, no env, no clock
// beyond what the caller passes in — so every guard here is unit-testable and
// the preview the chat shows is provably the command the agent builds
// (worker/urc-guards.mjs builds the same string from the same rules).

export const URC_MODEL = "claude-opus-5-5";
export const URC_SESSION_PREFIX = "urc-";

// At most four sessions alive at once, and at most five spawns an hour. Both are
// re-checked at confirm time from server state, not trusted from the proposal.
export const URC_MAX_LIVE_SESSIONS = 4;
export const URC_MAX_SPAWNS_PER_HOUR = 5;
// What the PC may be asked to act on: a stop request is only meaningful for a
// job that has reached the device.
export const URC_LIVE_STATUSES = ["claimed", "running", "stopping"] as const;
// What counts against the live-session limit. 'queued' is included: it is a
// session the PC is about to open, so letting three of them queue up would make
// the limit meaningless for the ~2 minutes before they land.
export const URC_CONCURRENCY_STATUSES = [
  "queued",
  "claimed",
  "running",
  "stopping",
] as const;

// A heartbeat lands every 5s; 20s means "missed four in a row" rather than
// "one slow poll".
export const URC_ONLINE_WINDOW_MS = 20_000;
// A queued job the PC never claimed dies after two minutes: a session must not
// appear long after the conversation that asked for it.
export const URC_JOB_TTL_MS = 2 * 60_000;
// And a proposal confirmed more than five minutes after it was made is refused
// outright, so an old preview can't be used to start a session later.
export const URC_PROPOSAL_TTL_MS = 5 * 60_000;

export const URC_SPAWNS_WINDOW_MS = 60 * 60_000;

// Tolerance for a proposal timestamp ahead of the server's clock. Postgres
// stamps created_at itself, so anything beyond this is a forged row, not skew.
export const URC_CLOCK_SKEW_MS = 30_000;

// The session_url the PC reports back must be exactly a claude.ai code link.
export const URC_SESSION_URL_PATTERN =
  /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+$/;

export const URC_NOT_AVAILABLE = "URC isn't available for this account";
export const URC_OFFLINE = "Your PC is offline or the URC agent isn't running";

export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

// A name the chat may give a session: lowercase letters, digits and single
// hyphens, 1-24 characters, no leading/trailing hyphen. It ends up on the PC's
// command line (--remote-control / --name), so it is a strict allowlist, never
// an escaped free-form string. worker/urc-guards.mjs holds the same pattern and
// re-checks it, because the PC does not trust the server either.
export const URC_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
export const URC_LABEL_MAX = 24;

// "Fix the tests!" -> "fix-the-tests". Absent/blank -> null (default name).
export function normalizeUrcLabel(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "name must be a string" };
  if (!raw.trim()) return { ok: true, value: null };
  const label = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, URC_LABEL_MAX)
    .replace(/-+$/, "");
  if (!label || !URC_LABEL_PATTERN.test(label)) {
    return { ok: false, error: "name needs at least one letter or digit (a-z, 0-9, hyphens)" };
  }
  return { ok: true, value: label };
}

// Default: urc-<first 8 hex of the job id>. With a chat-chosen name:
// <name>-<first 6 hex>, so two sessions with the same name never collide and
// the PC's kill guard (which matches the name on the process command line)
// can't confuse one with an unrelated session. An invalid stored label falls
// back to the default rather than reaching the command line.
export function urcSessionName(jobId: string, label?: string | null): string {
  const hex = jobId.replace(/-/g, "").toLowerCase();
  if (typeof label === "string" && URC_LABEL_PATTERN.test(label)) {
    return `${label}-${hex.slice(0, 6)}`;
  }
  return `${URC_SESSION_PREFIX}${hex.slice(0, 8)}`;
}

export function isValidSessionUrl(value: unknown): value is string {
  return typeof value === "string" && URC_SESSION_URL_PATTERN.test(value);
}

// The literal command. `bypass` comes from the PC's own urc.env (reported via
// the device heartbeat) — there is no server-side or job-side way to set it,
// which is the whole point of reporting rather than commanding it.
export function urcCommandLine(sessionName: string, bypass: boolean): string {
  const parts = [
    "claude",
    "--remote-control",
    sessionName,
    "--name",
    sessionName,
    "--model",
    URC_MODEL,
  ];
  if (bypass) parts.push("--dangerously-skip-permissions");
  return parts.join(" ");
}

export function urcPermissionsLine(bypass: boolean): string {
  return bypass
    ? "Permissions: BYPASS (set on the PC)"
    : "Permissions: normal; the session asks before acting";
}

export function isDeviceOnline(lastSeen: string | null, nowMs: number): boolean {
  if (!lastSeen) return false;
  const seen = Date.parse(lastSeen);
  if (Number.isNaN(seen)) return false;
  return nowMs - seen <= URC_ONLINE_WINDOW_MS;
}

export type SpawnPreviewInput = {
  deviceName: string;
  folderKey: string;
  // The path the PC reported for this key, if it reported one. Display only —
  // the server never sends a path back to the PC.
  folderLabel: string | null;
  bypass: boolean;
  // The normalized chat-chosen name, or null for the default.
  label?: string | null;
};

// The job id does not exist yet at propose time, so the name carries a literal
// `<id>` placeholder; the confirm result and the started report carry the real
// name.
export function renderSpawnPreview(input: SpawnPreviewInput): string {
  const name = input.label ? `${input.label}-<id>` : `${URC_SESSION_PREFIX}<id>`;
  const lines = [
    `Start a Claude Code remote-control session on ${input.deviceName}.`,
    `Session name: ${name}`,
    `Folder: ${input.folderKey}${input.folderLabel ? ` (${input.folderLabel})` : ""}`,
    `Command: ${urcCommandLine(name, input.bypass)}`,
    "No starting prompt (v1)",
    urcPermissionsLine(input.bypass),
  ];
  return lines.join("\n");
}
