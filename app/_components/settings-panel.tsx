"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ColorPicker } from "./color-picker";

type Theme = "dark" | "cream";

const DEFAULT_DARK_ACCENT = "#B5FF3C";
const DEFAULT_CREAM_ACCENT = "#C9A572";

function subscribeTheme(callback: () => void) {
  if (typeof document === "undefined") return () => {};
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

function getThemeSnapshot(): Theme {
  return document.documentElement.classList.contains("theme-cream")
    ? "cream"
    : "dark";
}

function getThemeServerSnapshot(): Theme {
  return "dark";
}

function readAccent(theme: Theme): string {
  if (typeof window === "undefined") {
    return theme === "cream" ? DEFAULT_CREAM_ACCENT : DEFAULT_DARK_ACCENT;
  }
  const stored = localStorage.getItem(
    theme === "cream" ? "accent-cream" : "accent-dark",
  );
  if (stored && /^#[0-9a-fA-F]{6}$/.test(stored)) return stored.toUpperCase();
  return theme === "cream" ? DEFAULT_CREAM_ACCENT : DEFAULT_DARK_ACCENT;
}

function applyAccent(color: string) {
  document.documentElement.style.setProperty("--accent", color);
}

export function SettingsPanel() {
  const theme = useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    getThemeServerSnapshot,
  );

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const [darkAccent, setDarkAccent] = useState<string>(() =>
    readAccent("dark"),
  );
  const [creamAccent, setCreamAccent] = useState<string>(() =>
    readAccent("cream"),
  );
  const accent = theme === "cream" ? creamAccent : darkAccent;

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function setTheme(next: Theme) {
    document.documentElement.classList.toggle(
      "theme-cream",
      next === "cream",
    );
    try {
      localStorage.setItem("theme", next);
    } catch {
      // ignore
    }
    applyAccent(next === "cream" ? creamAccent : darkAccent);
  }

  function setAccent(color: string) {
    const upper = color.toUpperCase();
    if (theme === "cream") {
      setCreamAccent(upper);
      try {
        localStorage.setItem("accent-cream", upper);
      } catch {
        // ignore
      }
    } else {
      setDarkAccent(upper);
      try {
        localStorage.setItem("accent-dark", upper);
      } catch {
        // ignore
      }
    }
    applyAccent(upper);
  }

  function resetAccent() {
    setAccent(
      theme === "cream" ? DEFAULT_CREAM_ACCENT : DEFAULT_DARK_ACCENT,
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="settings"
        aria-expanded={open}
        className="text-xs tracking-widest uppercase px-3 py-2 border border-[#f5f0e8] text-[#f5f0e8] hover:bg-[#f5f0e8] hover:text-[#0d0d0d] transition-colors"
      >
        settings
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="settings"
          className="absolute right-0 top-full mt-2 w-72 z-50 border border-[#1f1f1f] bg-[#141414] p-4 space-y-5 shadow-[0_8px_32px_rgba(0,0,0,0.55)]"
        >
          <div>
            <p className="text-[10px] tracking-widest uppercase text-[#6b6b6b] mb-2">
              theme
            </p>
            <div className="grid grid-cols-2 gap-px border border-[#1f1f1f] bg-[#1f1f1f]">
              {(["dark", "cream"] as Theme[]).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setTheme(opt)}
                  className={`min-h-9 text-[10px] tracking-widest uppercase transition-colors ${
                    theme === opt
                      ? "bg-[#b5ff3c] text-[#0d0d0d]"
                      : "bg-[#0d0d0d] text-[#6b6b6b] hover:text-[#f5f0e8]"
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>

          <ColorPicker
            value={accent}
            onChange={setAccent}
            label={`accent · ${theme}`}
          />

          <div className="flex justify-end">
            <button
              type="button"
              onClick={resetAccent}
              className="text-[10px] tracking-widest uppercase text-[#6b6b6b] hover:text-[#f5f0e8] transition-colors py-1.5 px-3"
            >
              reset accent
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
