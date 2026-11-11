// A plain module under app/lib may not be named after a Next file convention.
//
// WHAT HAPPENED. The tile engine's geometry module was first written as
// `app/lib/v2/tiles/layout.ts`. Next treats a file called `layout` ANYWHERE
// under `app/` as a route layout, folder depth and route segments
// notwithstanding, generates a type validator for it, and checks its exports
// against a layout component. A module that exports functions fails that check,
// so the production build broke on a file that had no route in it:
//
//   .next/types/validator.ts(694,31): error TS2344: Type 'typeof
//   import(".../app/lib/v2/tiles/layout")' does not satisfy the constraint
//   'LayoutConfig<"/lib/v2/tiles">'.
//
// Nothing else catches it: the module type checks on its own, its tests pass,
// and `tsc --noEmit` is clean until a build has generated the validator. So the
// rule is a test instead. It is deliberately a pure function over a list of
// paths, so the rule itself can be checked against made-up paths rather than
// only against whatever the repo happens to contain today.

import { readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

/** The basenames Next claims. A file called any of these is a route file. */
const RESERVED = [
  "page",
  "layout",
  "route",
  "loading",
  "error",
  "global-error",
  "not-found",
  "template",
  "default",
  "forbidden",
  "unauthorized",
];

/** The extensions Next resolves a route file at. */
const EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".mdx"];

/** The tree that holds plain modules, where none of those names belongs. */
const LIB = "app/lib/";

/**
 * Every path in this list that Next would read as a route file. Paths are
 * repo-relative and use forward slashes.
 */
export function reservedFilenames(paths: readonly string[]): string[] {
  return paths.filter((file) => {
    if (!file.startsWith(LIB)) return false;
    const extension = path.extname(file);
    if (!EXTENSIONS.includes(extension)) return false;
    return RESERVED.includes(path.basename(file, extension));
  });
}

function walk(dir: string, prefix: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const here = `${prefix}${entry.name}`;
    if (entry.isDirectory()) walk(path.join(dir, entry.name), `${here}/`, out);
    else out.push(here);
  }
  return out;
}

describe("no plain module is named after a Next file convention", () => {
  test("app/lib holds no route filename", () => {
    const root = path.resolve(__dirname, "..");
    const files = walk(path.join(root, "app", "lib"), LIB, []);
    expect(files.length).toBeGreaterThan(50);
    expect(reservedFilenames(files)).toEqual([]);
  });

  test("the rule catches a reserved name at any depth", () => {
    expect(
      reservedFilenames([
        "app/lib/x/layout.ts",
        "app/lib/x/y/route.tsx",
        "app/lib/page.js",
        "app/lib/a/b/c/not-found.mdx",
        "app/lib/a/global-error.jsx",
        "app/lib/a/default.mjs",
      ]),
    ).toEqual([
      "app/lib/x/layout.ts",
      "app/lib/x/y/route.tsx",
      "app/lib/page.js",
      "app/lib/a/b/c/not-found.mdx",
      "app/lib/a/global-error.jsx",
      "app/lib/a/default.mjs",
    ]);
  });

  test("the rule leaves ordinary names, other trees and other extensions alone", () => {
    expect(
      reservedFilenames([
        "app/lib/x/geometry.ts",
        "app/lib/x/layout-helpers.ts",
        "app/lib/x/pages.ts",
        "app/lib/x/layouts.ts",
        "app/lib/x/my-layout.ts",
        "app/lib/x/layout.css",
        "app/lib/x/layout.json",
        "app/v2/today/page.tsx",
        "app/finance/layout.tsx",
        "__tests__/layout.test.ts",
      ]),
    ).toEqual([]);
  });
});
