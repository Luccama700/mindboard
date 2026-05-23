"use client";

import { useState } from "react";
import Link from "next/link";
import { getTheme, setActiveTheme, type ThemeName } from "./themes";

type Side = Extract<ThemeName, "dark" | "cream">;

const DARK = getTheme("dark").palette;
const CREAM = getTheme("cream").palette;

const PRESETS: Record<Side, {
  bg: string;
  fg: string;
  muted: string;
  accent: string;
  accentText: string;
  border: string;
  outline: string;
}> = {
  dark: {
    bg: DARK.bg,
    fg: DARK.fg,
    muted: DARK.muted,
    accent: DARK.accent,
    accentText: DARK.accent,
    border: DARK.borderStrong,
    outline: DARK.accent,
  },
  cream: {
    bg: CREAM.bg,
    fg: CREAM.fg,
    muted: CREAM.muted,
    accent: CREAM.accent,
    accentText: "#8b6332",
    border: CREAM.borderStrong,
    outline: "#8b6332",
  },
};

export function GetStartedScreen() {
  const [picked, setPicked] = useState<Side | null>(null);

  function pickSide(side: Side) {
    setPicked(side);
    setActiveTheme(side);
  }

  function basisFor(side: Side): string {
    if (picked === null) return "50%";
    return picked === side ? "80%" : "20%";
  }

  return (
    <main className="min-h-screen relative overflow-hidden">
      <div className="absolute inset-0 flex">
        <ThemeHalf
          side="dark"
          isPicked={picked === "dark"}
          isCollapsed={picked === "cream"}
          basis={basisFor("dark")}
          onPick={pickSide}
        />
        <ThemeHalf
          side="cream"
          isPicked={picked === "cream"}
          isCollapsed={picked === "dark"}
          basis={basisFor("cream")}
          onPick={pickSide}
        />
      </div>

      <div
        aria-hidden
        className="absolute top-0 bottom-0 left-1/2 w-px bg-[#1f1f1f] pointer-events-none transition-opacity duration-500"
        style={{ opacity: picked === null ? 1 : 0 }}
      />

      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-2">
        <Link
          href="/login"
          style={{
            backgroundColor: picked === "cream" ? CREAM.accent : DARK.accent,
            color: picked === "cream" ? CREAM.fg : DARK.bg,
          }}
          className="text-sm font-bold tracking-widest uppercase px-8 py-4 hover:opacity-90 transition-opacity shadow-[0_4px_24px_rgba(0,0,0,0.4)]"
        >
          get started →
        </Link>
        <p
          style={{
            color: picked === "cream" ? CREAM.muted : DARK.muted,
            backgroundColor:
              picked === "cream"
                ? "rgba(245,240,232,0.85)"
                : "rgba(13,13,13,0.85)",
          }}
          className="text-[10px] tracking-widest uppercase px-3 py-1.5 transition-colors"
        >
          {picked
            ? `theme: ${picked} · tap the strip to switch`
            : "pick a side or just dive in"}
        </p>
      </div>
    </main>
  );
}

function ThemeHalf({
  side,
  isPicked,
  isCollapsed,
  basis,
  onPick,
}: {
  side: Side;
  isPicked: boolean;
  isCollapsed: boolean;
  basis: string;
  onPick: (side: Side) => void;
}) {
  const p = PRESETS[side];

  return (
    <button
      type="button"
      onClick={() => onPick(side)}
      aria-pressed={isPicked}
      aria-label={`pick ${side} theme`}
      style={{
        backgroundColor: p.bg,
        color: p.fg,
        flexBasis: basis,
        transition: "flex-basis 500ms cubic-bezier(0.4, 0, 0.2, 1)",
      }}
      className="relative overflow-hidden cursor-pointer focus:outline-none flex-shrink-0"
    >
      <div
        style={{
          opacity: isCollapsed ? 0 : 1,
          transition: "opacity 280ms ease-out",
          pointerEvents: isCollapsed ? "none" : "auto",
        }}
        className="absolute inset-0 flex items-center justify-center p-6 lg:p-12"
      >
        <div className="w-full max-w-xs space-y-6">
          <div className="flex items-center justify-between gap-3">
            <p
              style={{ color: p.muted }}
              className="text-xs tracking-widest uppercase"
            >
              {side}
            </p>
            <span
              aria-hidden
              style={{
                borderColor: isPicked ? p.accent : p.border,
                background: isPicked ? p.accent : "transparent",
              }}
              className="inline-block w-4 h-4 border-2 transition-colors"
            />
          </div>
          <h1 className="text-4xl font-bold tracking-tight">mindboard</h1>
          <p
            style={{ color: p.muted }}
            className="text-sm leading-relaxed"
          >
            Track what matters. Ship what ships.
          </p>
          <p
            style={{ color: isPicked ? p.accentText : p.muted }}
            className="text-[10px] tracking-widest uppercase transition-colors"
          >
            {isPicked ? "✓ selected" : "tap to pick"}
          </p>
        </div>
      </div>

      <div
        style={{
          opacity: isCollapsed ? 1 : 0,
          transition: "opacity 280ms ease-out 120ms",
          pointerEvents: isCollapsed ? "auto" : "none",
        }}
        className="absolute inset-0 flex items-center justify-center"
      >
        <div className="flex flex-col items-center gap-3">
          <span
            aria-hidden
            style={{ backgroundColor: p.accent }}
            className="w-2 h-8"
          />
          <span
            style={{ color: p.muted, writingMode: "vertical-rl" }}
            className="text-[10px] tracking-widest uppercase whitespace-nowrap rotate-180"
          >
            switch to {side}
          </span>
        </div>
      </div>
    </button>
  );
}
