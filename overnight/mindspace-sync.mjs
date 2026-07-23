#!/usr/bin/env node
// Mindspace session sync (docs/mindspace-plan.md M3): scans the local Claude
// Code transcripts under ~/.claude/projects and sends per-session records to
// the mindspace_ingest_sessions MCP tool. Privacy contract: only the USER'S
// OWN prompts travel (filtered, truncated) — assistant output and tool results
// never leave this machine. Runs at the end of each overnight run (run.mjs)
// and standalone via `node overnight/mindspace-sync.mjs`.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseToolResult } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(HERE, ".mindspace-sync.json");

const SESSION_GAP_MS = 60 * 60 * 1000;
const MAX_AGE_DAYS = 30;
const FIRST_RUN_DAYS = 14;
const RESCAN_SLACK_MS = 6 * 60 * 60 * 1000;
const USER_TEXT_CAP = 6000;
const MAX_SESSIONS_PER_RUN = 400;
const BATCH = 200;

const NOISE_PREFIXES = [
  "<system-reminder",
  "<command-",
  "<local-command",
  "Caveat:",
  "[Request interrupted",
];

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function userTextFrom(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && block.type === "text" && typeof block.text === "string"
        ? block.text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function isNoise(text) {
  const trimmed = text.trimStart();
  return NOISE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

// One transcript file → messages [{tsMs, isUser, text}] + the session's cwd.
export function parseTranscript(raw) {
  const messages = [];
  let cwd = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.isSidechain) continue; // subagent traffic, not the user
    if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;
    const tsMs = Date.parse(entry.timestamp ?? "");
    if (Number.isNaN(tsMs)) continue;
    if (entry.type === "user") {
      const text = userTextFrom(entry.message?.content);
      const clean = text && !isNoise(text) ? text : "";
      messages.push({ tsMs, isUser: true, text: clean });
    } else if (entry.type === "assistant") {
      messages.push({ tsMs, isUser: false, text: "" });
    }
  }
  messages.sort((a, b) => a.tsMs - b.tsMs);
  return { messages, cwd };
}

// Split a transcript's messages into gap-separated sessions with the user's
// words only.
export function sessionsFrom(sessionId, project, messages, nowMs) {
  const cutoffMs = nowMs - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const sessions = [];
  let start = 0;
  while (start < messages.length) {
    let end = start;
    while (
      end + 1 < messages.length &&
      messages[end + 1].tsMs - messages[end].tsMs <= SESSION_GAP_MS
    ) {
      end++;
    }
    const slice = messages.slice(start, end + 1);
    start = end + 1;

    const startMs = slice[0].tsMs;
    const endMs = slice[slice.length - 1].tsMs;
    if (endMs < cutoffMs || endMs > nowMs + 60_000) continue;

    const userTexts = slice
      .filter((message) => message.isUser && message.text)
      .map((message) => message.text);
    if (userTexts.length === 0) continue;

    const userText = userTexts.join("\n").slice(0, USER_TEXT_CAP);
    const firstLine = userTexts[0].replace(/\s+/g, " ").trim().slice(0, 80);
    sessions.push({
      ref: `${sessionId}:${startMs}`,
      title: project ? `${project}: ${firstLine}` : firstLine,
      project: project ?? undefined,
      startedAt: new Date(startMs).toISOString(),
      endedAt: new Date(endMs).toISOString(),
      durationMin: Math.max(2, Math.round((endMs - startMs) / 60_000)),
      userText,
      wordCount: (userText.match(/\S+/g) ?? []).length,
    });
  }
  return sessions;
}

function collectSessions(nowMs, sinceMs, log) {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) {
    log("no ~/.claude/projects — nothing to sync");
    return [];
  }
  const sessions = [];
  for (const dir of readdirSync(projectsDir)) {
    const dirPath = join(projectsDir, dir);
    let files;
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const filePath = join(dirPath, file);
      let stat;
      try {
        stat = statSync(filePath);
      } catch {
        continue;
      }
      if (stat.mtimeMs < sinceMs) continue;
      let parsed;
      try {
        parsed = parseTranscript(readFileSync(filePath, "utf8"));
      } catch {
        continue;
      }
      const project = parsed.cwd ? basename(parsed.cwd) : null;
      sessions.push(
        ...sessionsFrom(basename(file, ".jsonl"), project, parsed.messages, nowMs),
      );
    }
  }
  sessions.sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt));
  return sessions.slice(0, MAX_SESSIONS_PER_RUN);
}

export async function syncMindspaceSessions({ url, pat, log = console.log }) {
  const nowMs = Date.now();
  const state = loadState();
  const sinceMs =
    typeof state.lastRunMs === "number"
      ? state.lastRunMs - RESCAN_SLACK_MS
      : nowMs - FIRST_RUN_DAYS * 24 * 60 * 60 * 1000;

  const sessions = collectSessions(nowMs, sinceMs, log);
  if (sessions.length === 0) {
    log("mindspace sync: no new claude code sessions");
    writeFileSync(STATE_PATH, JSON.stringify({ lastRunMs: nowMs }));
    return { imported: 0, skipped: 0 };
  }

  const transport = new StreamableHTTPClientTransport(
    new URL(`${url}/api/mcp/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${pat}` } } },
  );
  const client = new Client({ name: "mindspace-sync", version: "1.0.0" });
  await client.connect(transport);

  let imported = 0;
  let skipped = 0;
  try {
    for (let i = 0; i < sessions.length; i += BATCH) {
      const result = parseToolResult(
        await client.callTool({
          name: "mindspace_ingest_sessions",
          arguments: {
            provider: "claude_code",
            sessions: sessions.slice(i, i + BATCH),
          },
        }),
      );
      imported += result.imported ?? 0;
      skipped += result.skipped ?? 0;
    }
  } finally {
    await client.close().catch(() => {});
  }

  writeFileSync(STATE_PATH, JSON.stringify({ lastRunMs: nowMs }));
  log(`mindspace sync: ${imported} sessions sent, ${skipped} skipped`);
  return { imported, skipped };
}

// Standalone: node overnight/mindspace-sync.mjs (reads overnight/.env).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const envPath = join(HERE, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
  const url = (process.env.MINDBOARD_URL ?? "").replace(/\/$/, "");
  const pat = process.env.MINDBOARD_PAT ?? "";
  if (!url || !pat) {
    console.error("MINDBOARD_URL and MINDBOARD_PAT required (overnight/.env)");
    process.exit(1);
  }
  syncMindspaceSessions({ url, pat }).catch((error) => {
    console.error(`mindspace sync failed: ${error?.message ?? error}`);
    process.exit(1);
  });
}
