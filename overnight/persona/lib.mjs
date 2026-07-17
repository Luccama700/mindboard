const ACTIONS = new Set(["click", "scroll", "wait", "back", "finish"]);
const SEVERITIES = new Set(["low", "medium", "high"]);

function firstJsonObject(text) {
  const value = String(text ?? "");
  const start = value.indexOf("{");
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
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return value.slice(start, i + 1);
    }
  }
  return null;
}

function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, max);
}

export function normalizeFinding(value, fallback = {}) {
  if (!value || typeof value !== "object") return null;
  const title = cleanText(value.title, 120);
  const evidence = cleanText(value.evidence, 600);
  if (!title || !evidence) return null;
  return {
    title,
    evidence,
    suggestion: cleanText(value.suggestion, 600),
    severity: SEVERITIES.has(value.severity) ? value.severity : "medium",
    scenario: cleanText(value.scenario, 80) || fallback.scenario || "",
    step: Number.isInteger(value.step) && value.step > 0 ? value.step : fallback.step ?? null,
  };
}

export function parseActionJson(text) {
  const raw = firstJsonObject(text);
  if (!raw) return null;

  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || !ACTIONS.has(value.action)) return null;

  const action = {
    action: value.action,
    reason: cleanText(value.reason, 400),
    observation: cleanText(value.observation, 500),
    attention:
      typeof value.attention === "number" && Number.isFinite(value.attention)
        ? Math.max(0, Math.min(100, Math.round(value.attention)))
        : null,
  };

  if (action.action === "click") {
    if (!Number.isInteger(value.target) || value.target < 1) return null;
    action.target = value.target;
  } else if (action.action === "scroll") {
    if (!new Set(["up", "down"]).has(value.direction)) return null;
    action.direction = value.direction;
  } else if (action.action === "wait") {
    const milliseconds = Number(value.milliseconds ?? 750);
    if (!Number.isFinite(milliseconds)) return null;
    action.milliseconds = Math.max(250, Math.min(3000, Math.round(milliseconds)));
  } else if (action.action === "finish") {
    action.outcome = new Set(["goal_complete", "bored", "blocked"]).has(value.outcome)
      ? value.outcome
      : "blocked";
    action.summary = cleanText(value.summary, 1000);
    action.findings = Array.isArray(value.findings)
      ? value.findings.map((finding) => normalizeFinding(finding)).filter(Boolean).slice(0, 8)
      : [];
  }

  return action;
}

export function createStepBudget(maxSteps) {
  const limit = Math.max(1, Math.floor(Number(maxSteps) || 1));
  let used = 0;
  return {
    take() {
      if (used >= limit) return null;
      used += 1;
      return { step: used, used, remaining: limit - used, limit };
    },
    snapshot() {
      return { used, remaining: limit - used, limit };
    },
  };
}

export function findingKey(finding) {
  return `${String(finding.title ?? "").trim().toLowerCase()}|${String(finding.evidence ?? "")
    .trim()
    .toLowerCase()
    .slice(0, 160)}`;
}

export function dedupeFindings(findings) {
  const seen = new Set();
  return (findings ?? []).filter((finding) => {
    const key = findingKey(finding);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function runPersonaScenario({ scenario, budget, observe, decide, act, log = () => {} }) {
  const transcript = [];
  const findings = [];
  let invalidReplies = 0;

  while (true) {
    const turn = budget.take();
    if (!turn) {
      return {
        scenario,
        outcome: "step_limit",
        summary: `The scenario did not converge before the ${budget.snapshot().limit}-step cap.`,
        transcript,
        findings,
      };
    }

    const snapshot = await observe({ scenario, turn, transcript });
    if (snapshot.authExpired) throw new Error("saved browser auth expired; run save-auth.mjs again");

    const raw = await decide({ scenario, turn, snapshot, transcript });
    const action = parseActionJson(typeof raw === "string" ? raw : JSON.stringify(raw));
    if (!action) {
      invalidReplies += 1;
      transcript.push({ step: turn.step, url: snapshot.url, action: "invalid", reason: "unparseable model reply" });
      log(`  step ${turn.step}: invalid model reply`);
      if (invalidReplies >= 3) {
        return {
          scenario,
          outcome: "blocked",
          summary: "The evaluator returned three invalid actions in a row.",
          transcript,
          findings,
        };
      }
      continue;
    }

    invalidReplies = 0;
    transcript.push({
      step: turn.step,
      url: snapshot.url,
      screenshot: snapshot.screenshot,
      action: action.action,
      target: action.target ?? null,
      attention: action.attention,
      observation: action.observation,
      reason: action.reason,
    });
    log(`  step ${turn.step}: ${action.action}${action.target ? ` #${action.target}` : ""}`);

    if (action.action === "finish") {
      const normalized = (action.findings ?? [])
        .map((finding) => normalizeFinding(finding, { scenario: scenario.id, step: turn.step }))
        .filter(Boolean);
      findings.push(...normalized);
      if (normalized.length === 0 && action.outcome !== "goal_complete") {
        const evidence = action.summary || action.reason || "The evaluator stopped before completing the scenario.";
        findings.push({
          title: action.outcome === "bored" ? "The onboarding lost attention" : "The onboarding path became blocked",
          evidence,
          suggestion: "Shorten the path and make the next useful action explicit.",
          severity: action.outcome === "bored" ? "high" : "medium",
          scenario: scenario.id,
          step: turn.step,
        });
      }
      return {
        scenario,
        outcome: action.outcome,
        summary: action.summary || action.reason,
        transcript,
        findings,
      };
    }

    try {
      await act(action, snapshot);
    } catch (error) {
      transcript.push({
        step: turn.step,
        url: snapshot.url,
        action: "action_error",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function buildPersonaReport({ date, model, url, results, findings }) {
  const lines = [
    `# Persona onboarding audit — ${date}`,
    "",
    `- model: \`${model}\``,
    `- target: ${url}`,
    `- viewport: iPhone 13 (390×844)`,
    `- scenarios: ${results.length}`,
    `- findings: ${findings.length}`,
    "",
  ];

  for (const result of results) {
    lines.push(`## ${result.scenario.title}`, "");
    lines.push(`**Outcome:** ${result.outcome} after ${result.transcript.filter((row) => row.action !== "action_error").length} steps.`);
    if (result.summary) lines.push("", result.summary);
    lines.push("", "### Attention trace", "");
    for (const row of result.transcript) {
      const attention = row.attention == null ? "?" : `${row.attention}/100`;
      const detail = row.reason || row.observation || "no explanation";
      const screenshot = row.screenshot ? ` · screenshot: \`${row.screenshot}\`` : "";
      lines.push(`- step ${row.step} · attention ${attention} · ${row.action}: ${detail}${screenshot}`);
    }
    lines.push("");
  }

  lines.push("## Findings", "");
  if (findings.length === 0) lines.push("No actionable onboarding friction was reported.");
  for (const finding of findings) {
    lines.push(
      `### [${finding.severity}] ${finding.title}`,
      "",
      `- scenario: ${finding.scenario}`,
      `- step: ${finding.step ?? "unknown"}`,
      `- evidence: ${finding.evidence}`,
      `- suggested fix: ${finding.suggestion || "not supplied"}`,
      "",
    );
  }
  return `${lines.join("\n").trim()}\n`;
}
