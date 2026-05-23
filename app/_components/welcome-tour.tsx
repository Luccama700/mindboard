"use client";

import { useSyncExternalStore } from "react";
import { setActiveTheme, type ThemeName } from "./themes";

type Step = "closed" | "theme" | "tip";

const listeners = new Set<() => void>();

function notify() {
  for (const cb of listeners) cb();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): Step {
  try {
    if (localStorage.getItem("tour-seen") === "true") return "closed";
    const hasTheme = localStorage.getItem("theme") !== null;
    return hasTheme ? "tip" : "theme";
  } catch {
    return "closed";
  }
}

function getServerSnapshot(): Step {
  return "closed";
}

export function WelcomeTour() {
  const step = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  function pickTheme(theme: ThemeName) {
    setActiveTheme(theme);
    notify();
  }

  function dismiss() {
    try {
      localStorage.setItem("tour-seen", "true");
    } catch {
      // localStorage unavailable; ignore.
    }
    notify();
  }

  if (step === "closed") return null;

  return (
    <div
      role="dialog"
      aria-label="welcome"
      aria-modal="true"
      className="fixed inset-0 z-[100] flex items-center justify-center p-6"
      style={{ backgroundColor: "rgba(0,0,0,0.7)" }}
    >
      <div className="border border-line bg-card p-6 max-w-md w-full space-y-5">
        {step === "theme" && (
          <>
            <div className="space-y-2">
              <p className="text-[10px] tracking-widest uppercase text-muted">
                welcome
              </p>
              <h2 className="text-2xl font-bold tracking-tight text-fg">
                pick a theme
              </h2>
              <p className="text-sm text-muted leading-relaxed">
                you can switch and customize the accent anytime in settings.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => pickTheme("dark")}
                style={{
                  backgroundColor: "#0d0d0d",
                  color: "#f5f0e8",
                  borderColor: "#2a2a2a",
                }}
                className="border-2 p-6 hover:opacity-90 transition-opacity flex flex-col items-start gap-3 text-left"
              >
                <span
                  style={{ color: "#b5ff3c" }}
                  className="text-[10px] tracking-widest uppercase"
                >
                  dark
                </span>
                <span className="text-base font-bold">terminal calm</span>
              </button>
              <button
                type="button"
                onClick={() => pickTheme("cream")}
                style={{
                  backgroundColor: "#f5f0e8",
                  color: "#2a2620",
                  borderColor: "#beb18f",
                }}
                className="border-2 p-6 hover:opacity-90 transition-opacity flex flex-col items-start gap-3 text-left"
              >
                <span
                  style={{ color: "#8b6332" }}
                  className="text-[10px] tracking-widest uppercase"
                >
                  cream
                </span>
                <span className="text-base font-bold">warm paper</span>
              </button>
            </div>
          </>
        )}
        {step === "tip" && (
          <>
            <div className="space-y-2">
              <p className="text-[10px] tracking-widest uppercase text-muted">
                tip
              </p>
              <h2 className="text-2xl font-bold tracking-tight text-fg">
                make it yours
              </h2>
              <p className="text-sm text-muted leading-relaxed">
                open the{" "}
                <span className="text-fg font-bold">settings</span>{" "}
                button in the top right anytime to swap themes or pick a
                custom accent color.
              </p>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={dismiss}
                className="bg-accent text-accent-fg text-xs font-bold tracking-widest uppercase px-5 py-3 hover:opacity-90 transition-colors"
              >
                got it →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
