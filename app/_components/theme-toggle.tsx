"use client";

import { useSyncExternalStore } from "react";

type Theme = "dark" | "cream";

function subscribe(callback: () => void) {
  if (typeof document === "undefined") return () => {};
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

function getSnapshot(): Theme {
  return document.documentElement.classList.contains("theme-cream")
    ? "cream"
    : "dark";
}

function getServerSnapshot(): Theme {
  return "dark";
}

export function ThemeToggle({ className = "" }: { className?: string }) {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  function toggle() {
    const next: Theme = theme === "dark" ? "cream" : "dark";
    document.documentElement.classList.toggle("theme-cream", next === "cream");
    try {
      localStorage.setItem("theme", next);
    } catch {
      // localStorage unavailable; ignore.
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="toggle theme"
      suppressHydrationWarning
      className={`text-[10px] tracking-widest uppercase px-3 py-2 border border-[#2a2a2a] text-[#6b6b6b] hover:border-[#f5f0e8] hover:text-[#f5f0e8] transition-colors ${className}`}
    >
      {theme === "dark" ? "cream" : "dark"}
    </button>
  );
}
