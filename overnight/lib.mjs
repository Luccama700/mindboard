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

// 'building' is reclaimed too: the run.mjs lockfile guarantees a single live
// orchestrator, so a task still marked building at run start is a stale
// claim from a crashed run.
export function pickBuildTasks(tasks, max) {
  return (tasks ?? [])
    .filter((t) => t.ai_state === "approved" || t.ai_state === "building")
    .slice(0, max);
}

// A flag that was passed but carries no value. Distinct from null (absent) so
// `--task` with a forgotten id is a usage error instead of silently becoming a
// full sweep over the whole board.
export const FLAG_WITHOUT_VALUE = Symbol("flag without value");

// Value of a `--flag value` (or `--flag=value`) argument. null when the flag
// is absent; FLAG_WITHOUT_VALUE when it is present but trailing, empty, or
// followed by another flag (never swallow the next flag as a value).
export function argValue(argv, flag) {
  const args = argv ?? [];
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg.startsWith(`${flag}=`)) {
      const value = arg.slice(flag.length + 1);
      return value === "" ? FLAG_WITHOUT_VALUE : value;
    }
    if (arg === flag) {
      const next = args[i + 1];
      if (next === undefined || String(next).startsWith("--")) {
        return FLAG_WITHOUT_VALUE;
      }
      return String(next);
    }
  }
  return null;
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

// Post-push adversarial review of a build branch. Read-only by design: the
// reviewer sees the worktree after the orchestrator's gate has passed, so its
// job is judgment (real defects, invariant violations), not fixing.
export function reviewPrompt(task, branch) {
  return [
    `You are an adversarial code reviewer. This worktree holds branch ${branch},`,
    `an overnight AI build of the task below, already pushed for the user's`,
    `morning review. Diff it against origin/main (git diff origin/main...HEAD),`,
    `and READ the surrounding code before judging — every finding must name a`,
    `concrete failure scenario, not a suspicion. AGENTS.md is the convention`,
    `reference.`,
    ``,
    `TASK: ${task.title}`,
    ``,
    `Hunt real defects only: broken behavior, RLS/multi-tenant leaks (queries`,
    `not threaded through the caller's userId), writes that bypass the`,
    `propose→confirm rail, secrets reaching code/logs/child env, Windows path`,
    `or filename breakage, races against existing locks/mutexes, and untested`,
    `pure logic. Style nits do not count.`,
    ``,
    `Reply with EXACTLY one of:`,
    `VERDICT: ship — plus one line on why it is safe to merge.`,
    `VERDICT: caution — plus a ranked list of findings, each with file:line,`,
    `the failure scenario, and the minimal fix.`,
  ].join("\n");
}

// The last section a nightly run wrote under the given heading prefix.
// A section ends only at an appendSection divider (--- followed by another
// ## heading) — a bare markdown horizontal rule inside the body is content.
export function extractSection(notes, headingPrefix) {
  const text = String(notes ?? "");
  const marker = new RegExp(`## ${headingPrefix}[^\\n]*\\n`, "g");
  let lastIndex = -1;
  let match;
  while ((match = marker.exec(text)) !== null) lastIndex = match.index + match[0].length;
  if (lastIndex === -1) return null;
  const rest = text.slice(lastIndex);
  const cut = rest.search(/\n\n---\n\n(?=## )/);
  return (cut === -1 ? rest : rest.slice(0, cut)).trim() || null;
}

export function extractPlan(notes) {
  return extractSection(notes, "AI plan");
}

// ---------- model choices ----------

// Mirrors app/_components/agent-models.ts (the ids user_settings stores).
// `model` is what the claude CLI receives; `proxy` routes through the local
// CLIProxyAPI (claudex) for non-Anthropic models.
export const MODEL_CHOICES = {
  "fable-5": { model: "fable" },
  "opus-5": { model: "claude-opus-5" },
  "opus-4.8": { model: "opus" },
  "gpt-5.6-sol": { model: "gpt-5.6-sol", proxy: true },
};

// Resolve a stored choice to an engine. Unknown ids fall back to the given
// default; a proxy model with the proxy down falls back to opus so a dead
// claudex at 4am degrades the run instead of killing it.
export function resolveModel(choice, proxyUp, defaultId = "fable-5") {
  const id = MODEL_CHOICES[choice] ? choice : defaultId;
  const def = MODEL_CHOICES[id];
  if (def.proxy && !proxyUp) {
    return { id: "opus-4.8", ...MODEL_CHOICES["opus-4.8"], fellBack: true };
  }
  return { id, ...def };
}

// ---------- Track B: life tasks ----------

// Everything open outside the code group that the agent hasn't touched and
// that isn't cached as infeasible (cache invalidates when the title changes).
export function pickLifeTasks(tasks, codeGroupId, infeasibleCache = {}) {
  return (tasks ?? []).filter(
    (t) =>
      t.status !== "done" &&
      t.status !== "missed" &&
      !t.ai_state &&
      (codeGroupId == null || t.group_id !== codeGroupId) &&
      infeasibleCache[t.id]?.title !== t.title,
  );
}

export function pickExecTasks(tasks, codeGroupId, max) {
  return (tasks ?? [])
    .filter(
      (t) =>
        (t.ai_state === "approved" || t.ai_state === "building") &&
        (codeGroupId == null || t.group_id !== codeGroupId),
    )
    .slice(0, max);
}

export function triagePrompt(tasks, manifest) {
  const list = tasks
    .map(
      (t) =>
        `- id: ${t.id}\n  title: ${t.title}\n  group: ${t.group_name ?? "inbox"}` +
        (t.notes?.trim() ? `\n  notes: ${clip(t.notes.trim().replace(/\s+/g, " "), 400)}` : ""),
    )
    .join("\n");
  return [
    `You triage a user's personal to-do list for an overnight AI assistant.`,
    `The assistant's capabilities manifest:`,
    ``,
    manifest,
    ``,
    `TASKS:`,
    list,
    ``,
    `For each task decide if the assistant can genuinely advance it within the`,
    `manifest's CAN list. Be conservative: when a task is a reminder, needs the`,
    `user's accounts, or is a physical action, it is infeasible. For feasible`,
    `tasks write the approach in second person ("I'll compare ...", max ~80`,
    `words): concretely what you would research/draft/plan and what you'd`,
    `deliver back.`,
    ``,
    `Reply with ONLY a JSON array, no prose:`,
    `[{"id": "<task id>", "feasible": true, "approach": "..."},`,
    ` {"id": "<task id>", "feasible": false, "reason": "..."}]`,
  ].join("\n");
}

// First balanced top-level JSON array in the text (string-aware, so brackets
// inside quoted values don't miscount) — robust against prose or bracketed
// asides after the array, where a greedy regex would swallow to the last ].
export function extractJsonArray(text) {
  const value = String(text ?? "");
  const start = value.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < value.length; i++) {
    const ch = value[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return value.slice(start, i + 1);
    }
  }
  return null;
}

// Tolerant parse: the model may wrap the array in prose or a code fence.
export function parseTriage(text, validIds) {
  const raw = extractJsonArray(text);
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const ids = new Set(validIds);
  return parsed.filter(
    (v) =>
      v &&
      typeof v.id === "string" &&
      ids.has(v.id) &&
      typeof v.feasible === "boolean" &&
      (!v.feasible || typeof v.approach === "string"),
  );
}

// ---------- Track C: dispatched tasks ("do this now") ----------

// The user picked THIS task and asked for it now, so the executor gets full
// local powers instead of Track B's web-only profile — the guardrails below
// are what keep that safe, and they are carried verbatim in the prompt beside
// the Track C manifest (overnight/dispatch-capabilities.md, NOT the web-only
// capabilities.md). Spec:
// docs/superpowers/specs/2026-07-31-task-dispatch-design.md.
export function dispatchPrompt(task, note, manifest) {
  return [
    `You are the user's home agent, dispatched by them just now to work ONE`,
    `task at full power: shell, files, and the browser are yours inside your`,
    `workspace.`,
    ``,
    `HARD RULES: never submit, send, sign, purchase, publish, or post anything`,
    `in the user's name — you prepare, research, build, and draft, and they`,
    `act on it. No credential handling. Graded coursework submission stays a`,
    `human action. Code work happens on ai/* branches only, never main.`,
    ``,
    `YOUR DISPATCH CAPABILITIES MANIFEST:`,
    ``,
    manifest,
    ``,
    `TASK: ${task.title}`,
    task.notes?.trim() ? `THE TASK'S NOTES:\n${clip(task.notes.trim(), 4000)}` : ``,
    ``,
    `WHAT THE USER JUST ASKED FOR (this is the brief — it wins over the notes`,
    `where they disagree):`,
    clip(String(note ?? "").trim(), 4000),
    ``,
    `Do the work now. Your final message is the deliverable itself: plain`,
    `markdown, concrete results with paths/links/branches where relevant, and`,
    `a short "suggested next steps for you" list at the end. No preamble.`,
  ].join("\n");
}

export function execPrompt(task, approach) {
  return [
    `You are an overnight research assistant working a task from the user's`,
    `personal to-do list. You have web search and web fetch only — no file`,
    `edits, no shell, no logins.`,
    ``,
    `HARD RULES: never submit, send, purchase, book, sign, or post anything.`,
    `Everything you produce is a draft/briefing the user acts on themselves.`,
    `No graded academic work — prep and practice material only.`,
    ``,
    `TASK: ${task.title}`,
    task.notes?.trim() ? `THE USER'S NOTES:\n${clip(task.notes.trim(), 2000)}` : ``,
    ``,
    `THE APPROVED APPROACH:`,
    approach,
    ``,
    `Do the work now. Your final message is the deliverable itself: plain`,
    `markdown, concrete findings with sources/links where relevant, and a`,
    `short "suggested next steps for you" list at the end. No preamble.`,
  ].join("\n");
}
