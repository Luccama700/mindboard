#!/usr/bin/env node
// Screenshot → decide → act onboarding evaluation using the local Codex vision
// model. The browser may navigate and complete/replay tours, but every other
// account mutation is fenced out by the element collector and action executor.

import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { clip, ensureProxy, parseToolResult, resolveModel } from "../lib.mjs";
import {
  buildPersonaReport,
  createStepBudget,
  dedupeFindings,
  normalizeFinding,
  runPersonaScenario,
} from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OVERNIGHT = resolve(HERE, "..");
const REPO = resolve(OVERNIGHT, "..");

function loadDotEnv() {
  const path = join(OVERNIGHT, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

loadDotEnv();

const FLAGS = new Set(process.argv.slice(2));
const DRY = FLAGS.has("--dry-run");
const CONFIG = {
  url: (process.env.PERSONA_URL ?? process.env.MINDBOARD_URL ?? "").replace(/\/$/, ""),
  pat: process.env.MINDBOARD_PAT ?? "",
  proxyUrl: (process.env.OVERNIGHT_PROXY_URL ?? "http://127.0.0.1:8317").replace(/\/$/, ""),
  proxyExe: process.env.OVERNIGHT_PROXY_EXE ?? "",
  modelChoice: process.env.PERSONA_MODEL ?? "gpt-5.6-sol",
  maxSteps: Number(process.env.PERSONA_MAX_STEPS ?? 40),
  timeoutMs: Number(process.env.PERSONA_MODEL_TIMEOUT_SEC ?? 90) * 1000,
  headed: FLAGS.has("--headed"),
  authFile: process.env.PERSONA_AUTH_FILE ?? join(HERE, "auth-state.json"),
  fileTasks: !FLAGS.has("--no-file-tasks"),
  captureBrain: !FLAGS.has("--no-brain-capture"),
};

const SCENARIOS = [
  {
    id: "first-minute",
    title: "First minute: understand the board and find homework capture",
    goal:
      "You just signed in. Work out what Mindboard is for and where you would add homework due Friday. Do not type or submit it; stop once the path is obvious.",
  },
  {
    id: "week-money-groceries",
    title: "Real-life scan: week, money, and groceries",
    goal:
      "You need to know whether Saturday looks free, whether money seems okay, and where groceries live. Use the onboarding and navigation to find those answers without changing any data.",
  },
];

const selectedScenario = process.argv.find((arg) => arg.startsWith("--scenario="))?.split("=")[1];
const scenarios = selectedScenario ? SCENARIOS.filter((scenario) => scenario.id === selectedScenario) : SCENARIOS;
const today = new Date().toISOString().slice(0, 10);
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const logDir = join(OVERNIGHT, "logs");
const screenshotDir = join(HERE, "screenshots", runId);
mkdirSync(logDir, { recursive: true });
const textLog = join(logDir, `persona-${today}.log`);

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  if (!DRY) appendFileSync(textLog, `${line}\n`);
}

const CHILD_ENV = { ...process.env };
delete CHILD_ENV.MINDBOARD_PAT;
for (const key of [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
]) {
  delete CHILD_ENV[key];
}

function startProxy(executable) {
  const child = spawn(executable, [], {
    cwd: dirname(executable),
    detached: true,
    stdio: "ignore",
    env: CHILD_ENV,
  });
  child.unref();
}

function responseText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part?.text ?? "").join("");
  return "";
}

async function visionDecision({ persona, scenario, turn, snapshot, transcript, engine }) {
  const recent = transcript.slice(-8).map((row) => ({
    step: row.step,
    url: row.url,
    action: row.action,
    attention: row.attention,
    reason: row.reason,
  }));
  const text = [
    `SCENARIO: ${scenario.title}`,
    scenario.goal,
    "",
    `STEP: ${turn.step}/${turn.limit} (${turn.remaining} actions remain after this one)` ,
    `URL: ${snapshot.url}`,
    `VISIBLE SAFE ELEMENTS:\n${JSON.stringify(snapshot.elements, null, 2)}`,
    `RECENT ACTIONS:\n${JSON.stringify(recent, null, 2)}`,
    "",
    "Choose the next action from the response contract. Click only a listed numeric id.",
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
  try {
    const response = await fetch(`${CONFIG.proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer cliproxy",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: engine.model,
        messages: [
          { role: "system", content: persona },
          {
            role: "user",
            content: [
              { type: "text", text },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${snapshot.imageBase64}` },
              },
            ],
          },
        ],
        max_completion_tokens: 1400,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`vision model returned HTTP ${response.status}`);
    const payload = await response.json();
    const result = responseText(payload);
    if (!result) throw new Error("vision model returned no message content");
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function collectSafeElements(page) {
  return page.evaluate(() => {
    const blocked = /(add|create|save|submit|delete|remove|archive|restore|buy|purchase|upload|generate|complete|mark done|toggle|sign out|log out|run agent|confirm|approve|retry|send|record|adjust|reconcile|pin|unpin|groups|categories)/i;
    const selector = 'a[href], button, [role="button"], [role="link"], summary';
    document.querySelectorAll("[data-persona-target]").forEach((node) =>
      node.removeAttribute("data-persona-target"),
    );

    const result = [];
    for (const node of document.querySelectorAll(selector)) {
      if (!(node instanceof HTMLElement)) continue;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (
        rect.width < 4 ||
        rect.height < 4 ||
        rect.bottom < 0 ||
        rect.top > innerHeight ||
        rect.right < 0 ||
        rect.left > innerWidth ||
        style.visibility === "hidden" ||
        style.display === "none" ||
        Number(style.opacity) === 0 ||
        node.hasAttribute("disabled") ||
        node.getAttribute("aria-disabled") === "true"
      ) {
        continue;
      }

      const label = (
        node.getAttribute("aria-label") ||
        node.getAttribute("title") ||
        node.textContent ||
        ""
      )
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 120);
      if (!label || blocked.test(label)) continue;

      const insideTour = Boolean(node.closest('[role="dialog"]'));
      const insideRail = Boolean(node.closest('[data-tour="dock-rail"]'));
      const insideDockNav = Boolean(node.closest("[data-capture-dock] nav"));
      const helpControl = /replay this screen|what.?s new/i.test(label);
      if (!insideTour && !insideRail && !insideDockNav && !helpControl) continue;

      let href = null;
      if (node instanceof HTMLAnchorElement) {
        try {
          const target = new URL(node.href, location.href);
          if (target.origin !== location.origin) continue;
          href = `${target.pathname}${target.search}`;
        } catch {
          continue;
        }
      }

      const id = result.length + 1;
      node.setAttribute("data-persona-target", String(id));
      result.push({
        id,
        role: node.getAttribute("role") || node.tagName.toLowerCase(),
        label,
        href,
        tour: node.closest("[data-tour]")?.getAttribute("data-tour") ?? null,
      });
      if (result.length >= 60) break;
    }
    return result;
  });
}

function isLoginUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    return pathname === "/login" || pathname.startsWith("/auth/");
  } catch {
    return false;
  }
}

async function resetTours(page) {
  await page.goto(`${CONFIG.url}/settings`, { waitUntil: "domcontentloaded" });
  if (isLoginUrl(page.url())) throw new Error("saved browser auth expired; run save-auth.mjs again");
  await page.evaluate(() => localStorage.removeItem("mb-completed-tours-v2"));
  const replay = page.getByRole("button", { name: "replay all tours" });
  await replay.waitFor({ state: "attached", timeout: 15_000 });
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/", { timeout: 20_000 }),
    replay.click({ force: true }),
  ]);
  await page.waitForTimeout(600);
}

function browserAdapter(page, scenario) {
  return {
    async observe({ turn }) {
      if (isLoginUrl(page.url())) return { authExpired: true, url: page.url(), elements: [] };
      await page.waitForTimeout(350);
      const elements = await collectSafeElements(page);
      const file = join(screenshotDir, `${scenario.id}-${String(turn.step).padStart(2, "0")}.png`);
      const image = await page.screenshot({ path: file });
      return {
        authExpired: false,
        url: page.url(),
        elements,
        imageBase64: image.toString("base64"),
        screenshot: relative(REPO, file).replace(/\\/g, "/"),
      };
    },
    async act(action) {
      if (action.action === "click") {
        const target = page.locator(`[data-persona-target="${action.target}"]`);
        if ((await target.count()) !== 1) throw new Error(`safe target #${action.target} is no longer available`);
        await target.click({ timeout: 5000 });
        await page.waitForTimeout(500);
        return;
      }
      if (action.action === "scroll") {
        await page.evaluate((direction) => {
          const dialogScroller = [...document.querySelectorAll('[role="dialog"] *')].find((node) => {
            if (!(node instanceof HTMLElement) || node.scrollHeight <= node.clientHeight + 4) return false;
            const overflow = getComputedStyle(node).overflowY;
            return overflow === "auto" || overflow === "scroll";
          });
          const target = dialogScroller ?? document.scrollingElement;
          target?.scrollBy({
            top: innerHeight * 0.7 * (direction === "down" ? 1 : -1),
            behavior: "auto",
          });
        }, action.direction);
        await page.waitForTimeout(300);
        return;
      }
      if (action.action === "back") {
        await page.goBack({ waitUntil: "domcontentloaded" });
        return;
      }
      if (action.action === "wait") await page.waitForTimeout(action.milliseconds);
    },
  };
}

function dryReplies() {
  const supplied = process.env.PERSONA_STUB_REPLIES;
  if (supplied) {
    const parsed = JSON.parse(supplied);
    if (!Array.isArray(parsed)) throw new Error("PERSONA_STUB_REPLIES must be a JSON array");
    return parsed.map((reply) => (typeof reply === "string" ? reply : JSON.stringify(reply)));
  }
  return [
    JSON.stringify({ action: "click", target: 1, attention: 72, observation: "The first card is brief.", reason: "I want the useful screen." }),
    JSON.stringify({ action: "scroll", direction: "down", attention: 43, observation: "I am still reading setup copy.", reason: "Looking for the real app." }),
    JSON.stringify({
      action: "finish",
      outcome: "bored",
      attention: 18,
      summary: "The useful action took too long to appear in the stubbed run.",
      findings: [{ title: "The intro delays the first useful action", severity: "high", evidence: "The evaluator quit after two setup interactions.", suggestion: "Offer a direct skip to the live board." }],
    }),
  ];
}

async function dryRun(persona) {
  const budget = createStepBudget(CONFIG.maxSteps);
  const results = [];
  for (const scenario of scenarios) {
    const replies = dryReplies();
    let index = 0;
    const result = await runPersonaScenario({
      scenario,
      budget,
      observe: async ({ turn }) => ({
        authExpired: false,
        url: `http://dry.local/${scenario.id}/${turn.step}`,
        elements: [{ id: 1, role: "button", label: "next", href: null, tour: "intro" }],
        screenshot: `dry/${scenario.id}-${turn.step}.png`,
        imageBase64: "",
      }),
      decide: async () => replies[index++] ?? replies.at(-1),
      act: async () => {},
      log,
    });
    results.push(result);
  }
  const findings = dedupeFindings(results.flatMap((result) => result.findings));
  const report = buildPersonaReport({ date: today, model: CONFIG.modelChoice, url: "dry-run", results, findings });
  console.log(report);
  log(`dry run complete: ${results.length} scenarios, ${findings.length} finding(s), persona ${persona.length} chars`);
}

let mcpClient = null;

async function connectMcp() {
  const transport = new StreamableHTTPClientTransport(new URL(`${CONFIG.url}/api/mcp/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${CONFIG.pat}` } },
  });
  mcpClient = new Client({ name: "mindboard-persona", version: "1.0.0" });
  await mcpClient.connect(transport);
}

async function tool(name, args = {}) {
  const result = await mcpClient.callTool({ name, arguments: args });
  return parseToolResult(result);
}

async function confirmedWrite(name, args) {
  const proposal = await tool(name, args);
  return tool("confirm_action", { proposalId: proposal.proposalId });
}

function taskNotes(finding, reportPath) {
  return [
    `Automated onboarding persona finding from \`${CONFIG.modelChoice}\` vision.`,
    "",
    `- severity: ${finding.severity}`,
    `- scenario: ${finding.scenario}`,
    `- step: ${finding.step ?? "unknown"}`,
    `- evidence: ${finding.evidence}`,
    `- suggested fix: ${finding.suggestion || "not supplied"}`,
    `- full report: \`${reportPath}\``,
    "",
    "Review the finding and the audit-log entry before approving any build.",
  ].join("\n");
}

async function publishReport(report, findings, reportPath) {
  if (!CONFIG.pat) {
    log("MINDBOARD_PAT missing — local report saved; brain capture and task filing skipped");
    return;
  }
  await connectMcp();

  if (CONFIG.captureBrain) {
    try {
      await tool("capture_to_brain", {
        title: `Persona onboarding audit — ${today}`.slice(0, 80),
        summary_markdown: clip(report, 20000),
        source: `gpt-5.6-sol vision persona, ${today}`,
        topics: ["onboarding", "persona-testing", "overnight-agent"],
      });
      log("report captured to brain");
    } catch (error) {
      log(`brain capture failed (non-fatal): ${clip(String(error), 240)}`);
    }
  }

  if (!CONFIG.fileTasks || findings.length === 0) return;
  const feed = await tool("list_code_tasks");
  if (!feed.group) {
    log("no active mindboard group — finding tasks skipped");
    return;
  }
  const existing = new Set((feed.tasks ?? []).map((task) => String(task.title).trim().toLowerCase()));
  for (const finding of findings) {
    const title = `Onboarding: ${finding.title}`.slice(0, 160);
    if (existing.has(title.toLowerCase())) {
      log(`task already exists: ${title}`);
      continue;
    }
    try {
      await confirmedWrite("create_task", {
        title,
        groupId: feed.group.id,
        notes: taskNotes(finding, reportPath),
        priority: finding.severity === "high" ? "high" : finding.severity === "medium" ? "med" : "low",
      });
      existing.add(title.toLowerCase());
      log(`filed finding task: ${title}`);
    } catch (error) {
      log(`task filing failed for "${title}": ${clip(String(error), 240)}`);
    }
  }
}

async function main() {
  const persona = readFileSync(join(HERE, "persona.md"), "utf8");
  if (scenarios.length === 0) throw new Error(`unknown --scenario value: ${selectedScenario}`);
  if (DRY) return dryRun(persona);
  if (!CONFIG.url) throw new Error("PERSONA_URL or MINDBOARD_URL is required");
  if (!existsSync(CONFIG.authFile)) throw new Error(`missing ${CONFIG.authFile}; run save-auth.mjs first`);

  const proxyOk = await ensureProxy({
    proxyUrl: CONFIG.proxyUrl,
    proxyExe: CONFIG.proxyExe,
    log,
    startProxy,
  });
  const engine = resolveModel(CONFIG.modelChoice, proxyOk, "gpt-5.6-sol");
  if (engine.id !== "gpt-5.6-sol" || !engine.proxy) {
    throw new Error("gpt-5.6-sol proxy is unavailable; persona runs do not fall back to another vision model");
  }

  mkdirSync(screenshotDir, { recursive: true });
  const { chromium, devices } = await import("playwright");
  const browser = await chromium.launch({ headless: !CONFIG.headed });
  const context = await browser.newContext({ ...devices["iPhone 13"], storageState: CONFIG.authFile });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const budget = createStepBudget(CONFIG.maxSteps);
  const results = [];

  try {
    log(`persona run start: ${scenarios.length} scenarios, ${CONFIG.maxSteps}-step total cap`);
    for (const scenario of scenarios) {
      if (budget.snapshot().remaining === 0) break;
      log(`scenario: ${scenario.title}`);
      await resetTours(page);
      const adapter = browserAdapter(page, scenario);
      const result = await runPersonaScenario({
        scenario,
        budget,
        observe: adapter.observe,
        decide: (input) => visionDecision({ ...input, persona, engine }),
        act: adapter.act,
        log,
      });
      results.push(result);
      log(`  outcome: ${result.outcome} (${result.transcript.length} transcript rows)`);
    }
  } finally {
    await browser.close();
  }

  const supplemental = results
    .filter((result) => result.outcome === "step_limit")
    .map((result) =>
      normalizeFinding(
        {
          title: "The onboarding did not converge within the interaction cap",
          severity: "high",
          evidence: result.summary,
          suggestion: "Reduce the number of decisions before the scenario's useful destination is visible.",
        },
        { scenario: result.scenario.id, step: budget.snapshot().used },
      ),
    )
    .filter(Boolean);
  const findings = dedupeFindings([...results.flatMap((result) => result.findings), ...supplemental]);
  const report = buildPersonaReport({ date: today, model: engine.id, url: CONFIG.url, results, findings });
  const reportFile = join(logDir, `persona-${today}.md`);
  writeFileSync(reportFile, report);
  const reportPath = relative(REPO, reportFile).replace(/\\/g, "/");
  log(`report written: ${reportPath}`);
  await publishReport(report, findings, reportPath);
  log(`persona run complete: ${findings.length} finding(s)`);
}

main().catch((error) => {
  log(`FATAL: ${error instanceof Error ? error.stack ?? error.message : error}`);
  process.exitCode = 1;
});
