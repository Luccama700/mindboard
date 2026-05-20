"use client";

import { useEffect } from "react";

const DEFAULT_DARK_ACCENT = "#B5FF3C";
const DEFAULT_CREAM_ACCENT = "#C9A572";

function readStoredAccent(theme: "dark" | "cream") {
  try {
    const key = theme === "cream" ? "accent-cream" : "accent-dark";
    const value = localStorage.getItem(key);
    if (value && /^#[0-9a-fA-F]{6}$/.test(value)) {
      return value.toUpperCase();
    }
  } catch {
    // localStorage unavailable; use the theme default.
  }
  return theme === "cream" ? DEFAULT_CREAM_ACCENT : DEFAULT_DARK_ACCENT;
}

export function ThemeInitializer() {
  useEffect(() => {
    let theme: "dark" | "cream" = "dark";
    try {
      theme = localStorage.getItem("theme") === "cream" ? "cream" : "dark";
    } catch {
      // localStorage unavailable; use dark.
    }

    document.documentElement.classList.toggle(
      "theme-cream",
      theme === "cream",
    );
    document.documentElement.style.setProperty(
      "--accent",
      readStoredAccent(theme),
    );
  }, []);

  return null;
}
