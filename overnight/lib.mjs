// Pure helpers for the overnight orchestrator (docs/overnight-agent-plan.md).
// Everything here is deterministic and unit-tested in __tests__/overnight-lib.test.ts;
// process spawning, MCP calls, and git live in run.mjs.

export function slugify(title) {
  const slug = String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "task";
}

// Stable, collision-safe branch per task: ai/<slug>-<id prefix>.
export function branchNameFor(title, taskId) {
  return `ai/${slugify(title)}-${String(taskId).slice(0, 8)}`;
}

export function clip(text, max) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  const marker = "\n\n[truncated]";
  return value.slice(0, Math.max(0, max - marker.length)) + marker;
}

// Append a dated markdown section to a task's notes without clobbering what
// the user wrote. The whole blob is hard-capped so repeated runs cannot grow
// it without bound — and the NEW section always survives the cap (it is the
// deliverable): over cap, old notes are trimmed instead, keeping their start
// (the user's own text lives at the top).
export function appendSection(notes, heading, body, maxLen = 12000) {
  const head = notes?.trim() ? `${notes.trim()}\n\n---\n\n` : "";
  const bodyRoom = Math.max(200, maxLen - head.length - heading.length - 8);
  const section = `## ${heading}\n\n${clip(body.trim(), bodyRoom)}`;
  if (head.length + section.length <= maxLen) return head + section;
  // Only reachable when the head itself is oversized: trim the old notes.
  const room = maxLen - section.length - 8;
  const trimmedHead = room > 40 ? `${clip(notes.trim(), room)}\n\n---\n\n` : "";
  return trimmedHead + section;
}

// Vercel previews live at a per-branch URL; the exact host is configured via
// OVERNIGHT_PREVIEW_TEMPLATE (e.g. "https://mindboard-git-{branch}-me.vercel.app").
export function previewUrl(template, branch) {
  if (!template) return null;
  return template.replace("{branch}", branch.replace(/[^a-zA-Z0-9-]+/g, "-"));
}

// MCP tool results arrive as { content: [{ type: "text", text }], isError? }.
export function parseToolResult(result) {
  const text = result?.content?.find((c) => c.type === "text")?.text ?? "";
  if (result?.isError) throw new Error(text || "tool call failed");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function pickPlanTasks(tasks, max) {
  return (tasks ?? []).filter((t) => !t.ai_state).slice(0, max);
}

// 'building' is reclaimed too: only one orchestrator ever runs, so a task
// still marked building at run start is a stale claim from a crashed night.
export function pickBuildTasks(tasks, max) {
  return (tasks ?? [])
    .filter((t) => t.ai_state === "approved" || t.ai_state === "building")
    .slice(0, max);
}

// Quote a single argument for a Windows cmd.exe command line (spawn shell:true).
export function quoteArg(arg) {
  const value = String(arg);
  if (/^[a-zA-Z0-9_\-./:=@]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export function planPrompt(task) {
  return [
    `You are planning a feature for the Mindboard codebase (this repository).`,
    `The user captured this improvement idea as a task:`,
    ``,
    `TITLE: ${task.title}`,
    task.notes?.trim() ? `NOTES:\n${task.notes.trim()}` : `(no notes)`,
    ``,
    `Explore the repo as needed and produce a concise implementation plan the`,
    `user will read on their phone and approve. Follow the conventions in`,
    `AGENTS.md. The plan must cover: interpretation of the idea (call out any`,
    `ambiguity), files to touch, data-model/migration needs, UI changes, test`,
    `plan, and risks. Keep it under 300 words, plain markdown, no headings`,
    `larger than ###.`,
  ].join("\n");
}

export function buildPrompt(task, plan) {
  return [
    `Implement the following approved feature plan in this Mindboard worktree.`,
    `Follow AGENTS.md conventions strictly. Keep the change narrow; do not`,
    `refactor unrelated code. Write/extend unit tests for pure logic. Run`,
    `"npm run lint" and "npm run test" yourself and fix what they surface.`,
    `Do NOT run git commit or git push — the orchestrator handles VCS.`,
    ``,
    `TASK: ${task.title}`,
    ``,
    `PLAN (from the task notes):`,
    plan,
  ].join("\n");
}

// The plan a nightly run wrote is the last "## AI plan" section of the notes.
// A section ends only at an appendSection divider (--- followed by another
// ## heading) — a bare markdown horizontal rule inside the plan is content.
export function extractPlan(notes) {
  const text = String(notes ?? "");
  const marker = /## AI plan[^\n]*\n/g;
  let lastIndex = -1;
  let match;
  while ((match = marker.exec(text)) !== null) lastIndex = match.index + match[0].length;
  if (lastIndex === -1) return null;
  const rest = text.slice(lastIndex);
  const cut = rest.search(/\n\n---\n\n(?=## )/);
  return (cut === -1 ? rest : rest.slice(0, cut)).trim() || null;
}
