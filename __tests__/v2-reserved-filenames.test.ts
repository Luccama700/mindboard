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

/**
 * The basenames Next claims inside `app/`, read off its own docs in
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/`
 * rather than from memory.
 *
 * The first group is the route files (one doc each in that folder). The second
 * is the metadata files from `01-metadata/`, which are route handlers Next
 * generates a response from: `app-icons.md` gives `icon` and `apple-icon`,
 * `opengraph-image.md` gives `opengraph-image` and `twitter-image`, and
 * `manifest.md`, `robots.md` and `sitemap.md` give the rest. Each of those docs
 * states the code extensions it accepts (`.js`, `.ts`, and `.tsx` for the
 * image ones).
 *
 * `favicon` is deliberately NOT here: app-icons.md says in as many words that
 * you cannot generate a favicon with code, so only an image file by that name
 * means anything and a module could never collide with it.
 *
 * Nor are `proxy`, `instrumentation`, `instrumentation-client` or
 * `mdx-components`: their docs put them in the project root or `src`, at the
 * same level as `app`, so they cannot collide with anything under `app/lib`.
 * `middleware` is the same: its doc says it is deprecated in Next 16 and
 * renamed to `proxy`, with the functionality unchanged.
 */
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
  "icon",
  "apple-icon",
  "opengraph-image",
  "twitter-image",
  "manifest",
  "robots",
  "sitemap",
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

  test("the rule catches a route filename at any depth", () => {
    const bad = [
      "app/lib/x/layout.ts",
      "app/lib/x/y/route.tsx",
      "app/lib/page.js",
      "app/lib/a/b/c/not-found.mdx",
      "app/lib/a/global-error.jsx",
      "app/lib/a/default.mjs",
      "app/lib/a/template.ts",
      "app/lib/a/loading.ts",
      "app/lib/a/error.ts",
      "app/lib/a/forbidden.ts",
      "app/lib/a/unauthorized.ts",
    ];
    expect(reservedFilenames(bad)).toEqual(bad);
  });

  test("the rule catches a metadata filename too", () => {
    const bad = [
      "app/lib/x/icon.ts",
      "app/lib/x/apple-icon.tsx",
      "app/lib/x/opengraph-image.tsx",
      "app/lib/x/twitter-image.tsx",
      "app/lib/x/manifest.ts",
      "app/lib/x/robots.ts",
      "app/lib/y/sitemap.ts",
    ];
    expect(reservedFilenames(bad)).toEqual(bad);
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
        // One near miss per metadata name, so the rule cannot quietly widen
        // into every file with one of those words in it.
        "app/lib/x/icons.ts",
        "app/lib/x/inventory-icon.ts",
        "app/lib/x/apple-icons.ts",
        "app/lib/x/opengraph-images.ts",
        "app/lib/x/twitter-image-url.ts",
        "app/lib/x/manifests.ts",
        "app/lib/x/robots-txt.ts",
        "app/lib/x/sitemaps.ts",
        "app/lib/x/manifest.json",
        // Root level conventions, which live beside `app` and not under it.
        "proxy.ts",
        "instrumentation.ts",
        "mdx-components.tsx",
        // Real route files, which are allowed to be called these things.
        "app/v2/today/page.tsx",
        "app/finance/layout.tsx",
        "app/icon.tsx",
        "__tests__/layout.test.ts",
      ]),
    ).toEqual([]);
  });
});
