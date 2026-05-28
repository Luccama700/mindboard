import { beforeEach, describe, expect, test } from "vitest";
import {
  applyPaletteOverrides,
  readStoredPalette,
  readStoredTheme,
  setActiveTheme,
  storePalette,
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
