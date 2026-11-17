import { beforeEach, describe, expect, test } from "vitest";
import {
  THEMES,
  appleStatusBarStyle,
  applyPaletteOverrides,
  readStoredPalette,
  readStoredTheme,
  setActiveTheme,
  storePalette,
  syncThemeColor,
} from "@/app/_components/themes";

function resetRoot() {
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
}

describe("theme storage and application", () => {
  beforeEach(() => {
    localStorage.clear();
    resetRoot();
  });

  test("defaults to dark when no valid stored theme exists", () => {
    expect(readStoredTheme()).toBe("dark");

    localStorage.setItem("theme", "not-a-theme");
    expect(readStoredTheme()).toBe("dark");
  });

  test("applies and stores the active theme class", () => {
    setActiveTheme("forest");

    expect(readStoredTheme()).toBe("forest");
    expect(document.documentElement.classList.contains("theme-forest")).toBe(
      true,
    );
    expect(document.documentElement.classList.contains("theme-cream")).toBe(
      false,
    );
  });

  test("reads only valid persisted palette overrides", () => {
    localStorage.setItem(
      "palette-dark",
      JSON.stringify({
        accent: "#abc123",
        bg: "#0d0d0d",
        fg: "invalid",
        unknown: "#ffffff",
      }),
    );

    expect(readStoredPalette("dark")).toEqual({
      bg: "#0D0D0D",
      accent: "#ABC123",
    });
  });

  test("stores, applies, and clears palette overrides", () => {
    storePalette("cream", { accent: "#123456" });
    expect(readStoredPalette("cream")).toEqual({ accent: "#123456" });

    applyPaletteOverrides({ accent: "#123456" });
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe(
      "#123456",
    );

    storePalette("cream", null);
    applyPaletteOverrides(null);

    expect(localStorage.getItem("palette-cream")).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe(
      "",
    );
  });
});

// The installed iOS app draws the clock and battery in white whenever the
// status bar is translucent, so a light page has to ask for the default style
// or the status bar is unreadable.
describe("the status bar style follows the theme", () => {
  test("light pages take the default style, dark pages the translucent one", () => {
    expect(appleStatusBarStyle("cream")).toBe("default");
    expect(appleStatusBarStyle("sand")).toBe("default");
    for (const name of ["dark", "midnight", "forest", "slate"] as const) {
      expect(appleStatusBarStyle(name)).toBe("black-translucent");
    }
  });

  test("every theme with a light page colour is in the default set", () => {
    // Relative luminance of the page colour: anything above mid grey is a
    // page white status bar text cannot be read on.
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const theme of THEMES) {
      const light = luminance(theme.palette.bg) > 0.4;
      expect(appleStatusBarStyle(theme.name), theme.name).toBe(
        light ? "default" : "black-translucent",
      );
    }
  });
});

// The server renders <meta name="theme-color"> from the theme cookie; a theme
// flip or a customised page colour changes the page without a reload.
describe("theme-color follows the live page colour", () => {
  beforeEach(() => {
    localStorage.clear();
    resetRoot();
    document.head
      .querySelectorAll('meta[name="theme-color"]')
      .forEach((meta) => meta.remove());
  });

  function addMeta(content: string) {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = content;
    document.head.appendChild(meta);
    return meta;
  }

  test("rewrites the server's tag to the current --bg", () => {
    const meta = addMeta("#0d0d0d");
    document.documentElement.style.setProperty("--bg", "#F5F0E8");
    syncThemeColor();
    expect(meta.content).toBe("#F5F0E8");
  });

  test("a customised page colour reaches it through applyPaletteOverrides", () => {
    const meta = addMeta("#0d0d0d");
    applyPaletteOverrides({ bg: "#101820" });
    expect(meta.content).toBe("#101820");
  });

  test("creates the tag when the document has none", () => {
    document.documentElement.style.setProperty("--bg", "#0A0E1C");
    syncThemeColor();
    const meta = document.head.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    expect(meta?.content).toBe("#0A0E1C");
  });

  test("leaves the tag alone when no page colour can be read", () => {
    const meta = addMeta("#0d0d0d");
    syncThemeColor();
    expect(meta.content).toBe("#0d0d0d");
  });
});
