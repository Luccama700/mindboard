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

import ts from "typescript";
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
// WHY THESE ARE STATIC AT ALL. A page that reads an environment variable
// itself, or one that starts reading the owner's folder before the request has
// been checked, is wrong before it ever runs: there is no input that makes it
// fail, so no ordinary test can catch it.
//
// WHY THEY READ A SYNTAX TREE AND NOT TEXT. The first version matched strings,
// and every hole it had was a hole a regex cannot close: a guard mentioned in a
// comment, a page whose props annotation swallowed its own body, a read started
// in the synchronous entry and passed down as a promise, a guard in one function
// with the read in a sibling, `await requireLoopback(x).catch(...)`, a key
// pulled out of `process.env` by destructuring. Each fix was one more regex and
// the next shape walked through anyway. These rules are now stated on the tree
// TypeScript itself parses (`ts.createSourceFile`, no program and no type
// checking), where "this call happens inside that function, after that
// statement" is a fact rather than a guess about word order.
//
// EACH RULE STILL HAS A NEGATIVE TEST. A checker exercised only against code
// that already passes proves nothing about the next page somebody writes, so
// every rule below is also handed a file that breaks exactly that rule.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..");

const sourceOf = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

/**
 * The file, parsed. Parents are kept, because every rule walks upwards.
 *
 * The script kind follows the extension: in a `.ts` file `<string>x` is a cast,
 * and parsed as TSX it is an unclosed tag that swallows the rest of the file.
 */
function parse(file: string, source: string): ts.SourceFile {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** Which module a specifier names, as a repository path, or null for a package. */
function resolvedModule(file: string, specifier: string): string | null {
  const bare = specifier.replace(/\.(ts|tsx|js)$/, "");
  if (bare.startsWith("@/")) return bare.slice(2);
  if (bare.startsWith(".")) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(file), bare));
  }
  return null;
}

/** Every module this file imports from or re-exports, as written. */
function specifiersOf(file: string, source: string): string[] {
  const found: string[] = [];
  walk(parse(file, source), (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
      return;
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const literal = node.argument.literal;
      if (ts.isStringLiteral(literal)) found.push(literal.text);
      return;
    }
    if (!ts.isCallExpression(node) || node.arguments.length === 0) return;
    const callee = node.expression;
    const dynamic =
      callee.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(callee) && callee.text === "require");
    const first = node.arguments[0];
    if (dynamic && ts.isStringLiteral(first)) found.push(first.text);
  });
  return found;
}

// ------------------------------------------------------------------- the gate

/** A page, a route handler, or a file that renders outside the entry. */
type RouteKind = "entry" | "route" | "shell";

/**
 * The files that render for every route under them, or instead of the one the
 * gate refused. None of them may touch data at all.
 */
const SHELL_FILES = [
  "layout",
  "template",
  "default",
  "loading",
  "error",
  "global-error",
  "not-found",
  "forbidden",
  "unauthorized",
];

function routeKind(file: string): RouteKind | null {
  const name = path.posix.basename(file).replace(/\.tsx?$/, "");
  if (name === "page") return "entry";
  if (name === "route") return "route";
  return SHELL_FILES.includes(name) ? "shell" : null;
}

/** The only three variables a v2 route may be built from, and only via the gate. */
const GATE_ENV = ["V2_FIXTURES", "V2_LOCAL_SNAPSHOT", "VERCEL_ENV"];

/** The gate's own environment helpers. A route asks the gate, never these. */
const GATE_HELPERS = ["localSnapshotDir", "fixturesEnabled"];

/** What a route handler exports: these are entries, not helpers. */
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/** The environment has a module spelling as well as a global one. */
const PROCESS_MODULES = ["process", "node:process"];

/** The gate itself, which reads the two environment variables on purpose. */
const GATE_MODULE = "app/lib/v2/source";

/** The folders that read somebody's day. Anything under them is a loader. */
function readsTheFolder(target: string): boolean {
  return target.startsWith("app/lib/v2/local/") || target.startsWith("app/lib/v2/fixtures/");
}

/** The extensionless repository path a file is known by. */
const moduleKey = (file: string) => file.replace(/\.tsx?$/, "");

/**
 * Does an import clause bring a value in, or only a type?
 *
 * A type cannot read anything, so a type only import does not make the importer
 * a way of reaching a loader. `import { type A, b }` brings `b` in, so it does.
 */
function importsAValue(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined || clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true;
  const named = clause.namedBindings;
  if (named === undefined) return false;
  if (ts.isNamespaceImport(named)) return true;
  return named.elements.some((element) => !element.isTypeOnly);
}

/**
 * Every module that can reach a loader, as extensionless repository paths.
 *
 * WHY THIS EXISTS. The rules used to ask whether an import came from under
 * `local/` or `fixtures/`, so a loader reached through a WRAPPER was invisible:
 * a page importing `getWeek` from its own folder, where `getWeek` calls
 * `loadLocalCalendar`, passed every rule, and the wrapper is not a route file so
 * nothing walked it either. A read is a read however many modules it is behind,
 * so the question is now transitive: a module that imports a loader is itself a
 * loader, to a fixed point.
 *
 * Two exclusions, both deliberate. The GATE (`app/lib/v2/source`) reads the two
 * environment variables for a living and is what every page is supposed to ask.
 * And modules already under `local/` or `fixtures/` are matched by the base rule,
 * so marking them again would say nothing.
 */
function dataModulesIn(sources: Map<string, string>): Set<string> {
  const marked = new Set<string>();
  for (;;) {
    let grew = false;
    for (const [file, source] of sources) {
      const key = moduleKey(file);
      if (marked.has(key) || key === GATE_MODULE || readsTheFolder(key)) continue;

      let reaches = false;
      const consider = (specifier: string) => {
        if (reaches) return;
        const target = resolvedModule(file, specifier);
        if (target !== null && (readsTheFolder(target) || marked.has(target))) reaches = true;
      };

      walk(parse(file, source), (node) => {
        if (reaches) return;
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          if (importsAValue(node.importClause)) consider(node.moduleSpecifier.text);
          return;
        }
        if (!ts.isCallExpression(node) || node.arguments.length === 0) return;
        const callee = node.expression;
        const dynamic =
          callee.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(callee) && callee.text === "require");
        const first = node.arguments[0];
        if (dynamic && ts.isStringLiteral(first)) consider(first.text);
      });

      if (reaches) {
        marked.add(key);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return marked;
}

/** Every module of the two v2 trees, by path, for the set above. */
function v2Sources(): Map<string, string> {
  const sources = new Map<string, string>();
  const collect = (dir: string) => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`;
      if (entry.isDirectory()) collect(next);
      else if (/\.tsx?$/.test(entry.name)) sources.set(next, sourceOf(next));
    }
  };
  collect("app/lib/v2");
  collect("app/v2");
  return sources;
}

/** The real tree's answer, computed once. */
const DATA_MODULES = dataModulesIn(v2Sources());

/** Does this specifier name a module that reads somebody's day? */
function isDataModule(file: string, specifier: string, wrappers: Set<string>): boolean {
  const target = resolvedModule(file, specifier);
  if (target === null) return false;
  return readsTheFolder(target) || wrappers.has(target);
}

type FunctionNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

function isFunctionNode(node: ts.Node): node is FunctionNode {
  return (
    ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
  );
}

/** One function the file declares at its top level, by the name it is called by. */
interface TopLevel {
  name: string;
  node: FunctionNode;
  exported: boolean;
  isDefault: boolean;
}

function topLevelFunctions(tree: ts.SourceFile): TopLevel[] {
  const found: TopLevel[] = [];
  for (const statement of tree.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
    const exported = modifiers.some((one) => one.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = modifiers.some((one) => one.kind === ts.SyntaxKind.DefaultKeyword);

    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      found.push({ name: statement.name.text, node: statement, exported, isDefault });
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const { initializer } = declaration;
      if (
        ts.isIdentifier(declaration.name) &&
        initializer !== undefined &&
        isFunctionNode(initializer)
      ) {
        found.push({ name: declaration.name.text, node: initializer, exported, isDefault });
      }
    }
  }
  return found;
}

/**
 * Is this identifier a reference to a value, rather than a name being declared,
 * a property of something else, or a mention in a type?
 *
 * The rules below count any reference to a loader, not only a call on it: a
 * loader put in a variable, passed as an argument, reached through `.call`, or
 * dropped in an array and invoked later is the same read, and each of those
 * walked past a rule that looked for `name(`.
 */
function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;

  const named = parent as { name?: ts.Node };
  if (
    named.name === node &&
    (ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isEnumMember(parent) ||
      ts.isTypeParameterDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isModuleDeclaration(parent))
  ) {
    return false;
  }
  // The property half of `a.b`, and the right half of a qualified type name.
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;

  // A JSX TAG IS NOT A CALL. `<Screen source={source} />` hands React an
  // element and returns; the child's own body runs afterwards, inside its own
  // function, where its own guard sits first. Counting the tag as a read would
  // refuse the one shape this whole gate is built on, and it would refuse it in
  // the entry, where the child is always named. A child called outright,
  // `Screen()`, is a call like any other and is still counted.
  if (
    (ts.isJsxSelfClosingElement(parent) ||
      ts.isJsxOpeningElement(parent) ||
      ts.isJsxClosingElement(parent)) &&
    parent.tagName === node
  ) {
    return false;
  }

  for (let current: ts.Node | undefined = parent; current !== undefined; current = current.parent) {
    if (
      ts.isImportDeclaration(current) ||
      ts.isExportDeclaration(current) ||
      ts.isImportEqualsDeclaration(current) ||
      ts.isImportClause(current)
    ) {
      return false;
    }
    if (ts.isTypeNode(current)) return false;
  }
  return true;
}

/** The names this file can read data through, and what is wrong with how. */
interface Bindings {
  /** Local names that read data. Aliases are the local name. */
  names: Set<string>;
  /** Namespace imports of a data module: a mention of one is a read. */
  namespaces: Set<string>;
  /** The subset that came in through an import, which is what a shell may not do. */
  imported: Set<string>;
  problems: string[];
}

/** Every mention of a loader in this node, and the name it was reached by. */
function readsIn(node: ts.Node, bindings: Bindings): Array<{ node: ts.Node; name: string }> {
  const found: Array<{ node: ts.Node; name: string }> = [];
  walk(node, (child) => {
    if (!ts.isIdentifier(child) || !isValueReference(child)) return;
    const { text } = child;
    if (bindings.namespaces.has(text)) {
      const parent = child.parent;
      const property =
        ts.isPropertyAccessExpression(parent) && parent.expression === child
          ? `.${parent.name.text}`
          : "";
      found.push({ node: child, name: `${text}${property}` });
      return;
    }
    if (bindings.names.has(text)) found.push({ node: child, name: text });
  });
  return found;
}

/**
 * Rule a: every name this file can read somebody's day through.
 *
 * The imports first, by their LOCAL name, so an alias is followed; a namespace
 * import makes every mention of it a read; a dynamic `import()` or `require` of
 * such a module is a finding in itself, because nothing after it can be
 * followed. Then, to a fixed point, every function declared at the top level
 * whose body mentions one of those names: a local helper that reads data is
 * itself a way of reading data, however it is spelled.
 */
function dataBindings(file: string, tree: ts.SourceFile, wrappers: Set<string>): Bindings {
  const bindings: Bindings = {
    names: new Set(),
    namespaces: new Set(),
    imported: new Set(),
    problems: [],
  };

  walk(tree, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!isDataModule(file, node.moduleSpecifier.text, wrappers)) return;
      const clause = node.importClause;
      if (clause === undefined || clause.isTypeOnly) return;
      if (clause.name !== undefined) {
        bindings.names.add(clause.name.text);
        bindings.imported.add(clause.name.text);
      }
      const named = clause.namedBindings;
      if (named === undefined) return;
      if (ts.isNamespaceImport(named)) {
        bindings.namespaces.add(named.name.text);
        bindings.imported.add(named.name.text);
        return;
      }
      for (const element of named.elements) {
        if (element.isTypeOnly) continue;
        bindings.names.add(element.name.text);
        bindings.imported.add(element.name.text);
      }
      return;
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isDataModule(file, node.moduleSpecifier.text, wrappers)
    ) {
      bindings.problems.push(`sends ${node.moduleSpecifier.text} straight out again`);
      return;
    }
    if (!ts.isCallExpression(node) || node.arguments.length === 0) return;
    const callee = node.expression;
    const dynamic =
      callee.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(callee) && callee.text === "require");
    if (!dynamic) return;
    const first = node.arguments[0];
    if (ts.isStringLiteral(first)) {
      if (isDataModule(file, first.text, wrappers)) {
        bindings.problems.push(`loads ${first.text} at run time`);
      }
    } else {
      bindings.problems.push("loads a module nothing can name at run time");
    }
  });

  const locals = topLevelFunctions(tree);
  for (;;) {
    let grew = false;
    for (const local of locals) {
      if (bindings.names.has(local.name)) continue;
      if (readsIn(local.node, bindings).length === 0) continue;
      bindings.names.add(local.name);
      grew = true;
    }
    if (!grew) break;
  }

  return bindings;
}

/**
 * The gate's three names, as THIS file calls them.
 *
 * By origin, not by spelling: `screenSource` and `requireLoopback` are the names
 * imported from the gate and `notFound` the one from next/navigation, each
 * followed through an alias. A local function of the same name, or the same name
 * imported from somewhere that does nothing, is not the gate, and a page built
 * on one was passing every rule while checking nothing.
 */
interface GateNames {
  screenSource: Set<string>;
  requireLoopback: Set<string>;
  notFound: Set<string>;
}

function gateNames(file: string, tree: ts.SourceFile): GateNames {
  const names: GateNames = {
    screenSource: new Set(),
    requireLoopback: new Set(),
    notFound: new Set(),
  };
  walk(tree, (node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    const written = node.moduleSpecifier.text;
    const fromGate = resolvedModule(file, written) === GATE_MODULE;
    const fromNext = written === "next/navigation";
    if (!fromGate && !fromNext) return;
    const clause = node.importClause;
    if (clause === undefined || clause.isTypeOnly) return;
    const named = clause.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) return;
    for (const element of named.elements) {
      if (element.isTypeOnly) continue;
      const original = (element.propertyName ?? element.name).text;
      const local = element.name.text;
      if (fromGate && original === "screenSource") names.screenSource.add(local);
      if (fromGate && original === "requireLoopback") names.requireLoopback.add(local);
      if (fromNext && original === "notFound") names.notFound.add(local);
    }
  });
  return names;
}

/** The functions this node sits inside, nearest first. */
function enclosingFunctions(node: ts.Node): FunctionNode[] {
  const chain: FunctionNode[] = [];
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (isFunctionNode(current)) chain.push(current);
  }
  return chain;
}

function within(node: ts.Node, container: ts.Node): boolean {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (current === container) return true;
  }
  return false;
}

/**
 * Rule c, the guard itself: `await <the gate's requireLoopback>(<one argument>)`
 * as a statement of this function's OWN top-level block, and the end of it.
 *
 * Nothing else counts, and each exclusion is a shape that used to pass. Inside
 * an `if`, a `try` or a loop it is not a statement of the block, so the check
 * may not run at all. `await requireLoopback(x).catch(...)` awaits a member
 * call rather than the check, so a refusal is swallowed and the page renders.
 * Two arguments, or none, is not this function.
 */
function guardEnd(fn: FunctionNode, guards: Set<string>): number | null {
  const { body } = fn;
  if (body === undefined || !ts.isBlock(body)) return null;
  for (const statement of body.statements) {
    if (!ts.isExpressionStatement(statement)) continue;
    const awaited = statement.expression;
    if (!ts.isAwaitExpression(awaited)) continue;
    const call = awaited.expression;
    if (!ts.isCallExpression(call) || call.arguments.length !== 1) continue;
    if (!ts.isIdentifier(call.expression) || !guards.has(call.expression.text)) continue;
    return statement.end;
  }
  return null;
}

function callsOneOf(
  node: ts.Node,
  names: Set<string>,
  before = Number.POSITIVE_INFINITY,
): boolean {
  let found = false;
  walk(node, (child) => {
    if (found || !ts.isCallExpression(child)) return;
    if (!ts.isIdentifier(child.expression) || !names.has(child.expression.text)) return;
    if (child.getStart() < before) found = true;
  });
  return found;
}

/** Is this node inside the argument of the gate's own `screenSource` call? */
function insideScreenSource(node: ts.Node, picks: Set<string>): boolean {
  let child: ts.Node = node;
  for (let parent = node.parent; parent !== undefined; child = parent, parent = parent.parent) {
    if (!ts.isCallExpression(parent)) continue;
    if (!ts.isIdentifier(parent.expression) || !picks.has(parent.expression.text)) continue;
    if (parent.arguments.some((argument) => argument === child)) return true;
  }
  return false;
}

/**
 * Rule d: the environment, which a route may only ever read through the gate.
 *
 * Any mention of `process` is refused unless it is `process.env` inside the
 * argument of the gate's `screenSource(`, naming one of the three keys. Every
 * other shape is a second gate: `process["env"]`, `const { env } = process`,
 * `const p = process`, `globalThis.process`, a destructuring that names a fourth
 * key, the right key read somewhere the gate cannot see, and the module
 * spellings (`node:process` and `process`), which are the same environment by
 * another door.
 */
function processProblems(tree: ts.SourceFile, picks: Set<string>): string[] {
  const found: string[] = [];

  walk(tree, (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      PROCESS_MODULES.includes(node.moduleSpecifier.text)
    ) {
      found.push("reads the environment as a module");
      return;
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression;
      const dynamic =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require");
      const first = node.arguments[0];
      if (dynamic && ts.isStringLiteral(first) && PROCESS_MODULES.includes(first.text)) {
        found.push("reads the environment as a module");
        return;
      }
    }
    // `globalThis.process`, `globalThis["process"]`: the name is not a reference
    // to the identifier, so it is caught here rather than below.
    if (ts.isPropertyAccessExpression(node) && node.name.text === "process") {
      found.push("reads the process object itself");
      return;
    }
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression !== undefined &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "process"
    ) {
      found.push("reads the process object itself");
      return;
    }
    if (!ts.isIdentifier(node) || node.text !== "process") return;

    const parent = node.parent;
    // A property named `process` was handled above; do not count it twice. The
    // module spellings are handled above as well, so their local name is not a
    // second finding here.
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return;
    for (let current: ts.Node | undefined = parent; current !== undefined; current = current.parent) {
      if (ts.isImportDeclaration(current) || ts.isImportClause(current)) return;
    }

    const isEnv =
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === node &&
      parent.name.text === "env";
    if (!isEnv) {
      found.push("reads the process object itself");
      return;
    }

    const env = parent;
    const use = env.parent;
    const complain = (key: string) => {
      if (!GATE_ENV.includes(key)) found.push(`reads process.env.${key} itself`);
      else if (!insideScreenSource(env, picks)) {
        found.push(`reads process.env.${key} outside the screenSource( argument`);
      }
    };

    if (ts.isPropertyAccessExpression(use) && use.expression === env) {
      complain(use.name.text);
      return;
    }
    if (ts.isElementAccessExpression(use) && use.expression === env) {
      const key = use.argumentExpression;
      if (key !== undefined && ts.isStringLiteralLike(key)) complain(key.text);
      else found.push("reads process.env by a computed key");
      return;
    }
    if (
      ts.isVariableDeclaration(use) &&
      use.initializer === env &&
      ts.isObjectBindingPattern(use.name)
    ) {
      const named = use.name.elements.every(
        (element) =>
          element.dotDotDotToken === undefined &&
          GATE_ENV.includes((element.propertyName ?? element.name).getText()),
      );
      if (!named || use.name.elements.length === 0) {
        found.push("reads process.env without naming a key");
      } else if (!insideScreenSource(env, picks)) {
        found.push("reads process.env outside the screenSource( argument");
      }
      return;
    }
    // Passed whole, spread, or assigned: no key is named, so nothing can be
    // checked about what it reads.
    found.push("reads process.env without naming a key");
  });

  return found;
}

/**
 * What is wrong with one route file under app/v2, in plain words.
 *
 * AN ENTRY (`page`) decides what it may show through the gate, synchronously,
 * and answers a real 404 before anything streams, so it may not read data
 * itself: starting a read and passing the promise down is the same thing as
 * reading it, and it starts BEFORE the check has run.
 *
 * EVERY READ waits for the check: a mention of a loader sits in a function whose
 * own block awaited `requireLoopback` first, or in a local helper whose call
 * sites do (that is how a `readFolder` stays legal, wherever in the file it is
 * written), and such a helper is not exported.
 *
 * A ROUTE HANDLER obeys the same rules per exported function, and asks the gate
 * and answers the not-found case before its first read. A SHELL (`layout`,
 * `template`, `default`, `loading`, `error`, and the rest) may not import a
 * loader at all: it renders for every route under it, including the ones the
 * gate refused.
 *
 * `wrappers` is the set of modules that can reach a loader through other
 * modules, which the walk computes from the real tree once. It is an argument so
 * that every case in the suite can stay a source string.
 */
function gateProblems(
  file: string,
  source: string,
  wrappers: Set<string> = DATA_MODULES,
): string[] {
  const kind = routeKind(file);
  if (kind === null) return [];

  const tree = parse(file, source);
  const gate = gateNames(file, tree);
  const bindings = dataBindings(file, tree, wrappers);
  const locals = topLevelFunctions(tree);
  const found: string[] = [...bindings.problems, ...processProblems(tree, gate.screenSource)];

  for (const helper of GATE_HELPERS) {
    let used = false;
    walk(tree, (node) => {
      if (ts.isIdentifier(node) && node.text === helper) used = true;
    });
    if (used) found.push(`reads the gate's own ${helper}`);
  }

  if (kind === "shell") {
    const name = path.posix.basename(file).replace(/\.tsx?$/, "");
    for (const imported of [...bindings.imported].sort()) {
      found.push(`a ${name} must not read data (${imported})`);
    }
    return found;
  }

  const reads = readsIn(tree, bindings);

  /** The helper a function node is, when it is one that reads data. */
  const helperOf = (fn: FunctionNode): TopLevel | null =>
    locals.find(
      (local) => local.node === fn && bindings.names.has(local.name) && !local.isDefault,
    ) ?? null;

  /**
   * Does this read wait for the check?
   *
   * Either it sits in a function that awaited the check first, or it sits in a
   * local helper that is only ever reached from somewhere that did. The second
   * needs at least one call site: a function nothing calls would otherwise
   * satisfy "every call site waits" by having none, and that is exactly the
   * sibling-function shape this rule exists to refuse.
   */
  const waits = (node: ts.Node, seen: Set<string>): boolean => {
    const chain = enclosingFunctions(node);
    if (
      chain.some((fn) => (guardEnd(fn, gate.requireLoopback) ?? Number.POSITIVE_INFINITY) <= node.getStart())
    ) {
      return true;
    }
    const holder = chain[0];
    if (holder === undefined) return false;
    const helper = helperOf(holder);
    if (helper === null || seen.has(helper.name)) return false;
    seen.add(helper.name);

    const sites = reads.filter(
      (read) => read.name === helper.name && !within(read.node, helper.node),
    );
    return sites.length > 0 && sites.every((site) => waits(site.node, new Set(seen)));
  };

  for (const read of reads) {
    if (!waits(read.node, new Set())) {
      found.push(`calls data before awaiting requireLoopback (${read.name})`);
    }
  }

  // A helper that reads data leans on its call sites being checked, so it must
  // not be callable from outside this file, where there are no call sites to
  // check. The file's own entry is not one of those: a page's default export and
  // a route handler's method ARE the thing being entered.
  for (const local of locals) {
    if (!local.exported || local.isDefault) continue;
    if (kind === "route" && HTTP_METHODS.includes(local.name)) continue;
    if (bindings.names.has(local.name)) found.push(`exports the loader ${local.name}`);
  }

  if (kind === "entry") {
    if (!callsOneOf(tree, gate.screenSource)) found.push("does not call screenSource(");
    if (!callsOneOf(tree, gate.requireLoopback)) found.push("does not call requireLoopback(");

    const entry = locals.find((local) => local.isDefault) ?? null;
    if (entry === null) found.push("has no synchronous default export");
    else {
      const modifiers = ts.canHaveModifiers(entry.node) ? (ts.getModifiers(entry.node) ?? []) : [];
      if (
        modifiers.some((one) => one.kind === ts.SyntaxKind.AsyncKeyword) ||
        entry.node.modifiers?.some((one) => one.kind === ts.SyntaxKind.AsyncKeyword)
      ) {
        found.push("has an async default export");
      }
      if (!callsOneOf(entry.node, gate.screenSource)) {
        found.push("does not call screenSource( in its default export");
      }
      if (!callsOneOf(entry.node, gate.notFound)) {
        found.push("does not call notFound() in its default export");
      }
      for (const read of reads) {
        if (within(read.node, entry.node)) {
          found.push(`reads data in its default export (${read.name})`);
        }
      }
    }
  }

  if (kind === "route") {
    for (const local of locals) {
      if (!local.exported) continue;
      const inside = reads.filter((read) => within(read.node, local.node));
      if (inside.length === 0) continue;
      const first = Math.min(...inside.map((read) => read.node.getStart()));
      if (!callsOneOf(local.node, gate.screenSource, first)) {
        found.push(`${local.name} does not call screenSource( before reading data`);
      }
      if (!callsOneOf(local.node, gate.notFound, first)) {
        found.push(`${local.name} does not answer the not-found case before reading data`);
      }
    }
  }

  return found;
}

/** Every file under a folder that renders a route, or renders around one. */
function routeFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const next = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...routeFilesUnder(next));
    else if (routeKind(next) !== null && /\.tsx?$/.test(entry.name)) found.push(next);
  }
  return found;
}

// A read is a read however many modules it is behind. The gate's rules used to
// ask only whether an import came from under local/ or fixtures/, so a loader
// reached through a wrapper was invisible, and the wrapper was not a route file
// so nothing walked it either.
describe("the modules that can reach a loader", () => {
  test("follows a wrapper to a fixed point, and stops at a type", () => {
    const graph = new Map([
      ["app/lib/v2/view/a.ts", 'import { loadLocalToday } from "@/app/lib/v2/local/snapshot";'],
      ["app/lib/v2/view/b.ts", 'import { a } from "./a";'],
      ["app/lib/v2/view/c.ts", 'import type { B } from "./b";'],
    ]);
    expect([...dataModulesIn(graph)].sort()).toEqual([
      "app/lib/v2/view/a",
      "app/lib/v2/view/b",
    ]);
  });

  test("follows a value brought in beside a type, and a run time import", () => {
    const graph = new Map([
      ["app/lib/v2/view/a.ts", 'import { type Day, sampleDay } from "@/app/lib/v2/fixtures/sample-day";'],
      ["app/lib/v2/view/b.ts", 'const { a } = require("./a");'],
      ["app/lib/v2/view/c.ts", 'const later = () => import("./b");'],
    ]);
    expect([...dataModulesIn(graph)].sort()).toEqual([
      "app/lib/v2/view/a",
      "app/lib/v2/view/b",
      "app/lib/v2/view/c",
    ]);
  });

  test("never counts the gate itself, which reads the environment for a living", () => {
    const graph = new Map([
      ["app/lib/v2/source.ts", 'import { localSnapshotDir } from "@/app/lib/v2/local/snapshot";'],
      ["app/v2/x/page.tsx", 'import { screenSource } from "@/app/lib/v2/source";'],
    ]);
    expect([...dataModulesIn(graph)]).toEqual([]);
  });

  test("and says nothing about the loaders themselves, which the base rule has", () => {
    const graph = new Map([
      ["app/lib/v2/local/calendar.ts", 'import { readRules } from "./files";'],
      ["app/lib/v2/fixtures/sample-week.ts", 'import { SAMPLE_DATE } from "./sample-base";'],
    ]);
    expect([...dataModulesIn(graph)]).toEqual([]);
  });

  // What the real tree says today. The first is a fact to keep an eye on; the
  // second is the one that matters: the layers a browser loads, and the view
  // models the pane is built from, must not be able to reach a loader at all.
  test("is only the pages that read, in the tree as it stands", () => {
    expect([...DATA_MODULES]).toContain("app/v2/today/page");
    expect([...DATA_MODULES]).not.toContain(GATE_MODULE);
  });

  test("and reaches no view model, no component and no engine file", () => {
    const shouldNotRead = [...DATA_MODULES].filter((module) =>
      [
        "app/lib/v2/view/",
        "app/lib/v2/calendar/",
        "app/lib/v2/plan/",
        "app/lib/v2/tiles/",
        "app/v2/_components/",
      ].some((folder) => module.startsWith(folder)),
    );
    expect(shouldNotRead).toEqual([]);
  });
});

describe("every v2 route goes through the gate", () => {
  const files = routeFilesUnder("app/v2");

  test("finds the route files at all", () => {
    // An empty walk must not pass for want of looking.
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files).toContain("app/v2/today/page.tsx");
    expect(files).toContain("app/v2/layout.tsx");
  });

  test("and nothing is wrong with any of them", () => {
    for (const file of files) {
      expect(gateProblems(file, sourceOf(file)), file).toEqual([]);
    }
  });

  test("knows every file kind that renders a route or renders around one", () => {
    expect(routeKind("app/v2/week/page.ts")).toBe("entry");
    expect(routeKind("app/v2/api/route.tsx")).toBe("route");
    for (const name of SHELL_FILES) {
      expect(routeKind(`app/v2/${name}.tsx`), name).toBe("shell");
      expect(routeKind(`app/v2/${name}.ts`), name).toBe("shell");
    }
    // Not a route file, so not this checker's business.
    expect(routeKind("app/v2/today/today-client.tsx")).toBeNull();
    expect(routeKind("app/v2/_components/calendar/calendar-pane.tsx")).toBeNull();
  });
});

// The checker, checked. Every case here is a page that passed some earlier
// version of this test while being wrong.
describe("the gate checker catches", () => {
  const complain = (source: string, file = "app/v2/x/page.tsx", wrappers?: Set<string>) =>
    gateProblems(file, source, wrappers).join("; ");

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

  // The text checker's own first bug: a page's props are annotated inline, and
  // the braces of that annotation were read as the whole function body, so a
  // page that does everything right looked like one with no gate in it.
  test("nothing in one whose props are annotated inline either", () => {
    const annotated = GOOD.replace(
      "export default function Page() {",
      "export default function Page(props?: { searchParams?: Promise<Search> }) {",
    );
    expect(complain(annotated)).toBe("");
  });

  // A local helper that reads the folder is legal WHEREVER it is written, as
  // long as every place that calls it has waited for the check. The text
  // checker refused this on the position of the declaration alone, which was
  // never the real question: what matters is that nothing reads before the
  // check, and a hoisted declaration reads nothing by existing.
  test("nothing in one whose folder helper is declared above the check", () => {
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
    expect(complain(source)).toBe("");
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

  // The shape the text checker could never see: the read is STARTED in the
  // synchronous entry and the promise handed down to a child that awaits the
  // check. The guard text comes first in the file and the read runs first in
  // time, which is the whole point of the entry rule.
  test("a read started in the entry and passed down as a promise", () => {
    const source = [
      'import { notFound } from "next/navigation";',
      'import { loadLocalCalendar } from "@/app/lib/v2/local/calendar";',
      'import { requireLoopback, screenSource } from "@/app/lib/v2/source";',
      "async function Screen({ source, week }) {",
      "  await requireLoopback(source);",
      "  return <div>{(await week).week[0]}</div>;",
      "}",
      "export default function Page() {",
      "  const source = screenSource({ V2_FIXTURES: process.env.V2_FIXTURES });",
      "  if (source === null) notFound();",
      "  const week = loadLocalCalendar(source.dir, now, null);",
      "  return <Screen source={source} week={week} />;",
      "}",
    ].join("\n");
    expect(complain(source)).toContain("reads data in its default export (loadLocalCalendar)");
    expect(complain(source)).toContain("calls data before awaiting requireLoopback");
  });

  test("a guard in one function and the read in a sibling", () => {
    const source = [
      'import { notFound } from "next/navigation";',
      'import { sampleDay } from "@/app/lib/v2/fixtures/sample-day";',
      'import { requireLoopback, screenSource } from "@/app/lib/v2/source";',
      "async function check(source) {",
      "  await requireLoopback(source);",
      "}",
      "async function Screen({ source }) {",
      "  await check(source);",
      "  return <div>{sampleDay().notice}</div>;",
      "}",
      "export default function Page() {",
      "  const source = screenSource({ V2_FIXTURES: process.env.V2_FIXTURES });",
      "  if (source === null) notFound();",
      "  return <Screen source={source} />;",
      "}",
    ].join("\n");
    expect(complain(source)).toContain("calls data before awaiting requireLoopback (sampleDay)");
  });

  test("a file reader called straight from the page", () => {
    for (const reader of [
      "readCalendarEvents",
      "readTaskRows",
      "readSnapshotMeta",
      "readRules",
      "readGroupRows",
    ]) {
      const source = [
        'import { notFound } from "next/navigation";',
        `import { ${reader} } from "@/app/lib/v2/local/files";`,
        'import { requireLoopback, screenSource } from "@/app/lib/v2/source";',
        "export default function Page() {",
        "  const source = screenSource({ V2_FIXTURES: process.env.V2_FIXTURES });",
        "  if (source === null) notFound();",
        "  return <Screen source={source} />;",
        "}",
        "async function Screen({ source }) {",
        `  const rows = await ${reader}(source.dir);`,
        "  await requireLoopback(source);",
        "  return <div>{rows.length}</div>;",
        "}",
      ].join("\n");
      expect(complain(source), reader).toContain(
        `calls data before awaiting requireLoopback (${reader})`,
      );
    }
  });

  test("an aliased import, and a namespace one", () => {
    const aliased = GOOD.replace(
      'import { sampleDay } from "@/app/lib/v2/fixtures/sample-day";',
      'import { sampleDay as day } from "@/app/lib/v2/fixtures/sample-day";',
    ).replace("sampleDay().notice", "day().notice");
    expect(complain(aliased)).toBe("");

    const early = aliased.replace(
      "  await requireLoopback(source);",
      "  const it = day();\n  await requireLoopback(source);",
    );
    expect(complain(early)).toContain("calls data before awaiting requireLoopback (day)");

    const namespaced = GOOD.replace(
      'import { sampleDay } from "@/app/lib/v2/fixtures/sample-day";',
      'import * as fixtures from "@/app/lib/v2/fixtures/sample-day";',
    ).replace(
      "  await requireLoopback(source);",
      "  const it = fixtures.sampleDay();\n  await requireLoopback(source);",
    );
    expect(complain(namespaced)).toContain(
      "calls data before awaiting requireLoopback (fixtures.sampleDay)",
    );
  });

  test("a loader pulled in at run time", () => {
    const source = GOOD.replace(
      "  await requireLoopback(source);",
      '  const { sampleWeek } = await import("@/app/lib/v2/fixtures/sample-week");\n  await requireLoopback(source);',
    );
    expect(complain(source)).toContain(
      "loads @/app/lib/v2/fixtures/sample-week at run time",
    );
  });

  // `stripComments` ate the rest of the line after a `//` inside a string, so a
  // read on that line went unseen. A syntax tree knows a string from a comment.
  test("a read hiding on the same line as a string that looks like a comment", () => {
    const source = GOOD.replace(
      "  await requireLoopback(source);",
      '  const where = "https://example.test/day"; const day = sampleDay();\n  await requireLoopback(source);',
    );
    expect(complain(source)).toContain("calls data before awaiting requireLoopback (sampleDay)");
  });

  test("a check whose refusal is swallowed", () => {
    const source = GOOD.replace(
      "  await requireLoopback(source);",
      "  await requireLoopback(source).catch(() => {});",
    );
    expect(complain(source)).toContain("calls data before awaiting requireLoopback");
  });

  test("a check that only sometimes runs", () => {
    for (const guard of [
      "  if (source.kind === 'local') await requireLoopback(source);",
      "  try { await requireLoopback(source); } catch {}",
      "  for (const one of [source]) await requireLoopback(one);",
      "  await Promise.all([requireLoopback(source)]);",
    ]) {
      const source = GOOD.replace("  await requireLoopback(source);", guard);
      expect(complain(source), guard).toContain("calls data before awaiting requireLoopback");
    }
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

  test("a page that exports the helper that reads the folder", () => {
    const source = [
      'import { notFound } from "next/navigation";',
      'import { loadLocalToday } from "@/app/lib/v2/local/snapshot";',
      'import { requireLoopback, screenSource } from "@/app/lib/v2/source";',
      "export async function readFolder(dir) {",
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
    expect(complain(source)).toContain("exports the loader readFolder");
  });

  test("a page that reads the environment itself", () => {
    const source = GOOD.replace(
      "  if (source === null) notFound();",
      "  const mine = process.env.V2_SECRET_FOLDER;\n  if (source === null) notFound();",
    );
    expect(complain(source)).toContain("reads process.env.V2_SECRET_FOLDER itself");
  });

  // The text rule read `process.env.KEY` and nothing else, so each of these
  // walked straight through it.
  test("every other way of getting at the environment", () => {
    const shapes: Array<[string, string]> = [
      [
        // It names an allowed key, and nowhere the gate can see it.
        "  const { V2_LOCAL_SNAPSHOT: dir } = process.env;",
        "reads process.env outside the screenSource( argument",
      ],
      ["  const env = process.env;", "reads process.env without naming a key"],
      ["  const { ...rest } = process.env;", "reads process.env without naming a key"],
      ["  const { env } = process;", "reads the process object itself"],
      ["  const dir = process['env'].V2_LOCAL_SNAPSHOT;", "reads the process object itself"],
      ["  const p = process;", "reads the process object itself"],
      ["  const dir = globalThis.process.env.V2_LOCAL_SNAPSHOT;", "reads the process object itself"],
      [
        "  const dir = process.env.V2_LOCAL_SNAPSHOT;",
        "reads process.env.V2_LOCAL_SNAPSHOT outside the screenSource( argument",
      ],
      ["  const dir = process.env[key];", "reads process.env by a computed key"],
      ['  const dir = process.env["V2_OTHER_FOLDER"];', "reads process.env.V2_OTHER_FOLDER itself"],
    ];
    for (const [line, expected] of shapes) {
      const source = GOOD.replace(
        "  if (source === null) notFound();",
        `${line}\n  if (source === null) notFound();`,
      );
      expect(complain(source), line).toContain(expected);
    }
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

  // The file a parallel slot falls back to. It renders instead of the page the
  // gate refused, so it is the last place a loader may be imported.
  test("a default slot that imports a loader at all", () => {
    const source = [
      'import { loadLocalToday } from "@/app/lib/v2/local/snapshot";',
      "export default function Slot() {",
      "  return <div>{String(loadLocalToday)}</div>;",
      "}",
    ].join("\n");
    expect(complain(source, "app/v2/@pane/default.tsx")).toContain(
      "a default must not read data (loadLocalToday)",
    );
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

  test("the same handler written as a .tsx file", () => {
    const source = [
      'import { sampleWeek } from "@/app/lib/v2/fixtures/sample-week";',
      "export async function GET() {",
      "  return Response.json(sampleWeek(null));",
      "}",
    ].join("\n");
    const problems = complain(source, "app/v2/week/route.tsx");
    expect(problems).toContain("GET does not call screenSource( before reading data");
    expect(problems).toContain("GET does not answer the not-found case before reading data");
    expect(problems).toContain("calls data before awaiting requireLoopback (sampleWeek)");
  });

  // ------------------------------------------------------- round 3: the holes

  // HOLE A, the realistic one. A loader reached through a wrapper that is not
  // itself under local/ or fixtures/ was invisible: the wrapper is not a route
  // file, so nothing walked it, and the page could read through it anywhere,
  // including in the synchronous entry. The set of modules that can reach a
  // loader is now computed from the tree and handed to the checker.
  const WRAPPED = new Set(["app/v2/week/week-data", "app/lib/v2/view/week-data"]);

  const throughWrapper = (specifier: string, where: "entry" | "child") => {
    const read = "  const week = getWeek(source.dir);";
    const lines = [
      'import { notFound } from "next/navigation";',
      `import { getWeek } from "${specifier}";`,
      'import { requireLoopback, screenSource } from "@/app/lib/v2/source";',
      "export default function Page() {",
      "  const source = screenSource({ V2_FIXTURES: process.env.V2_FIXTURES });",
      "  if (source === null) notFound();",
      ...(where === "entry" ? [read] : []),
      "  return <Screen source={source} />;",
      "}",
      "async function Screen({ source }) {",
      ...(where === "child" ? [read] : []),
      "  await requireLoopback(source);",
      "  return <div>{(await week).week[0]}</div>;",
      "}",
    ];
    return lines.join("\n");
  };

  test("a loader reached through a wrapper beside the page", () => {
    const entry = complain(throughWrapper("./week-data", "entry"), "app/v2/week/page.tsx", WRAPPED);
    expect(entry).toContain("reads data in its default export (getWeek)");

    const child = complain(throughWrapper("./week-data", "child"), "app/v2/week/page.tsx", WRAPPED);
    expect(child).toContain("calls data before awaiting requireLoopback (getWeek)");
  });

  test("a loader reached through a wrapper under the view layer", () => {
    const specifier = "@/app/lib/v2/view/week-data";
    const entry = complain(throughWrapper(specifier, "entry"), "app/v2/week/page.tsx", WRAPPED);
    expect(entry).toContain("reads data in its default export (getWeek)");

    const child = complain(throughWrapper(specifier, "child"), "app/v2/week/page.tsx", WRAPPED);
    expect(child).toContain("calls data before awaiting requireLoopback (getWeek)");
  });

  test("and a wrapper nothing has marked is still just a module", () => {
    // The same page, with the set that does not know that module: this is what
    // the checker used to do for every wrapper, and it is why the set exists.
    expect(complain(throughWrapper("./week-data", "entry"), "app/v2/week/page.tsx", new Set()))
      .toBe("");
  });

  // HOLE B. Only a direct call on the binding counted, so every other way of
  // getting at the same function went unseen. Any mention of the name is a read
  // now, wherever it is: what matters is that the value is in hand.
  test("a loader reached without calling it by name", () => {
    const shapes = [
      "  const load = source.kind === 'local' ? loadLocalCalendar : loadLocalCalendar;",
      "  const day = await Promise.resolve().then(loadLocalCalendar);",
      "  const day = loadLocalCalendar.call(null, source.dir);",
      "  const day = [loadLocalCalendar].map((one) => one())[0];",
      "  const all = { read: loadLocalCalendar };",
    ];
    for (const line of shapes) {
      const source = [
        'import { notFound } from "next/navigation";',
        'import { loadLocalCalendar } from "@/app/lib/v2/local/calendar";',
        'import { requireLoopback, screenSource } from "@/app/lib/v2/source";',
        "export default function Page() {",
        "  const source = screenSource({ V2_FIXTURES: process.env.V2_FIXTURES });",
        "  if (source === null) notFound();",
        "  return <Screen source={source} />;",
        "}",
        "async function Screen({ source }) {",
        line,
        "  await requireLoopback(source);",
        "  return <div>{String(day ?? load ?? all)}</div>;",
        "}",
      ].join("\n");
      expect(complain(source), line).toContain(
        "calls data before awaiting requireLoopback (loadLocalCalendar)",
      );
    }
  });

  test("but a type that happens to be named after one is not a read", () => {
    const source = [
      'import { notFound } from "next/navigation";',
      'import type { LocalCalendarEvent } from "@/app/lib/v2/local/files";',
      'import { sampleDay } from "@/app/lib/v2/fixtures/sample-day";',
      'import { requireLoopback, screenSource } from "@/app/lib/v2/source";',
      "export default function Page() {",
      "  const source = screenSource({ V2_FIXTURES: process.env.V2_FIXTURES });",
      "  if (source === null) notFound();",
      "  return <Screen source={source} />;",
      "}",
      "async function Screen({ source }) {",
      "  await requireLoopback(source);",
      "  const rows: LocalCalendarEvent[] = [];",
      "  return <div>{rows.length + sampleDay().lanes.length}</div>;",
      "}",
    ].join("\n");
    expect(complain(source)).toBe("");
  });

  // BY ORIGIN. The three names were matched as words, so a page could satisfy
  // the gate with a local function of the same name, or with one imported from
  // somewhere that does nothing.
  test("a gate name that does not come from the gate", () => {
    const local = GOOD.replace(
      'import { requireLoopback, screenSource } from "@/app/lib/v2/source";',
      "async function requireLoopback(source) {}\nfunction screenSource(env) { return { kind: 'sample' }; }",
    );
    expect(complain(local)).toContain("does not call screenSource(");
    expect(complain(local)).toContain("does not call requireLoopback(");

    const elsewhere = GOOD.replace(
      'import { requireLoopback, screenSource } from "@/app/lib/v2/source";',
      'import { requireLoopback, screenSource } from "./my-own-gate";',
    );
    expect(complain(elsewhere)).toContain("does not call screenSource(");
    expect(complain(elsewhere)).toContain("does not call requireLoopback(");
  });

  test("a not-found that is somebody else's", () => {
    const source = GOOD.replace(
      'import { notFound } from "next/navigation";',
      'import { notFound } from "./my-own-404";',
    );
    expect(complain(source)).toContain("does not call notFound() in its default export");
  });

  test("and the gate's names still count when they are renamed on the way in", () => {
    const renamed = GOOD.replace(
      'import { requireLoopback, screenSource } from "@/app/lib/v2/source";',
      'import { requireLoopback as guard, screenSource as pick } from "@/app/lib/v2/source";',
    )
      .replace("screenSource({", "pick({")
      .replace("await requireLoopback(source);", "await guard(source);");
    expect(complain(renamed)).toBe("");
  });

  // The environment has a module spelling as well as a global one.
  test("the environment imported as a module", () => {
    for (const line of [
      'import { env } from "node:process";',
      'import process from "node:process";',
      'const { env } = require("process");',
    ]) {
      const source = GOOD.replace(
        'import { notFound } from "next/navigation";',
        `${line}\nimport { notFound } from "next/navigation";`,
      );
      expect(complain(source), line).toContain("reads the environment as a module");
    }
  });

  // A `.ts` file has no JSX, so `<string>x` is a cast there. Parsed as TSX it is
  // an unclosed tag, and everything after it is misread.
  test("a handler written as .ts, with an angle bracket cast in it", () => {
    const source = [
      'import { loadLocalToday } from "@/app/lib/v2/local/snapshot";',
      "export async function GET(request) {",
      "  const dir = <string>request.headers.get('x-dir');",
      "  return Response.json(await loadLocalToday(dir, now, null));",
      "}",
    ].join("\n");
    const problems = complain(source, "app/v2/day/route.ts");
    expect(problems).toContain("GET does not call screenSource( before reading data");
    expect(problems).toContain("calls data before awaiting requireLoopback (loadLocalToday)");
  });

  test("nothing in a route handler that asks the gate first", () => {
    const source = [
      'import { notFound } from "next/navigation";',
      'import { sampleWeek } from "@/app/lib/v2/fixtures/sample-week";',
      'import { requireLoopback, screenSource } from "@/app/lib/v2/source";',
      "export async function GET() {",
      "  const source = screenSource({ V2_FIXTURES: process.env.V2_FIXTURES });",
      "  if (source === null) notFound();",
      "  await requireLoopback(source);",
      "  return Response.json(sampleWeek(null));",
      "}",
    ].join("\n");
    expect(complain(source, "app/v2/week/route.ts")).toBe("");
  });
});

// The engine's write half has open defects, so a screen may reach only its two
// pure halves: not ops, not edit, not port, not the fake port, and not the
// barrel index, which pulls all of them in at once.
describe("the calendar engine's boundary", () => {
  const ENGINE = "app/lib/v2/calendar";
  const ALLOWED = [`${ENGINE}/types`, `${ENGINE}/grid`];

  function engineProblems(file: string, source: string): string[] {
    const found: string[] = [];
    for (const specifier of specifiersOf(file, source)) {
      const target = resolvedModule(file, specifier);
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
  const imports = (file: string) => specifiersOf(file, sourceOf(file));

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
