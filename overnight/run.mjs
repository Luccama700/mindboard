#!/usr/bin/env node
// Overnight orchestrator (docs/overnight-agent-plan.md).
//
// Runs nightly at 4am via Windows Task Scheduler (install-task.ps1). Talks to
// the deployed app as an MCP client on the user's mbp_ PAT, so every write
// rides the same propose → confirm + ai_audit_log rails as any AI surface.
//
// Track A (code, the mindboard group):
//   plan phase   ai_state null      → claude -p (plan mode, read-only) → notes + 'planned'
//   build phase  ai_state approved  → git worktree + claude -p (acceptEdits)
//                                     → lint/test/build gate → push ai/<slug> → 'built'|'failed'
// Track B (life, every other task):
//   triage       ai_state null      → one cheap model call vs capabilities.md
//                                     → approach into notes + 'planned' (or cached infeasible)
//   exec         ai_state approved  → claude -p, WebSearch/WebFetch ONLY, draft-never-submit
//                                     → summary to notes + full result to the brain vault
//
// Config comes from the environment or overnight/.env (see README.md).
// Usage: node overnight/run.mjs [--dry] [--plan-only] [--build-only]
//                               [--code-only] [--life-only] [--if-requested]

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import lockfile from "proper-lockfile";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  appendSection,
  branchNameFor,
  buildPrompt,
  clip,
  execPrompt,
  extractPlan,
  extractSection,
  parseToolResult,
  parseTriage,
  MODEL_CHOICES,
  pickBuildTasks,
  resolveModel,
  pickExecTasks,
  pickLifeTasks,
  pickPlanTasks,
  planPrompt,
  previewUrl,
  quoteArg,
  triagePrompt,
} from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

// ---------- config ----------

function loadDotEnv() {
  const path = join(HERE, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

const CONFIG = {
  url: (process.env.MINDBOARD_URL ?? "").replace(/\/$/, ""),
  pat: process.env.MINDBOARD_PAT ?? "",
  claudeBin: process.env.OVERNIGHT_CLAUDE_BIN ?? "claude",
  // Model choices (ids from app/_components/agent-models.ts); the app's
  // per-user setting (get_preferences) overrides these env defaults.
  planModel: process.env.OVERNIGHT_PLAN_MODEL ?? "fable-5",
  buildModel: process.env.OVERNIGHT_BUILD_MODEL ?? "gpt-5.6-sol",
  effort: process.env.OVERNIGHT_EFFORT ?? "high",
  proxyUrl: (process.env.OVERNIGHT_PROXY_URL ?? "http://127.0.0.1:8317").replace(/\/$/, ""),
  proxyExe: process.env.OVERNIGHT_PROXY_EXE ?? "",
  maxPlans: Number(process.env.OVERNIGHT_MAX_PLANS ?? 3),
  maxBuilds: Number(process.env.OVERNIGHT_MAX_BUILDS ?? 2),
  planBudgetUsd: process.env.OVERNIGHT_PLAN_BUDGET_USD ?? "3",
  buildBudgetUsd: process.env.OVERNIGHT_BUILD_BUDGET_USD ?? "15",
  planTimeoutMs: Number(process.env.OVERNIGHT_PLAN_TIMEOUT_MIN ?? 20) * 60_000,
  buildTimeoutMs: Number(process.env.OVERNIGHT_BUILD_TIMEOUT_MIN ?? 90) * 60_000,
  previewTemplate: process.env.OVERNIGHT_PREVIEW_TEMPLATE ?? "",
  worktreeRoot: process.env.OVERNIGHT_WORKTREES ?? resolve(REPO, "..", "mindboard-ai"),
  // Track B (life tasks): triage on a cheap model, execution web-only.
  maxLife: Number(process.env.OVERNIGHT_MAX_LIFE ?? 3),
  lifeBudgetUsd: process.env.OVERNIGHT_LIFE_BUDGET_USD ?? "5",
  lifeTimeoutMs: Number(process.env.OVERNIGHT_LIFE_TIMEOUT_MIN ?? 30) * 60_000,
  triageModel: process.env.OVERNIGHT_TRIAGE_MODEL ?? "haiku",
  // Life runs execute OUTSIDE the repo so claude doesn't load Mindboard's
  // project context for an apartment search.
  workspace: process.env.OVERNIGHT_WORKSPACE ?? resolve(REPO, "..", "mindboard-agent-workspace"),
};

const FLAGS = new Set(process.argv.slice(2));
const DRY = FLAGS.has("--dry");

// ---------- logging ----------

const today = new Date().toISOString().slice(0, 10);
const logDir = join(HERE, "logs");
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, `${today}.log`);

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  appendFileSync(logFile, `${line}\n`);
}

// ---------- subprocesses ----------

// Children never see the PAT: cmd.exe expands %VAR% even inside quotes, so a
// hostile task title (or a build-run script) reading the environment must
// find nothing. The token lives only in this process, for MCP calls.
const CHILD_ENV = { ...process.env };
delete CHILD_ENV.MINDBOARD_PAT;
// Session markers from a parent Claude Code session (e.g. the /overnight
// skill) make a spawned `claude -p` think it's nested and refuse to start.
// Only the confirmed sentinels — legitimate CLAUDE_CODE_* configuration
// (GIT_BASH_PATH, feature flags) must reach the child untouched.
for (const key of [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
]) {
  delete CHILD_ENV[key];
}

// SECURITY INVARIANT: args here must never contain user-controlled text
// (titles, notes, plans). Branch names pass through slugify ([a-z0-9-] only);
// commit messages travel via `git commit -F <file>`; prompts go over stdin.
function run(command, args, options = {}) {
  const commandLine = [command, ...args].map(quoteArg).join(" ");
  log(`  $ ${clip(commandLine, 300)}`);
  if (DRY) return { status: 0, stdout: "", stderr: "" };
  const result = spawnSync(commandLine, {
    shell: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: CHILD_ENV,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

// claude -p run: prompt goes in via stdin (avoids Windows argv limits),
// structured result comes back as JSON on stdout.
function runClaude({ prompt, cwd, permissionMode, allowedTools, disallowedTools, tools, strictMcp, budgetUsd, maxTurns, timeoutMs, model, engine, effort }) {
  const args = [
    "-p",
    "--output-format", "json",
    "--permission-mode", permissionMode,
    "--max-turns", String(maxTurns),
    "--max-budget-usd", budgetUsd,
    "--effort", effort ?? CONFIG.effort,
  ];
  if (allowedTools) args.push("--allowedTools", allowedTools);
  if (disallowedTools) args.push("--disallowedTools", disallowedTools);
  // --tools is the EXCLUSIVE availability list (--allowedTools only
  // pre-approves); --strict-mcp-config with no --mcp-config = zero MCP
  // servers. Together they make web-only runs actually web-only.
  if (tools) args.push("--tools", tools);
  if (strictMcp) args.push("--strict-mcp-config");
  const chosenModel = engine?.model ?? model;
  if (chosenModel) args.push("--model", chosenModel);

  // Proxy engines (gpt-5.6-sol) route through the local CLIProxyAPI —
  // claudex's env, minus the PAT like every other child.
  const env = engine?.proxy
    ? { ...CHILD_ENV, ANTHROPIC_BASE_URL: CONFIG.proxyUrl, ANTHROPIC_AUTH_TOKEN: "cliproxy" }
    : CHILD_ENV;

  const result = run(CONFIG.claudeBin, args, { cwd, input: prompt, timeout: timeoutMs, env });
  if (DRY) return { ok: true, text: "(dry run)", costUsd: 0 };
  if (result.status !== 0) {
    return { ok: false, text: clip(result.stderr || result.stdout || "claude exited non-zero", 2000) };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    // is_error catches partial results (budget/turn limit hit mid-run) that
    // still carry text — those must not be written back as finished plans.
    return {
      ok: parsed.is_error ? false : Boolean(parsed.result),
      text: parsed.result ?? clip(result.stdout, 2000),
      costUsd: parsed.total_cost_usd ?? 0,
    };
  } catch {
    return { ok: false, text: clip(result.stdout, 2000) };
  }
}

// ---------- MCP ----------

let client = null;

async function connect() {
  const transport = new StreamableHTTPClientTransport(new URL(`${CONFIG.url}/api/mcp/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${CONFIG.pat}` } },
  });
  client = new Client({ name: "mindboard-overnight", version: "1.0.0" });
  await client.connect(transport);
}

async function tool(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return parseToolResult(result);
}

// Every write is propose → confirm, so it lands in the ai_audit_log.
async function updateTask(taskId, patch) {
  if (DRY) {
    log(`  DRY update_task ${taskId} ${clip(JSON.stringify(patch), 160)}`);
    return;
  }
  const proposal = await tool("update_task", { taskId, ...patch });
  await tool("confirm_action", { proposalId: proposal.proposalId });
}

// Every open task ('doing' included — the read caps each page at 200 rows,
// plenty for a personal board, but warn if a page fills so a miss is never
// silent).
async function openTasksFeed() {
  const pages = await Promise.all([
    tool("list_tasks", { status: "todo" }),
    tool("list_tasks", { status: "doing" }),
  ]);
  for (const page of pages) {
    if (Array.isArray(page) && page.length >= 200) {
      log("warning: a task page hit the 200-row read cap — some tasks may be missed");
    }
  }
  return pages.flatMap((page) => (Array.isArray(page) ? page : []));
}

// Plans and builds run for a long time; the user may edit notes meanwhile.
// Always re-fetch right before composing a notes write so we append to the
// current text, not the copy from run start. Track A tasks live in the code
// feed; Track B tasks only exist in the full list.
async function freshNotes(taskId, fallback) {
  try {
    const feed = await tool("list_code_tasks");
    const found = feed.tasks?.find((t) => t.id === taskId);
    if (found) return found.notes;
    const life = (await openTasksFeed()).find((t) => t.id === taskId);
    return life ? life.notes : fallback;
  } catch {
    return fallback;
  }
}

// ---------- engines (per-phase models) ----------

// Resolved once per run in main(): the app's per-user choice, else env
// defaults. Proxy models degrade to opus if claudex is unreachable.
const ENGINES = { plan: null, build: null };

async function proxyReachable() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${CONFIG.proxyUrl}/v1/models`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureProxy() {
  if (await proxyReachable()) return true;
  if (!CONFIG.proxyExe || DRY) return false;
  log("claudex proxy down — starting it");
  try {
    const child = spawn(CONFIG.proxyExe, [], {
      cwd: dirname(CONFIG.proxyExe),
      detached: true,
      stdio: "ignore",
      // Long-lived process — it must never inherit the PAT.
      env: CHILD_ENV,
    });
    child.unref();
  } catch (error) {
    log(`  proxy start failed: ${clip(String(error), 200)}`);
    return false;
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
  return proxyReachable();
}

// ---------- single-runner lock ----------

// The 4am task, the 5-minute poll, and manual /overnight runs are separate
// processes — this lock is what makes "only one orchestrator ever runs" true
// (the 'building' reclaim in lib.mjs depends on it).
//
// Three review rounds established that a hand-rolled lockfile protocol
// cannot be made race-free with fs primitives alone (partial-write
// visibility on create, ABA on stale cleanup). proper-lockfile is the
// proven implementation the review called for: atomic mkdir acquisition,
// an mtime heartbeat while the holder is alive (so staleness is real, not
// guessed), stale takeover built in, and compromise detection — if this
// process somehow loses the lock, the run aborts rather than double-running.
const LOCK_FILE = join(HERE, ".lock");
// The heartbeat is a timer, and every child command here runs through
// spawnSync — a 90-minute build blocks the event loop for the whole call, so
// no touch happens and the lock's mtime ages the full length of the longest
// sync child. `stale` must exceed that, or an idle 5-minute poll "takes over"
// the healthy lock mid-build and the holder aborts as compromised right
// before finalization (exactly the 2026-07-17 double-build). Cost of the
// margin: a genuinely crashed holder delays the next takeover by ~the same
// window — the polls pick it up afterward.
const LOCK_STALE_MS =
  Math.max(CONFIG.buildTimeoutMs, CONFIG.planTimeoutMs, CONFIG.lifeTimeoutMs, 20 * 60_000) +
  15 * 60_000;
const LOCK_OPTS = {
  lockfilePath: LOCK_FILE,
  stale: LOCK_STALE_MS,
  update: 60 * 1000,
  onCompromised: (error) => {
    log(`FATAL: lock compromised (${error.message}) — aborting to avoid a double run`);
    process.exit(1);
  },
};

// Scheduled runs retry: an idle poll may hold the lock for the few seconds
// its claim check takes, and StartWhenAvailable can release both tasks at
// the same instant after a wake — the nightly run must outwait that, not
// silently skip the night. Polls try once and yield to the next poll.
async function acquireLock({ retries = 0, delayMs = 30_000 } = {}) {
  try {
    await lockfile.lock(HERE, {
      ...LOCK_OPTS,
      retries: retries > 0 ? { retries, minTimeout: delayMs, maxTimeout: delayMs } : 0,
    });
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  try {
    lockfile.unlockSync(HERE, { lockfilePath: LOCK_FILE });
  } catch {
    // never acquired, already released, or taken over — nothing ours to free
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    releaseLock();
    process.exit(130);
  });
}

// ---------- local state (Track B triage cache) ----------

// Tasks judged infeasible are remembered on disk so they aren't re-triaged
// every night; an edited title invalidates the entry.
const STATE_FILE = join(HERE, "state.json");

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { infeasible: {} };
  }
}

function saveState(state) {
  if (!DRY) writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- phases ----------

async function planPhase(tasks) {
  const queue = pickPlanTasks(tasks, CONFIG.maxPlans);
  log(`plan phase: ${queue.length} task(s) to plan`);
  const outcomes = [];

  for (const task of queue) {
    // One bad task (timeout, missing binary, MCP hiccup) must not end the
    // night — the rest of the queue and the build phase still run.
    try {
      log(`planning "${task.title}" (${task.id})`);
      const result = runClaude({
        prompt: planPrompt(task),
        cwd: REPO,
        permissionMode: "plan",
        engine: ENGINES.plan,
        budgetUsd: CONFIG.planBudgetUsd,
        maxTurns: 60,
        timeoutMs: CONFIG.planTimeoutMs,
      });

      if (!result.ok) {
        log(`  plan FAILED: ${clip(result.text, 300)}`);
        outcomes.push({ task, ok: false });
        continue;
      }

      const base = await freshNotes(task.id, task.notes);
      const notes = appendSection(base, `AI plan — ${today}`, result.text);
      await updateTask(task.id, { notes, aiState: "planned" });
      log(`  planned (cost $${result.costUsd?.toFixed?.(2) ?? "?"})`);
      outcomes.push({ task, ok: true });
    } catch (error) {
      log(`  plan ERROR: ${clip(error instanceof Error ? error.message : String(error), 300)}`);
      outcomes.push({ task, ok: false });
    }
  }
  return outcomes;
}

async function buildPhase(tasks) {
  const queue = pickBuildTasks(tasks, CONFIG.maxBuilds);
  log(`build phase: ${queue.length} approved task(s)`);
  const outcomes = [];

  for (const task of queue) {
    const branch = branchNameFor(task.title, task.id);
    const worktree = join(CONFIG.worktreeRoot, branch.replace(/\//g, "-"));
    const plan = extractPlan(task.notes) ?? task.notes ?? task.title;
    log(`building "${task.title}" → ${branch}`);
    await updateTask(task.id, { aiState: "building" });

    try {
      mkdirSync(CONFIG.worktreeRoot, { recursive: true });
      const git = (args, opts) => {
        const r = run("git", args, { cwd: REPO, ...opts });
        if (r.status !== 0) throw new Error(`git ${args[0]}: ${clip(r.stderr, 400)}`);
        return r;
      };
      git(["fetch", "origin", "main"]);
      // A failed night keeps its worktree/branch for inspection; a retry (or
      // a cleared-and-requeued task) must not collide with those leftovers —
      // including a registered-but-deleted worktree or an unregistered dir.
      run("git", ["worktree", "remove", "--force", worktree], { cwd: REPO });
      run("git", ["worktree", "prune"], { cwd: REPO });
      if (!DRY) rmSync(worktree, { recursive: true, force: true });
      run("git", ["branch", "-D", branch], { cwd: REPO });
      git(["worktree", "add", worktree, "-b", branch, "origin/main"]);

      const inTree = { cwd: worktree };
      const npm = (args) => {
        const r = run("npm", args, { ...inTree, timeout: 20 * 60_000 });
        if (r.status !== 0) throw new Error(`npm ${args.join(" ")} failed:\n${clip(r.stderr || r.stdout, 1200)}`);
      };
      npm(["ci"]);

      const result = runClaude({
        prompt: buildPrompt(task, plan),
        cwd: worktree,
        permissionMode: "acceptEdits",
        engine: ENGINES.build,
        allowedTools:
          "Bash(npm run lint),Bash(npm run test),Bash(npm run test *),Bash(npm run build),Bash(npx vitest *),Bash(npx tsc *),Bash(git status),Bash(git diff *),Bash(git log *),Bash(ls *)",
        budgetUsd: CONFIG.buildBudgetUsd,
        maxTurns: 200,
        timeoutMs: CONFIG.buildTimeoutMs,
      });
      if (!result.ok) throw new Error(`claude build run failed: ${clip(result.text, 800)}`);

      // The gate is authoritative regardless of what the build run reported.
      npm(["run", "lint"]);
      npm(["run", "test"]);
      npm(["run", "build"]);

      const dirty = run("git", ["status", "--porcelain"], inTree).stdout.trim();
      if (!dirty && !DRY) throw new Error("build run produced no changes");
      git(["add", "-A"], inTree);
      // Commit message goes via -F: the title is user text and must never
      // touch a shell line (cmd.exe %VAR% expansion — see run()).
      const msgFile = join(tmpdir(), `mb-commit-${task.id}.txt`);
      writeFileSync(
        msgFile,
        `AI build: ${task.title}\n\nOvernight agent, task ${task.id}.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n`,
      );
      try {
        git(["commit", "-F", msgFile], inTree);
      } finally {
        rmSync(msgFile, { force: true });
      }
      // ai/* branches are agent-owned; --force covers a re-run after the
      // local branch was rebuilt from a fresh origin/main.
      git(["push", "-u", "--force", "origin", branch], inTree);

      const preview = previewUrl(CONFIG.previewTemplate, branch);
      const report = [
        `Branch: \`${branch}\``,
        preview ? `Preview: ${preview}` : null,
        ``,
        clip(result.text, 1500),
      ]
        .filter((line) => line !== null)
        .join("\n");
      await updateTask(task.id, {
        notes: appendSection(await freshNotes(task.id, task.notes), `AI build — ${today}`, report),
        aiState: "built",
      });
      run("git", ["worktree", "remove", "--force", worktree], { cwd: REPO });
      log(`  built and pushed ${branch} (cost $${result.costUsd?.toFixed?.(2) ?? "?"})`);
      outcomes.push({ task, ok: true, branch });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`  build FAILED: ${clip(message, 500)}`);
      try {
        await updateTask(task.id, {
          notes: appendSection(
            await freshNotes(task.id, task.notes),
            `AI build failed — ${today}`,
            clip(message, 1500),
          ),
          aiState: "failed",
        });
      } catch (writeError) {
        // Task stays 'building'; the next run reclaims it (pickBuildTasks).
        log(`  could not record failure: ${clip(String(writeError), 200)}`);
      }
      outcomes.push({ task, ok: false });
      // Worktree is kept on failure for morning inspection.
    }
  }
  return outcomes;
}

// ---------- Track B: life tasks (docs/overnight-agent-plan.md) ----------

// One cheap triage call over every untouched non-code task: feasible ones get
// their proposed approach written into the notes as an approval request
// (ai_state 'planned' — the same badge/button as code tasks); infeasible ones
// are cached locally and left alone.
async function triagePhase(allTasks, codeGroupId, state) {
  const queue = pickLifeTasks(allTasks, codeGroupId, state.infeasible);
  log(`life triage: ${queue.length} new task(s) to assess`);
  if (queue.length === 0) return [];

  const manifest = readFileSync(join(HERE, "capabilities.md"), "utf8");
  const result = runClaude({
    prompt: triagePrompt(queue, manifest),
    cwd: CONFIG.workspace,
    permissionMode: "dontAsk",
    tools: "WebSearch,WebFetch",
    strictMcp: true,
    budgetUsd: "1",
    maxTurns: 4,
    timeoutMs: 5 * 60_000,
    model: CONFIG.triageModel,
    effort: "low",
  });
  if (!result.ok) {
    log(`  triage FAILED: ${clip(result.text, 300)}`);
    return [];
  }
  const verdicts = DRY ? [] : parseTriage(result.text, queue.map((t) => t.id));
  if (!DRY && !verdicts) {
    log(`  triage returned unparseable output: ${clip(result.text, 300)}`);
    return [];
  }

  const outcomes = [];
  for (const verdict of verdicts ?? []) {
    const task = queue.find((t) => t.id === verdict.id);
    try {
      if (!verdict.feasible) {
        state.infeasible[task.id] = { title: task.title, reason: verdict.reason ?? "", at: today };
        continue;
      }
      const body = `${verdict.approach.trim()}\n\n*approve on this task and I'll do it on the next run.*`;
      const base = await freshNotes(task.id, task.notes);
      await updateTask(task.id, {
        notes: appendSection(base, `AI approach — ${today}`, body),
        aiState: "planned",
      });
      log(`  proposed: "${task.title}"`);
      outcomes.push({ task, ok: true, approach: verdict.approach });
    } catch (error) {
      log(`  triage write ERROR for "${task.title}": ${clip(String(error), 200)}`);
      outcomes.push({ task, ok: false });
    }
  }
  saveState(state);
  return outcomes;
}

// Execute approved life tasks: web research only — no shell, no file edits,
// nothing submitted anywhere. Deliverable goes to the task notes (summary)
// and the brain vault (full text).
async function execPhase(allTasks, codeGroupId) {
  const queue = pickExecTasks(allTasks, codeGroupId, CONFIG.maxLife);
  log(`life exec: ${queue.length} approved task(s)`);
  const outcomes = [];

  for (const task of queue) {
    try {
      log(`working "${task.title}" (${task.id})`);
      await updateTask(task.id, { aiState: "building" });
      const approach =
        extractSection(task.notes, "AI approach") ?? "No stored approach; use the task title.";

      const result = runClaude({
        prompt: execPrompt(task, approach),
        cwd: CONFIG.workspace,
        permissionMode: "dontAsk",
        engine: ENGINES.build,
        // --tools is the exclusive availability list and strictMcp drops
        // every MCP server: web research is ACTUALLY web-only, whatever the
        // task notes try to talk it into. allowed/disallowed kept as belts.
        tools: "WebSearch,WebFetch",
        strictMcp: true,
        allowedTools: "WebSearch,WebFetch",
        disallowedTools: "Bash,Edit,Write,NotebookEdit",
        budgetUsd: CONFIG.lifeBudgetUsd,
        maxTurns: 80,
        timeoutMs: CONFIG.lifeTimeoutMs,
      });
      if (!result.ok) throw new Error(clip(result.text, 800));

      // The deliverable is never lost: a local copy lands next to the logs
      // before any network write is attempted.
      if (!DRY) writeFileSync(join(logDir, `result-${task.id}-${today}.md`), result.text);

      let captured = false;
      if (!DRY) {
        try {
          await tool("capture_to_brain", {
            // CAPTURE_TITLE_MAX is 80 — cap the composed title, not the task title.
            title: `AI result: ${task.title}`.slice(0, 80),
            summary_markdown: clip(result.text, 20000),
            source: `overnight agent (life task), ${today}`,
            topics: ["overnight-agent"],
          });
          captured = true;
        } catch (error) {
          log(`  vault capture failed (non-fatal): ${clip(String(error), 200)}`);
        }
      }
      // Vault capture failed → keep far more of the result in the notes.
      const summary = captured
        ? `${clip(result.text, 1200)}\n\n*full result saved to your brain vault.*`
        : clip(result.text, 6000);
      await updateTask(task.id, {
        notes: appendSection(await freshNotes(task.id, task.notes), `AI result — ${today}`, summary),
        aiState: "built",
      });
      log(`  done (cost $${result.costUsd?.toFixed?.(2) ?? "?"})`);
      outcomes.push({ task, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`  life task FAILED: ${clip(message, 400)}`);
      try {
        await updateTask(task.id, {
          notes: appendSection(
            await freshNotes(task.id, task.notes),
            `AI attempt failed — ${today}`,
            clip(message, 800),
          ),
          aiState: "failed",
        });
      } catch (writeError) {
        log(`  could not record failure: ${clip(String(writeError), 200)}`);
      }
      outcomes.push({ task, ok: false });
    }
  }
  return outcomes;
}

async function nightReport(planned, built, lifeProposed = [], lifeDone = []) {
  if (
    planned.length === 0 &&
    built.length === 0 &&
    lifeProposed.length === 0 &&
    lifeDone.length === 0
  ) {
    return;
  }
  const lines = [
    ...planned.map((o) => `- plan ${o.ok ? "ready" : "FAILED"}: ${o.task.title}`),
    ...built.map((o) => `- build ${o.ok ? `pushed (${o.branch})` : "FAILED"}: ${o.task.title}`),
    ...lifeProposed.map((o) => `- approach ${o.ok ? "proposed" : "FAILED"}: ${o.task.title}`),
    ...lifeDone.map((o) => `- life task ${o.ok ? "done" : "FAILED"}: ${o.task.title}`),
  ];
  try {
    if (!DRY) {
      await tool("capture_to_brain", {
        title: `Overnight agent — ${today}`,
        summary_markdown: clip(lines.join("\n"), 3500),
        source: `overnight orchestrator, ${today}`,
        topics: ["overnight-agent"],
      });
    }
    log("night report captured to brain");
  } catch (error) {
    log(`night report failed (non-fatal): ${error instanceof Error ? error.message : error}`);
  }
}

// ---------- main ----------

async function main() {
  if (!CONFIG.url || !CONFIG.pat) {
    throw new Error("MINDBOARD_URL and MINDBOARD_PAT are required (overnight/.env)");
  }
  // Lock BEFORE claiming: if another run is live, a pending "run now"
  // request must survive untouched for the next poll to pick up. Polls give
  // up immediately (the next one comes in 5 min); real runs wait out
  // transient contention.
  const isPoll = FLAGS.has("--if-requested");
  const locked = await acquireLock(isPoll ? {} : { retries: 8, delayMs: 30_000 });
  if (!locked) {
    if (!isPoll) log("another run held the lock for 4+ minutes — exiting");
    return;
  }

  await connect();

  // Poll mode (the 5-minute scheduled task): exit silently unless the user
  // tapped "run agent now" in the app since the last poll. A dry poll never
  // claims — claiming would consume the user's real request.
  if (FLAGS.has("--if-requested")) {
    if (DRY) return;
    const claim = await tool("claim_agent_run");
    if (!claim.requested) return;
    log("on-demand run requested from the app");
  }

  log(`overnight run start${DRY ? " (dry)" : ""}`);

  // Per-phase engines: app setting → env default; proxy models fall back to
  // opus when claudex is unreachable rather than failing the night.
  let prefs = {};
  try {
    prefs = await tool("get_preferences");
  } catch {
    log("get_preferences failed — using env-default models");
  }
  const planChoice = prefs.agentPlanModel ?? CONFIG.planModel;
  const buildChoice = prefs.agentBuildModel ?? CONFIG.buildModel;
  const needsProxy = [planChoice, buildChoice].some((c) => MODEL_CHOICES[c]?.proxy);
  const proxyOk = needsProxy ? await ensureProxy() : false;
  ENGINES.plan = resolveModel(planChoice, proxyOk, "fable-5");
  ENGINES.build = resolveModel(buildChoice, proxyOk, "gpt-5.6-sol");
  log(
    `engines: plan=${ENGINES.plan.id}${ENGINES.plan.fellBack ? " (proxy down → fallback)" : ""}, ` +
      `build=${ENGINES.build.id}${ENGINES.build.fellBack ? " (proxy down → fallback)" : ""}, ` +
      `effort=${CONFIG.effort}`,
  );

  const doCode = !FLAGS.has("--life-only");
  const doLife = !FLAGS.has("--code-only");
  const doProposals = !FLAGS.has("--build-only");
  const doExecution = !FLAGS.has("--plan-only");
  mkdirSync(CONFIG.workspace, { recursive: true });

  // Always fetched: Track A's feed, and the code group id Track B excludes.
  const feed = await tool("list_code_tasks");

  let planned = [];
  let built = [];
  if (doCode) {
    if (!feed.group) {
      log("no active 'mindboard' group — skipping the code track");
    } else {
      log(`${feed.tasks.length} open task(s) in ${feed.group.name}`);
      if (doProposals) planned = await planPhase(feed.tasks);
      if (doExecution) built = await buildPhase(feed.tasks);
    }
  }

  let lifeProposed = [];
  let lifeDone = [];
  if (doLife) {
    const allTasks = await openTasksFeed();
    const codeGroupId = feed.group?.id ?? null;
    const state = loadState();
    if (doProposals) lifeProposed = await triagePhase(allTasks, codeGroupId, state);
    if (doExecution) lifeDone = await execPhase(allTasks, codeGroupId);
  }

  await nightReport(planned, built, lifeProposed, lifeDone);

  // Mindspace: send local Claude Code session summaries to the app (M3,
  // docs/mindspace-plan.md). Non-fatal — a failed sync just retries with the
  // next run's rescan slack.
  if (!DRY) {
    try {
      const { syncMindspaceSessions } = await import("./mindspace-sync.mjs");
      await syncMindspaceSessions({ url: CONFIG.url, pat: CONFIG.pat, log });
    } catch (error) {
      log(`mindspace sync failed (non-fatal): ${error?.message ?? error}`);
    }
  }

  log("overnight run complete");
}

main()
  .then(() => {
    releaseLock();
    process.exit(0);
  })
  .catch((error) => {
    log(`FATAL: ${error instanceof Error ? (error.stack ?? error.message) : error}`);
    releaseLock();
    process.exit(1);
  });
