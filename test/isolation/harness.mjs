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
//
// Every string the seed writes MUST be stored on the seed object, not just
// interpolated into a row: a B string with no dedicated needle is only covered
// by the bare run marker, and the marker is the one needle a request can
// legitimately echo. See seedTenant.
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

// Every string literal the request supplied, so the scanner can tell an echo
// from a disclosure. Whole-JSON text will not do: the spans below are located
// by searching the response for each sent VALUE.
export function stringLeaves(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out);
  else if (value && typeof value === "object") {
    for (const v of Object.values(value)) stringLeaves(v, out);
  }
  return out;
}

function occurrences(haystack, needle) {
  const out = [];
  if (!needle) return out;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return out;
}

// Scan a tool response for B's secrets. Echoing back a string the attacker
// typed is not a disclosure; resolving it to data is — so the subtraction is
// done PER OCCURRENCE, not per needle.
//
// Dropping a whole needle because the request mentioned it (the obvious
// implementation) is unsound here: the run marker prefixes every one of B's
// names, so a single request carrying any B name would blind the scanner to
// every other B string that has no dedicated needle. Instead each sent value is
// located in the response and the spans it covers are treated as echo; a needle
// leaks if ANY of its occurrences falls outside every echo span.
export function scanForLeak(responseText, needles, sentStrings) {
  const haystack = String(responseText ?? "");
  const echoed = [];
  for (const sent of sentStrings ?? []) {
    if (typeof sent !== "string" || !sent) continue;
    for (const at of occurrences(haystack, sent)) echoed.push([at, at + sent.length]);
  }
  const isEcho = (start, end) => echoed.some(([from, to]) => start >= from && end <= to);
  return needles
    .filter((n) =>
      occurrences(haystack, n.value).some((at) => !isEcho(at, at + n.value.length)),
    )
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
