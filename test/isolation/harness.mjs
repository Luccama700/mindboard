// Shared plumbing for the two-tenant isolation probe: env loading, the
// pass/fail reporter, and the leak scanner.
//
// Nothing here may print real user data. The probe only ever creates its own
// throwaway users, and only their ids/marker strings are ever logged. Tokens,
// PATs, service-role keys and Authorization headers are never printed.

import { readFileSync } from "node:fs";

export function loadEnv(envUrl) {
  const env = {};
  const raw = readFileSync(envUrl, "utf8").replace(/^﻿/, "");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

export function createReporter() {
  const state = { passes: 0, failures: 0, notes: [] };

  function line(ok, label, detail) {
    console.log(`${ok ? "  PASS" : "! FAIL"}  ${label}${!ok && detail ? ` — ${detail}` : ""}`);
    if (ok) state.passes += 1;
    else {
      state.failures += 1;
      state.notes.push(`${label}${detail ? ` — ${detail}` : ""}`);
    }
  }

  return {
    state,
    section(title) {
      console.log(`\n== ${title} ==`);
    },
    info(text) {
      console.log(`  ${text}`);
    },
    check(label, ok, detail = "") {
      line(Boolean(ok), label, String(detail ?? ""));
      return Boolean(ok);
    },
    fail(label, detail = "") {
      line(false, label, String(detail ?? ""));
      return false;
    },
  };
}

// Everything about tenant B that tenant A must never be handed back. Each entry
// is a literal the probe wrote itself, so matching it in a response is proof of
// a cross-tenant read — never a coincidence.
export function leakNeedles(b) {
  const out = [];
  const push = (label, value) => {
    if (typeof value === "string" && value) out.push({ label, value });
  };
  push("B marker", b.marker);
  for (const [key, value] of Object.entries(b)) {
    if (key === "marker") continue;
    push(`B.${key}`, value);
  }
  return out;
}

// Scan a tool response for B's secrets, ignoring any needle the caller itself
// supplied in the request: echoing back an id the attacker already typed is not
// a disclosure, resolving it to data is.
export function scanForLeak(responseText, needles, argsText) {
  const haystack = String(responseText ?? "");
  const sent = String(argsText ?? "");
  return needles
    .filter((n) => !sent.includes(n.value))
    .filter((n) => haystack.includes(n.value))
    .map((n) => n.label);
}

export function toolJson(result) {
  const text = result?.content?.find((c) => c.type === "text")?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function toolText(result) {
  return (result?.content ?? [])
    .map((c) => (typeof c?.text === "string" ? c.text : JSON.stringify(c)))
    .join("\n");
}

export function todayKey(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
