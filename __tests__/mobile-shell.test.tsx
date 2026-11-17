// The installed iPhone app is the main way this product is used, and most of
// what makes it sit right on a phone is a handful of load-bearing lines that
// are easy to delete by accident: a safe-area inset, a 44px floor, a bottom
// padding that clears the Dock. None of them fails loudly when it goes; the
// page just starts under the clock or ends under the Dock. These tests pin
// them from the source, because the signed-in pages cannot be rendered here.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import postcss, { type AtRule, type Rule } from "postcss";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

let pathname = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));
vi.mock("@/app/actions/onboarding", () => ({
  completeTour: vi.fn(async () => ({ error: null })),
}));

import { OnboardingController } from "@/app/_components/onboarding/onboarding-controller";
import { TOUR_KEYS } from "@/app/_components/onboarding/tours";

afterEach(cleanup);

const globals = postcss.parse(read("app/globals.css"));

/** Rules at the top level of the sheet or of a media query: not in any @layer. */
function unlayered(media: string | null): Rule[] {
  const out: Rule[] = [];
  globals.each((node) => {
    if (media === null && node.type === "rule") out.push(node);
    if (
      media !== null &&
      node.type === "atrule" &&
      node.name === "media" &&
      node.params.replace(/\s+/g, " ") === media
    ) {
      (node as AtRule).each((inner) => {
        if (inner.type === "rule") out.push(inner);
      });
    }
  });
  return out;
}

function decl(rule: Rule | undefined, prop: string): string | undefined {
  let value: string | undefined;
  rule?.walkDecls(prop, (d) => {
    value = d.value.replace(/\s+/g, " ");
  });
  return value;
}

const flat = (selector: string) => selector.replace(/\s+/g, "");

describe("the shell's frame (globals.css)", () => {
  test("the three frame variables exist and derive from the device insets", () => {
    const root = unlayered(null).filter((r) => r.selector === ":root");
    const find = (prop: string) =>
      root.map((r) => decl(r, prop)).find((v) => v !== undefined);
    expect(find("--safe-top")).toBe("env(safe-area-inset-top, 0px)");
    expect(find("--safe-bottom")).toBe("env(safe-area-inset-bottom, 0px)");
    expect(find("--app-top")).toBe("0px");
    // The Dock's own bottom offset is max(env(safe-area-inset-bottom), 1rem);
    // the footprint has to use the same max() or the two drift apart.
    expect(find("--dock-clear")).toBe(
      "calc(11.25rem + max(var(--safe-bottom), 1rem))",
    );
  });

  test("every signed-in screen absorbs the status bar, with or without the chrome row", () => {
    const rules = unlayered(null);
    const shell = rules.find((r) => r.selector === "body:has([data-app-shell])");
    const chrome = rules.find((r) => r.selector === "body:has([data-chrome-top])");
    expect(decl(shell, "--app-top")).toBe("var(--safe-top)");
    expect(decl(shell, "padding-top")).toBe("var(--app-top)");
    expect(decl(chrome, "--app-top")).toBe(
      "calc(var(--safe-top) + var(--chrome-top))",
    );
    expect(decl(chrome, "padding-top")).toBe("var(--app-top)");
    // Order matters: same specificity, so the row's rule must come second.
    expect(rules.indexOf(chrome!)).toBeGreaterThan(rules.indexOf(shell!));
  });

  test("the status bar scrim is exactly as tall as the inset", () => {
    const scrim = unlayered(null).find((r) => r.selector === ".status-scrim");
    expect(decl(scrim, "position")).toBe("fixed");
    expect(decl(scrim, "height")).toBe("var(--safe-top)");
    expect(decl(scrim, "pointer-events")).toBe("none");
  });

  test("the home indicator fade never takes a tap and sits under the Dock", () => {
    const fade = unlayered(null).find((r) => r.selector === ".dock-fade");
    expect(decl(fade, "pointer-events")).toBe("none");
    // The Dock is z-40.
    expect(Number(decl(fade, "z-index"))).toBeLessThan(40);
  });
});

describe("touch floors (globals.css, pointer: coarse)", () => {
  const coarse = unlayered("(pointer: coarse)");

  test("there is an unlayered coarse-pointer block at all", () => {
    // Unlayered is the point: control sizes come from Tailwind utilities, and
    // only unlayered CSS beats @layer utilities without !important.
    expect(coarse.length).toBeGreaterThan(0);
  });

  test("no focused control is under 16px, so iOS never zooms the page", () => {
    const rule = coarse.find((r) => decl(r, "font-size") === "max(16px, 1em)");
    expect(rule).toBeDefined();
    expect(flat(rule!.selector)).toContain(":is(input,select,textarea)");
  });

  test("text fields and selects are 44px tall", () => {
    const rule = coarse.find((r) => decl(r, "min-height") === "44px");
    expect(rule).toBeDefined();
    const selectors = rule!.selectors.map(flat);
    expect(selectors.some((s) => s.startsWith("input"))).toBe(true);
    expect(selectors.some((s) => s.startsWith("select"))).toBe(true);
    // Toggles and sliders keep their own size, and a visually hidden input
    // stays hidden.
    const input = selectors.find((s) => s.startsWith("input"))!;
    for (const type of ["checkbox", "radio", "range"]) {
      expect(input).toContain(`:not([type="${type}"])`);
    }
    expect(input).toContain(":not(.sr-only)");
  });

  test("the label role and the dense calendar type are lifted on a phone", () => {
    const eleven = coarse.find((r) => decl(r, "font-size") === "11px");
    const ten = coarse.find((r) => decl(r, "font-size") === "10px");
    expect(eleven?.selectors).toEqual(
      expect.arrayContaining([".text-label", ".text-\\[10px\\]"]),
    );
    expect(ten?.selectors).toEqual(expect.arrayContaining([".text-\\[9px\\]"]));
  });
});

describe("the Dock never covers the last content", () => {
  function pages(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        // The v2 screens and the landing have their own frames and no Dock.
        if (["v2", "landing", "login", "auth", "api"].includes(name)) continue;
        out.push(...pages(full));
      } else if (/^(page|loading|not-found)\.tsx$/.test(name)) {
        out.push(full);
      }
    }
    return out;
  }

  const mains = pages(path.join(ROOT, "app")).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [...source.matchAll(/<main\s+className="([^"]*)"/g)].map((m) => ({
      file: path.relative(ROOT, file),
      classes: m[1].split(/\s+/),
    }));
  });

  test("the scan finds the signed-in pages", () => {
    expect(mains.length).toBeGreaterThan(20);
  });

  test("every scrolling page reserves pb-64 under its content", () => {
    // pb-64 is 256px. The Dock at rest is 180px tall and floats
    // max(inset, 16px) above the screen edge: 214px on a phone with a home
    // indicator. A page with less (this was /approvals, at pb-40 = 160px)
    // ends with its last rows behind the Dock and no way to scroll them out.
    const short = mains
      .filter((m) => m.classes.includes("min-h-screen"))
      .filter((m) => !m.classes.includes("pb-64"))
      .map((m) => m.file);
    expect(short).toEqual([]);
  });

  test("a full-height page gives the shell's top band back", () => {
    const full = mains.filter((m) =>
      m.classes.some((c) => c === "h-dvh" || c === "h-screen"),
    );
    expect(full.map((m) => m.file)).toEqual([]);
  });
});

describe("the shell markers (onboarding controller)", () => {
  function shell(route: string) {
    pathname = route;
    const { container } = render(
      <OnboardingController initialCompleted={[...TOUR_KEYS]} />,
    );
    return {
      app: container.querySelector("[data-app-shell]"),
      row: container.querySelector("[data-chrome-top]"),
      scrim: container.querySelector("[data-status-scrim]"),
    };
  }

  test("a screen with a chrome row carries both markers and the scrim", () => {
    const { app, row, scrim } = shell("/tasks");
    expect(app).not.toBeNull();
    expect(row).not.toBeNull();
    expect(scrim?.className).toContain("status-scrim");
    expect(scrim?.getAttribute("aria-hidden")).toBe("true");
  });

  test.each(["/settings", "/mindspace", "/approvals"])(
    "%s has no chrome row and still absorbs the status bar",
    (route) => {
      const { app, row, scrim } = shell(route);
      expect(row).toBeNull();
      expect(app).not.toBeNull();
      expect(scrim).not.toBeNull();
    },
  );
});

describe("the installed app", () => {
  test("the manifest pins its identity and scope", () => {
    const manifest = JSON.parse(read("public/manifest.webmanifest"));
    expect(manifest.display).toBe("standalone");
    expect(manifest.id).toBe("/");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
  });

  test("the v2 screens hide the old shell's new pieces along with the Dock", () => {
    const sheet = read("app/v2/v2.css");
    for (const marker of ["data-capture-dock", "data-dock-fade", "data-status-scrim", "data-chrome-top"]) {
      expect(sheet).toContain(`body:has([data-v2-root]) [${marker}]`);
    }
  });

  test("the v2 phone frame takes both insets", () => {
    const sheet = postcss.parse(read("app/v2/v2.css"));
    let top: string | undefined;
    let bottom: string | undefined;
    sheet.walkAtRules("media", (media) => {
      if (media.params !== "(max-width: 1023.98px)") return;
      media.walkRules("[data-v2-root] .v2-shell", (rule) => {
        top = decl(rule, "padding-top") ?? top;
        bottom = decl(rule, "padding-bottom") ?? bottom;
      });
    });
    expect(top).toBe("env(safe-area-inset-top)");
    expect(bottom).toBe("calc(92px + env(safe-area-inset-bottom))");
  });

  test("the v2 week pane starts below the status bar", () => {
    const sheet = postcss.parse(read("app/v2/calendar.css"));
    let padding: string | undefined;
    sheet.walkRules("[data-v2-root] .v2-week", (rule) => {
      if (rule.parent?.type !== "root") return;
      padding = decl(rule, "padding") ?? padding;
    });
    expect(padding).toContain("env(safe-area-inset-top)");
    expect(padding).toContain("env(safe-area-inset-bottom)");
  });
});
