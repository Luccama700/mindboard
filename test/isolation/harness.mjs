// Shared plumbing for the two-tenant isolation probe: env loading, the
// pass/fail reporter, and the leak scanner.
//
// Nothing here may print real user data. The probe only ever creates its own
// throwaway users, and only their ids/marker strings are ever logged. Tokens,
// PATs, service-role keys and Authorization headers are never printed.

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function loadEnv(envUrl) {
  const env = {};
  const raw = readFileSync(envUrl, "utf8").replace(/^﻿/, "");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

// Config comes from the PROCESS environment. The probe deliberately does NOT
// fall back to ../.env.local: on a normal Mindboard checkout that file holds
// the single live project, so a default that reads it is a default that writes
// to production. MINDBOARD_PROBE_ENV may name a file to load instead, so a
// local-stack config can live in one place without exporting four variables.
export function probeEnv(overrides = process.env) {
  // pathToFileURL, not string concatenation: under Git Bash on Windows $PWD is
  // `/c/Users/…`, and `file:///${that}` yields `file:////c/Users/…`, which does
  // not resolve. Relative paths are resolved against the cwd first so
  // MINDBOARD_PROBE_ENV=.env.local.probe works too.
  const fromFile = overrides.MINDBOARD_PROBE_ENV
    ? loadEnv(pathToFileURL(path.resolve(String(overrides.MINDBOARD_PROBE_ENV))))
    : {};
  // Explicit process env wins over the file, so a one-off override needs no edit.
  const merged = { ...fromFile };
  for (const key of Object.keys(overrides)) {
    if (overrides[key] !== undefined && overrides[key] !== "") merged[key] = overrides[key];
  }
  return merged;
}

// The production project ref. It is NOT a secret — it is the host in
// NEXT_PUBLIC_SUPABASE_URL, which ships in every browser's JS bundle, and it
// already appears in five committed docs. It is hardcoded on purpose: a rail
// that has to be configured before it protects you is not a rail.
// MINDBOARD_PROBE_FORBIDDEN_REFS can add more (comma-separated); nothing can
// remove this one.
export const PRODUCTION_PROJECT_REF = "kdsunzpcjfzkidejtnyp";

export const PROBE_TARGETS = ["local", "branch"];

// The safety rail, called before the probe creates its first auth user.
//
// Two separate refusals, because they catch different mistakes:
//   - the ref check catches "I pointed it at prod", the one unrecoverable one.
//     The probe creates real users and seeds ~45 tables; it deletes them in a
//     `finally`, but a crash mid-run leaves them behind.
//   - the target check catches "I did not think about which database this is".
//     Requiring the word makes the choice deliberate, and the host is then
//     checked AGAINST that word — so `local` pointed at a hosted project is
//     refused even though it is not production.
export function assertSafeTarget(supabaseUrl, target, env = process.env) {
  const url = String(supabaseUrl ?? "");
  if (!url) throw new Error("no Supabase URL to check");

  const extra = String(env.MINDBOARD_PROBE_FORBIDDEN_REFS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const ref of [PRODUCTION_PROJECT_REF, ...extra]) {
    if (url.includes(ref)) {
      throw new Error(
        `the target Supabase URL names the production project (${ref}). ` +
          "This probe creates real auth users and writes to ~45 tables. " +
          "Point it at a local stack (supabase start) or a Supabase branch.",
      );
    }
  }

  if (!PROBE_TARGETS.includes(target)) {
    throw new Error(
      `MINDBOARD_PROBE_TARGET must be one of ${PROBE_TARGETS.join(" | ")} ` +
        `(got ${target === undefined ? "nothing" : JSON.stringify(target)}). ` +
        "Naming the target is how you confirm you know which database this writes to.",
    );
  }

  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`the target Supabase URL is not a URL: ${url}`);
  }

  if (target === "local") {
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
    const privateRange =
      /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (!loopback && !privateRange) {
      throw new Error(
        `MINDBOARD_PROBE_TARGET=local but ${host} is not a local address. ` +
          "Use target=branch for a hosted project.",
      );
    }
  } else if (!/\.supabase\.(co|in)$/.test(host)) {
    throw new Error(
      `MINDBOARD_PROBE_TARGET=branch but ${host} is not a Supabase-hosted project.`,
    );
  }

  return { target, host };
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
