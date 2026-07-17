#!/usr/bin/env node
// Overnight orchestrator (docs/overnight-agent-plan.md).
//
// Runs nightly at 4am via Windows Task Scheduler (install-task.ps1). Talks to
// the deployed app as an MCP client on the user's mbp_ PAT, so every write
// rides the same propose → confirm + ai_audit_log rails as any AI surface.
//
//   plan phase   ai_state null      → claude -p (plan mode, read-only) → notes + 'planned'
//   build phase  ai_state approved  → git worktree + claude -p (acceptEdits)
//                                     → lint/test/build gate → push ai/<slug> → 'built'|'failed'
//
// Config comes from the environment or overnight/.env (see README.md).
// Usage: node overnight/run.mjs [--dry] [--plan-only] [--build-only]

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  extractPlan,
  parseToolResult,
  pickBuildTasks,
  pickPlanTasks,
  planPrompt,
  previewUrl,
  quoteArg,
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
  model: process.env.OVERNIGHT_MODEL ?? "",
  maxPlans: Number(process.env.OVERNIGHT_MAX_PLANS ?? 3),
  maxBuilds: Number(process.env.OVERNIGHT_MAX_BUILDS ?? 2),
  planBudgetUsd: process.env.OVERNIGHT_PLAN_BUDGET_USD ?? "3",
  buildBudgetUsd: process.env.OVERNIGHT_BUILD_BUDGET_USD ?? "15",
  planTimeoutMs: Number(process.env.OVERNIGHT_PLAN_TIMEOUT_MIN ?? 20) * 60_000,
  buildTimeoutMs: Number(process.env.OVERNIGHT_BUILD_TIMEOUT_MIN ?? 90) * 60_000,
  previewTemplate: process.env.OVERNIGHT_PREVIEW_TEMPLATE ?? "",
  worktreeRoot: process.env.OVERNIGHT_WORKTREES ?? resolve(REPO, "..", "mindboard-ai"),
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
function runClaude({ prompt, cwd, permissionMode, allowedTools, budgetUsd, maxTurns, timeoutMs }) {
  const args = [
    "-p",
    "--output-format", "json",
    "--permission-mode", permissionMode,
    "--max-turns", String(maxTurns),
    "--max-budget-usd", budgetUsd,
  ];
  if (allowedTools) args.push("--allowedTools", allowedTools);
  if (CONFIG.model) args.push("--model", CONFIG.model);

  const result = run(CONFIG.claudeBin, args, { cwd, input: prompt, timeout: timeoutMs });
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

// Plans and builds run for a long time; the user may edit notes meanwhile.
// Always re-fetch right before composing a notes write so we append to the
// current text, not the copy from run start.
async function freshNotes(taskId, fallback) {
  try {
    const feed = await tool("list_code_tasks");
    const found = feed.tasks?.find((t) => t.id === taskId);
    return found ? found.notes : fallback;
  } catch {
    return fallback;
  }
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

async function nightReport(planned, built) {
  if (planned.length === 0 && built.length === 0) return;
  const lines = [
    ...planned.map((o) => `- plan ${o.ok ? "ready" : "FAILED"}: ${o.task.title}`),
    ...built.map((o) => `- build ${o.ok ? `pushed (${o.branch})` : "FAILED"}: ${o.task.title}`),
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
  log(`overnight run start${DRY ? " (dry)" : ""}`);

  await connect();
  const feed = await tool("list_code_tasks");
  if (!feed.group) {
    log("no active 'mindboard' group — nothing to do");
    return;
  }
  log(`${feed.tasks.length} open task(s) in ${feed.group.name}`);

  const planned = FLAGS.has("--build-only") ? [] : await planPhase(feed.tasks);
  const built = FLAGS.has("--plan-only") ? [] : await buildPhase(feed.tasks);
  await nightReport(planned, built);
  log("overnight run complete");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log(`FATAL: ${error instanceof Error ? (error.stack ?? error.message) : error}`);
    process.exit(1);
  });
