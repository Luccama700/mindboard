// @vitest-environment node
// The one gate every v2 page goes through.
//
// There used to be three checks written out inside app/v2/today/page.tsx. They
// are the same three checks, in one module, because a second page is about to
// need them and two copies of a gate is how one of them comes to be wrong.
//
// WHAT IS PINNED HERE. The order of the two environment checks (the sample
// first, so a preview can always show invented data), that production opens
// neither, that the loopback speed bump guards the snapshot and NOT the sample,
// and that every page under app/v2 asks this module rather than reading the
// variables itself. Nothing here is about what a page then renders.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import {
  isLoopbackHost,
  requireLoopback,
  screenSource,
  type ScreenSource,
} from "@/app/lib/v2/source";
import { isLoopbackHost as reExported } from "@/app/lib/v2/local/snapshot";

// There is no request in a test, so the one header the gate reads is stood in
// for. `sentHost` is what the client claimed to have asked for, and `asked`
// counts the times the gate went looking at all: the sample must not look.
const sentHost = vi.hoisted(() => ({ value: null as string | null, asked: 0 }));
vi.mock("next/headers", () => ({
  headers: () => {
    sentHost.asked += 1;
    return Promise.resolve({
      get: (name: string) => (name.toLowerCase() === "host" ? sentHost.value : null),
    });
  },
}));

/** What `notFound()` throws, as Next spells it (http-access-fallback.js). */
const NOT_FOUND_DIGEST = "NEXT_HTTP_ERROR_FALLBACK;404";

const SAMPLE: ScreenSource = { kind: "sample" };
const LOCAL: ScreenSource = { kind: "local", dir: "/var/data/snapshot" };

/** The error of something that should have answered 404, or a failure. */
async function refusal(run: () => unknown): Promise<{ digest?: unknown; message: string }> {
  try {
    await run();
  } catch (error) {
    return error as { digest?: unknown; message: string };
  }
  throw new Error("it answered when it should not have");
}

describe("screenSource", () => {
  test("is the sample when the fixtures flag is exactly on", () => {
    expect(screenSource({ V2_FIXTURES: "1" })).toEqual({ kind: "sample" });
    expect(screenSource({ V2_FIXTURES: "1", VERCEL_ENV: "preview" })).toEqual({
      kind: "sample",
    });
    expect(screenSource({ V2_FIXTURES: "1", VERCEL_ENV: "development" })).toEqual({
      kind: "sample",
    });
  });

  test("takes nothing else for the flag", () => {
    for (const value of ["", " ", "0", "true", "yes", "on", "1 ", "01"]) {
      expect(screenSource({ V2_FIXTURES: value })).toBeNull();
    }
  });

  test("prefers the sample over a snapshot, as the page did", () => {
    expect(
      screenSource({ V2_FIXTURES: "1", V2_LOCAL_SNAPSHOT: "/var/data/snapshot" }),
    ).toEqual({ kind: "sample" });
  });

  test("falls to the snapshot folder when the flag is off", () => {
    expect(screenSource({ V2_LOCAL_SNAPSHOT: "/var/data/snapshot" })).toEqual({
      kind: "local",
      dir: "/var/data/snapshot",
    });
    expect(
      screenSource({ V2_FIXTURES: "", V2_LOCAL_SNAPSHOT: "C:\\data\\snapshot" }),
    ).toEqual({ kind: "local", dir: "C:\\data\\snapshot" });
    expect(
      screenSource({ V2_LOCAL_SNAPSHOT: "\\\\box\\share\\snapshot" }),
    ).toEqual({ kind: "local", dir: "\\\\box\\share\\snapshot" });
  });

  test("refuses a path that is not absolute, and no path at all", () => {
    for (const dir of ["", "   ", "snapshot", "./snapshot", "../snapshot", "data/snapshot"]) {
      expect(screenSource({ V2_LOCAL_SNAPSHOT: dir })).toBeNull();
    }
    expect(screenSource({})).toBeNull();
  });

  test("opens neither in production, whatever is set", () => {
    expect(
      screenSource({
        V2_FIXTURES: "1",
        V2_LOCAL_SNAPSHOT: "/var/data/snapshot",
        VERCEL_ENV: "production",
      }),
    ).toBeNull();
    expect(
      screenSource({ V2_LOCAL_SNAPSHOT: "C:\\data\\snapshot", VERCEL_ENV: "production" }),
    ).toBeNull();
  });

  test("is pure: the same environment always answers the same way", () => {
    const env = { V2_FIXTURES: "", V2_LOCAL_SNAPSHOT: "/var/data/snapshot" };
    expect(screenSource(env)).toEqual(screenSource(env));
  });
});

// A Host header is the client's own claim, so this is a speed bump and nothing
// more: it turns the accident (a phone on the same network opening the dev URL,
// a scanner walking the subnet) into a 404 and stops nobody who is trying. What
// keeps the folder off the network is binding the server to 127.0.0.1.
describe("requireLoopback", () => {
  test("lets the sample through to any host, and never even asks", async () => {
    for (const host of ["mindboard-git-rebuild-example.vercel.app", "192.168.1.24:3111", null]) {
      sentHost.value = host;
      sentHost.asked = 0;
      await expect(requireLoopback(SAMPLE)).resolves.toBeUndefined();
      expect(sentHost.asked).toBe(0);
    }
  });

  test("serves each spelling of the loopback address in local mode", async () => {
    for (const host of ["localhost:3111", "127.0.0.1:3111", "[::1]:3111", "localhost"]) {
      sentHost.value = host;
      await expect(requireLoopback(LOCAL)).resolves.toBeUndefined();
    }
  });

  test("sends every other host to the not-found page", async () => {
    for (const host of ["192.168.1.24:3111", "10.0.0.5", "example.com", null, ""]) {
      sentHost.value = host;
      expect((await refusal(() => requireLoopback(LOCAL))).digest).toBe(NOT_FOUND_DIGEST);
    }
  });

  test("never repeats the host it refused, in a log or in the answer", async () => {
    const forged = "Host-From-A-Stranger.example.com";
    sentHost.value = forged;
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    try {
      const error = await refusal(() => requireLoopback(LOCAL));
      expect(error.message).not.toContain(forged);
      expect(JSON.stringify(error.digest)).not.toContain(forged);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

// The function moved here from the snapshot loader, which re-exports it so the
// loader's own callers did not have to change. One function, not two.
describe("isLoopbackHost", () => {
  test("is the very same function the snapshot loader exports", () => {
    expect(reExported).toBe(isLoopbackHost);
  });

  test("knows the three spellings, with or without a port", () => {
    for (const host of [
      "localhost",
      "localhost:3111",
      "LOCALHOST:3111",
      "127.0.0.1",
      "127.0.0.1:3111",
      "[::1]",
      "[::1]:3111",
      "::1",
      " localhost:3111 ",
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  test("refuses every other host, and no host at all", () => {
    for (const host of [
      null,
      undefined,
      "",
      "   ",
      "192.168.1.24:3111",
      "0.0.0.0:3111",
      "[::]:3111",
      "[fe80::1]:3111",
      "127.0.0.2:3111",
      "localhost.example.com",
      "notlocalhost",
      "127.0.0.1.example.com",
      "localhost:not-a-port",
    ]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The static guards: one gate, one engine boundary, and no import cycles.
//
// WHY THESE ARE TEXTUAL AT ALL. A page that reads an environment variable
// itself, or a view that reaches into the calendar engine's write half, is wrong
// before it ever runs: there is no input that makes it fail, so no ordinary test
// can catch it.
//
// EACH RULE IS A FUNCTION WITH A NEGATIVE TEST. The first version of this was
// substring matching over the whole file, and it was weak: a page whose comment
// mentioned the gate passed, and so did one that read `process.env` itself. A
// checker tested only against code that already passes proves nothing about the
// next page somebody writes, so every rule below is also handed a file that
// breaks exactly that rule and must complain about it.
//
// Comments are stripped first, because a file that explains at length why it
// does NOT do something would otherwise satisfy a search for the very words it
// is warning about.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..");

const sourceOf = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

/** Source with its comments taken out. Every check below runs on this. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
}

/** The calls that put somebody's day on the screen. */
const DATA_CALLS: RegExp[] = [
  /\bsampleDay\s*\(/,
  /\bsampleWeek\s*\(/,
  /\bloadLocal\w*\s*\(/,
  /\breadFolder\s*\(/,
];

/** The only three variables a v2 route may be built from, and only via the gate. */
const GATE_ENV = ["V2_FIXTURES", "V2_LOCAL_SNAPSHOT", "VERCEL_ENV"];

function firstDataCall(body: string): number {
  let first = -1;
  for (const pattern of DATA_CALLS) {
    const found = body.search(pattern);
    if (found !== -1 && (first === -1 || found < first)) first = found;
  }
  return first;
}

/**
 * The body of `export default function ...`, braces matched, or null.
 *
 * The parameter list is skipped by matching ITS brackets first, because a page's
 * props are annotated inline and that annotation is full of braces: taking the
 * first `{` after the name read `{ searchParams?: Promise<Search> }` as the
 * whole function, and a page that does everything right then looked like one
 * that had never heard of the gate.
 */
function defaultExportBody(body: string): string | null {
  const start = body.indexOf("export default function");
  if (start === -1) return null;
  const paren = body.indexOf("(", start);
  if (paren === -1) return null;
  let brackets = 0;
  let cursor = paren;
  for (; cursor < body.length; cursor += 1) {
    if (body[cursor] === "(") brackets += 1;
    else if (body[cursor] === ")") {
      brackets -= 1;
      if (brackets === 0) break;
    }
  }
  const open = body.indexOf("{", cursor);
  if (open === -1) return null;
  let depth = 0;
  for (let index = open; index < body.length; index += 1) {
    if (body[index] === "{") depth += 1;
    else if (body[index] === "}") {
      depth -= 1;
      if (depth === 0) return body.slice(open, index + 1);
    }
  }
  return null;
}

/** The spans between the brackets of each `call` in this source. */
function argumentRanges(body: string, call: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const at = body.indexOf(call, from);
    if (at === -1) return ranges;
    const open = at + call.length - 1;
    let depth = 0;
    let index = open;
    for (; index < body.length; index += 1) {
      if (body[index] === "(") depth += 1;
      else if (body[index] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    ranges.push([open, index]);
    from = index + 1;
  }
}

/**
 * Every reading of the environment, and whether the gate can see it.
 *
 * TWO RULES, because the first version had only the first and the reviewer's own
 * example walked through it: the key has to be one of the three, AND the reading
 * has to sit inside the argument of `screenSource(`. A page that pulls
 * `V2_LOCAL_SNAPSHOT` out of the environment anywhere else has a second gate in
 * it whatever it does with the value, and a page that destructures
 * `process.env` names no key at all, so nothing can be checked about it.
 */
function envProblems(body: string): string[] {
  const found: string[] = [];
  const allowed = argumentRanges(body, "screenSource(");
  const inside = (at: number) => allowed.some(([open, close]) => at > open && at < close);

  for (const match of body.matchAll(/process\.env/g)) {
    const at = match.index ?? 0;
    const rest = body.slice(at + "process.env".length);
    const named = /^\.([A-Za-z0-9_$]+)/.exec(rest);
    const quoted = /^\[\s*(["'])([^"']*)\1\s*\]/.exec(rest);
    const key = named?.[1] ?? quoted?.[2] ?? null;

    if (key === null) {
      // A computed key cannot be read here, so it is refused rather than
      // guessed at; anything else names nothing at all.
      found.push(
        /^\[/.test(rest)
          ? "reads process.env by a computed key"
          : "reads process.env without naming a key",
      );
    } else if (!GATE_ENV.includes(key)) {
      found.push(`reads process.env.${key} itself`);
    } else if (!inside(at)) {
      found.push(`reads process.env.${key} outside the screenSource( argument`);
    }
  }
  return found;
}

function helperProblems(body: string): string[] {
  return ["localSnapshotDir", "fixturesEnabled"]
    .filter((helper) => body.includes(helper))
    .map((helper) => `reads the gate's own ${helper}`);
}

/**
 * What is wrong with one route file under app/v2, in plain words.
 *
 * A PAGE decides what it may show through the gate, synchronously, and answers a
 * real 404 before anything streams; the loopback check is awaited before any
 * data is touched; and it never reads the environment or the gate's own helpers
 * itself.
 *
 * The ORDER rule holds in every page even though `requireLoopback` is a no-op
 * for the sample: the next page somebody writes learns its shape from this one,
 * and a page whose folder read sits above the check is one edit away from
 * serving a stranger the owner's day.
 *
 * A ROUTE HANDLER obeys the same rules minus the default export. A LAYOUT may
 * not touch data at all: it renders for every route under it, including the ones
 * the gate refused.
 */
function gateProblems(file: string, source: string): string[] {
  const body = stripComments(source);
  const found: string[] = [];
  const data = firstDataCall(body);

  if (file.endsWith("layout.tsx")) {
    if (data !== -1) found.push("a layout must not read data");
    return [...found, ...envProblems(body), ...helperProblems(body)];
  }

  if (!/\bscreenSource\s*\(/.test(body)) found.push("does not call screenSource(");
  if (!/\brequireLoopback\s*\(/.test(body)) found.push("does not call requireLoopback(");

  const guard = body.indexOf("await requireLoopback(");
  if (data !== -1 && (guard === -1 || guard > data)) {
    found.push("calls data before awaiting requireLoopback");
  }

  if (file.endsWith("page.tsx")) {
    if (/export default async function/.test(body)) found.push("has an async default export");
    const entry = defaultExportBody(body);
    if (entry === null) found.push("has no synchronous default export");
    else {
      if (!/\bnotFound\s*\(/.test(entry)) {
        found.push("does not call notFound() in its default export");
      }
      if (!/\bscreenSource\s*\(/.test(entry)) {
        found.push("does not call screenSource( in its default export");
      }
    }
  }

  return [...found, ...envProblems(body), ...helperProblems(body)];
}

/** Every route file under a folder, found by walking it. */
function routeFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const next = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...routeFilesUnder(next));
    else if (["page.tsx", "layout.tsx", "route.ts"].includes(entry.name)) found.push(next);
  }
  return found;
}

describe("every v2 route goes through the gate", () => {
  const files = routeFilesUnder("app/v2");

  test("finds the route files at all", () => {
    expect(files).toContain("app/v2/today/page.tsx");
    expect(files).toContain("app/v2/layout.tsx");
  });

  test("and nothing is wrong with any of them", () => {
    for (const file of files) {
      expect(gateProblems(file, sourceOf(file)), file).toEqual([]);
    }
  });
});

// The checker, checked. Every case here is a page that would have passed the
// substring version of this test while being wrong.
describe("the gate checker catches", () => {
  const complain = (source: string, file = "app/v2/x/page.tsx") =>
    gateProblems(file, source).join("; ");

  const GOOD = [
    'import { notFound } from "next/navigation";',
    'import { sampleDay } from "@/app/lib/v2/fixtures/sample-day";',
    'import { requireLoopback, screenSource } from "@/app/lib/v2/source";',
    "export default function Page() {",
    "  const source = screenSource({",
    "    V2_FIXTURES: process.env.V2_FIXTURES,",
    "    V2_LOCAL_SNAPSHOT: process.env.V2_LOCAL_SNAPSHOT,",
    "    VERCEL_ENV: process.env.VERCEL_ENV,",
    "  });",
    "  if (source === null) notFound();",
    "  return <Screen source={source} />;",
    "}",
    "async function Screen({ source }) {",
    "  await requireLoopback(source);",
    "  return <div>{sampleDay().notice}</div>;",
    "}",
  ].join("\n");

  test("nothing at all in a page that does it right", () => {
    expect(complain(GOOD)).toBe("");
  });

  // The checker's own first bug: a page's props are annotated inline, and the
  // braces of that annotation were read as the whole function body, so a page
  // that does everything right looked like one with no gate in it at all.
  test("nothing in one whose props are annotated inline either", () => {
    const annotated = GOOD.replace(
      "export default function Page() {",
      "export default function Page(props?: { searchParams?: Promise<Search> }) {",
    );
    expect(complain(annotated)).toBe("");
  });

  test("a gate that lives only in a comment", () => {
    const source = [
      "// This page calls screenSource( and requireLoopback( like the others.",
      'import { sampleDay } from "@/app/lib/v2/fixtures/sample-day";',
      "export default function Page() {",
      "  return <Screen data={sampleDay()} />;",
      "}",
    ].join("\n");
    expect(complain(source)).toContain("does not call screenSource(");
    expect(complain(source)).toContain("does not call requireLoopback(");
  });

  test("data read before the loopback check is awaited", () => {
    const source = GOOD.replace(
      "  await requireLoopback(source);",
      "  const day = sampleDay();\n  await requireLoopback(source);",
    );
    expect(complain(source)).toContain("calls data before awaiting requireLoopback");
  });

  test("a helper defined above the check that reads the folder", () => {
    const source = [
      'import { notFound } from "next/navigation";',
      'import { loadLocalToday } from "@/app/lib/v2/local/snapshot";',
      'import { requireLoopback, screenSource } from "@/app/lib/v2/source";',
      "async function readFolder(dir) {",
      "  return loadLocalToday(dir, now, null);",
      "}",
      "export default function Page() {",
      "  const source = screenSource({ V2_FIXTURES: process.env.V2_FIXTURES });",
      "  if (source === null) notFound();",
      "  return <Screen source={source} />;",
      "}",
      "async function Screen({ source }) {",
      "  await requireLoopback(source);",
      "  return <div>{(await readFolder(source.dir)).notice}</div>;",
      "}",
    ].join("\n");
    expect(complain(source)).toContain("calls data before awaiting requireLoopback");
  });

  test("a check that is never awaited", () => {
    const source = GOOD.replace("await requireLoopback(source);", "requireLoopback(source);");
    expect(complain(source)).toContain("calls data before awaiting requireLoopback");
  });

  test("a page that decides the source and then shows it anyway", () => {
    const source = GOOD.replace("  if (source === null) notFound();\n", "");
    expect(complain(source)).toContain("does not call notFound() in its default export");
  });

  test("a 404 that is only reachable after the stream has started", () => {
    const source = GOOD.replace(
      "export default function Page() {",
      "export default async function Page() {",
    );
    expect(complain(source)).toContain("has an async default export");
  });

  test("a page with no default export to speak of", () => {
    expect(complain(GOOD.replace("export default function Page()", "function Page()"))).toContain(
      "has no synchronous default export",
    );
  });

  test("a page whose default export is not the one that decides", () => {
    const source = GOOD.replace(
      "  const source = screenSource({",
      "  const source = outsideTheEntry({",
    ).replace(
      "async function Screen({ source }) {",
      "function outsideTheEntry(env) { return screenSource(env); }\nasync function Screen({ source }) {",
    );
    expect(complain(source)).toContain("does not call screenSource( in its default export");
  });

  test("a page that reads the environment itself", () => {
    const source = GOOD.replace(
      "  if (source === null) notFound();",
      "  const mine = process.env.V2_SECRET_FOLDER;\n  if (source === null) notFound();",
    );
    expect(complain(source)).toContain("reads process.env.V2_SECRET_FOLDER itself");
  });

  // The first version of this rule read `process.env.KEY` and nothing else, so
  // the two shapes below walked straight through it: one never writes a key at
  // all, and the other writes an allowed key somewhere the gate cannot see.
  test("a page that takes the environment apart instead of naming a key", () => {
    for (const line of [
      "  const { V2_LOCAL_SNAPSHOT: dir } = process.env;",
      "  const env = process.env;",
      "  const { ...rest } = process.env;",
    ]) {
      const source = GOOD.replace("  if (source === null) notFound();", `${line}\n  if (source === null) notFound();`);
      expect(complain(source), line).toContain("reads process.env without naming a key");
    }
  });

  test("a page that reads one of the three keys somewhere else", () => {
    const source = GOOD.replace(
      "  if (source === null) notFound();",
      "  const dir = process.env.V2_LOCAL_SNAPSHOT;\n  if (source === null) notFound();",
    );
    expect(complain(source)).toContain(
      "reads process.env.V2_LOCAL_SNAPSHOT outside the screenSource( argument",
    );
  });

  test("a page that reads the environment by a key nothing can read", () => {
    const source = GOOD.replace(
      "  if (source === null) notFound();",
      "  const dir = process.env[key];\n  if (source === null) notFound();",
    );
    expect(complain(source)).toContain("reads process.env by a computed key");
  });

  test("a page that reads the environment by a name in brackets", () => {
    const source = GOOD.replace(
      "  if (source === null) notFound();",
      '  const dir = process.env["V2_OTHER_FOLDER"];\n  if (source === null) notFound();',
    );
    expect(complain(source)).toContain("reads process.env.V2_OTHER_FOLDER itself");
  });

  test("a page that keeps its own copy of the gate's helpers", () => {
    const source = GOOD.replace(
      'import { requireLoopback, screenSource } from "@/app/lib/v2/source";',
      'import { localSnapshotDir } from "@/app/lib/v2/local/snapshot";\nimport { requireLoopback, screenSource } from "@/app/lib/v2/source";',
    );
    expect(complain(source)).toContain("reads the gate's own localSnapshotDir");
  });

  test("a layout that reads data", () => {
    const source = [
      'import { sampleWeek } from "@/app/lib/v2/fixtures/sample-week";',
      "export default function Layout({ children }) {",
      "  return <div data-week={sampleWeek(null).week[0]}>{children}</div>;",
      "}",
    ].join("\n");
    expect(complain(source, "app/v2/layout.tsx")).toContain("a layout must not read data");
  });

  test("a route handler that serves the folder without the gate", () => {
    const source = [
      'import { loadLocalToday } from "@/app/lib/v2/local/snapshot";',
      "export async function GET() {",
      "  return Response.json(await loadLocalToday(process.env.V2_LOCAL_SNAPSHOT, now, null));",
      "}",
    ].join("\n");
    const problems = complain(source, "app/v2/day/route.ts");
    expect(problems).toContain("does not call screenSource(");
    expect(problems).toContain("calls data before awaiting requireLoopback");
    // A route handler has no default export, and is not asked for one.
    expect(problems).not.toContain("default export");
  });
});

// The engine's write half has open defects, so a screen may reach only its two
// pure halves: not ops, not edit, not port, not the fake port, and not the
// barrel index, which pulls all of them in at once.
describe("the calendar engine's boundary", () => {
  const ENGINE = "app/lib/v2/calendar";
  const ALLOWED = [`${ENGINE}/types`, `${ENGINE}/grid`];

  /** Every module specifier a file imports from, however it is spelled. */
  function specifiers(body: string): string[] {
    const found: string[] = [];
    for (const match of body.matchAll(/from\s*["']([^"']+)["']/g)) found.push(match[1]);
    for (const match of body.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      found.push(match[1]);
    }
    for (const match of body.matchAll(/\bimport\s+["']([^"']+)["']/g)) found.push(match[1]);
    return found;
  }

  /** Which module a specifier names, as a repository path, or null for a package. */
  function resolved(file: string, specifier: string): string | null {
    const bare = specifier.replace(/\.(ts|tsx|js)$/, "");
    if (bare.startsWith("@/")) return bare.slice(2);
    if (bare.startsWith(".")) {
      return path.posix.normalize(path.posix.join(path.posix.dirname(file), bare));
    }
    return null;
  }

  function engineProblems(file: string, source: string): string[] {
    const found: string[] = [];
    for (const specifier of specifiers(stripComments(source))) {
      const target = resolved(file, specifier);
      if (target === null) continue;
      if (target !== ENGINE && !target.startsWith(`${ENGINE}/`)) continue;
      if (!ALLOWED.includes(target)) found.push(`imports ${specifier}`);
    }
    return found;
  }

  function modulesUnder(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        // The engine is allowed to know itself.
        if (next !== ENGINE) found.push(...modulesUnder(next));
      } else if (/\.tsx?$/.test(entry.name)) found.push(next);
    }
    return found;
  }

  const modules = [...modulesUnder("app/lib/v2"), ...modulesUnder("app/v2")];

  test("finds the modules at all, and none of them is the engine", () => {
    expect(modules.length).toBeGreaterThan(30);
    expect(modules).toContain("app/lib/v2/view/calendar.ts");
    expect(modules).toContain("app/v2/today/page.tsx");
    expect(modules.filter((file) => file.startsWith(`${ENGINE}/`))).toEqual([]);
  });

  test("nothing outside the engine reaches past its two pure halves", () => {
    for (const file of modules) {
      expect(engineProblems(file, sourceOf(file)), file).toEqual([]);
    }
  });

  test("the checker catches every spelling of the ones that are out", () => {
    const file = "app/lib/v2/view/x.ts";
    for (const specifier of [
      "@/app/lib/v2/calendar",
      "@/app/lib/v2/calendar/index",
      "@/app/lib/v2/calendar/ops",
      "@/app/lib/v2/calendar/edit",
      "@/app/lib/v2/calendar/port",
      "@/app/lib/v2/calendar/fake-port",
      "../calendar/ops",
      "../calendar/index.ts",
      "./../../v2/calendar/edit",
    ]) {
      const problems = engineProblems(file, `import { x } from "${specifier}";`);
      expect(problems, specifier).toEqual([`imports ${specifier}`]);
    }
  });

  test("and lets the two pure halves through, by either spelling", () => {
    const file = "app/lib/v2/view/x.ts";
    for (const specifier of [
      "@/app/lib/v2/calendar/types",
      "@/app/lib/v2/calendar/grid",
      "../calendar/types",
      "../calendar/grid",
    ]) {
      expect(engineProblems(file, `import { x } from "${specifier}";`), specifier).toEqual([]);
    }
  });

  test("and catches a dynamic import, and a type only one", () => {
    expect(
      engineProblems("app/lib/v2/view/x.ts", 'await import("@/app/lib/v2/calendar/ops");'),
    ).toEqual(["imports @/app/lib/v2/calendar/ops"]);
    expect(
      engineProblems(
        "app/lib/v2/view/x.ts",
        'import type { CalendarPort } from "@/app/lib/v2/calendar/port";',
      ),
    ).toEqual(["imports @/app/lib/v2/calendar/port"]);
  });

  test("and is not fooled by a comment, in either direction", () => {
    expect(
      engineProblems(
        "app/lib/v2/view/x.ts",
        '// import { apply } from "@/app/lib/v2/calendar/ops";\nimport { weekOf } from "@/app/lib/v2/calendar/grid";',
      ),
    ).toEqual([]);
  });
});

// Two import cycles were held up by comments for a while: one module imported
// another that imported it back, and nothing but a warning kept a top-level
// const out of the file that would have crashed on whichever side loaded first.
// Both are split now, and these read the import lines so neither can come back.
describe("no import cycles", () => {
  const imports = (file: string) =>
    [...stripComments(sourceOf(file)).matchAll(/from\s*["']([^"']+)["']/g)].map(
      (match) => match[1],
    );

  test("the loopback check is a leaf, and both sides read it from there", () => {
    expect(imports("app/lib/v2/loopback.ts")).toEqual([]);
    expect(imports("app/lib/v2/source.ts")).toContain("@/app/lib/v2/loopback");
    expect(imports("app/lib/v2/local/snapshot.ts")).toContain("@/app/lib/v2/loopback");
  });

  test("the gate reads the folder's rules and the folder never reads the gate", () => {
    expect(imports("app/lib/v2/source.ts")).toContain("@/app/lib/v2/local/snapshot");
    for (const specifier of imports("app/lib/v2/local/snapshot.ts")) {
      expect(specifier, "snapshot.ts").not.toContain("v2/source");
    }
  });

  test("the sample's own constants are a leaf, and the week never reads the day", () => {
    expect(imports("app/lib/v2/fixtures/sample-week.ts")).toContain(
      "@/app/lib/v2/fixtures/sample-base",
    );
    expect(imports("app/lib/v2/fixtures/sample-base.ts")).not.toContain(
      "@/app/lib/v2/fixtures/sample-day",
    );
    for (const specifier of imports("app/lib/v2/fixtures/sample-week.ts")) {
      expect(specifier, "sample-week.ts").not.toContain("fixtures/sample-day");
    }
    expect(imports("app/lib/v2/fixtures/sample-day.ts")).toContain(
      "@/app/lib/v2/fixtures/sample-week",
    );
  });

  test("and nothing a browser loads pulls a server only module in with it", () => {
    for (const file of [
      "app/lib/v2/loopback.ts",
      "app/lib/v2/view/calendar.ts",
      "app/lib/v2/fixtures/sample-base.ts",
      "app/lib/v2/fixtures/sample-week.ts",
    ]) {
      for (const specifier of imports(file)) {
        expect(specifier, file).not.toContain("next/");
        expect(specifier, file).not.toContain("node:");
        expect(specifier, file).not.toContain("v2/local/");
      }
    }
  });
});
