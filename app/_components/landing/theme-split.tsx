"use client";

import { useState } from "react";
import {
  getTheme,
  setActiveTheme,
  type ThemeName,
} from "../themes";
import { useInView } from "./use-in-view";

type Side = Extract<ThemeName, "dark" | "cream">;

const SIDES: Side[] = ["dark", "cream"];

// The dark/cream "pick a side" moment, upgraded: tapping re-themes the whole
// landing page live (the html theme class swap the app already uses) and
// persists the choice for /login and beyond.
export function ThemeSplit() {
  const { ref, inView } = useInView<HTMLDivElement>();
  const [picked, setPicked] = useState<Side | null>(null);

  return (
    <section className="px-6 py-24">
      <div
        ref={ref}
        className={`max-w-3xl mx-auto landing-reveal ${inView ? "landing-in" : ""}`}
      >
        <p className="text-label uppercase text-muted mb-2 text-center">
          pick a side
        </p>
        <p className="text-title text-fg text-center mb-10">
          your mind, your light.{" "}
          <span className="text-muted">
            (you can repaint every pixel later.)
          </span>
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {SIDES.map((side) => {
            const palette = getTheme(side).palette;
            const isPicked = picked === side;
            return (
              <button
                key={side}
                type="button"
                aria-pressed={isPicked}
                onClick={() => {
                  setPicked(side);
                  setActiveTheme(side);
                }}
                style={{
                  backgroundColor: palette.bg,
                  color: palette.fg,
                  borderColor: isPicked ? palette.accent : palette.borderStrong,
                }}
                className="border-2 p-6 text-left transition-colors cursor-pointer"
              >
                <div className="flex items-center justify-between mb-4">
                  <span
                    className="text-xs tracking-widest uppercase"
                    style={{ color: palette.muted }}
                  >
                    {getTheme(side).label} · {getTheme(side).tagline}
                  </span>
                  <span
                    aria-hidden
                    className="inline-block w-4 h-4 border-2 transition-colors"
                    style={{
                      borderColor: isPicked ? palette.accent : palette.borderStrong,
                      backgroundColor: isPicked ? palette.accent : "transparent",
                    }}
                  />
                </div>
                <p className="text-2xl font-bold tracking-tight mb-3">
                  mindboard
                </p>
                <div className="flex gap-1.5" aria-hidden>
                  {[palette.accent, palette.fg, palette.muted, palette.bgCard].map(
                    (swatch, index) => (
                      <span
                        key={index}
                        className="h-3 w-3"
                        style={{ backgroundColor: swatch }}
                      />
                    ),
                  )}
                </div>
                <p
                  className="mt-4 text-[10px] tracking-widest uppercase"
                  style={{ color: isPicked ? palette.accent : palette.muted }}
                >
                  {isPicked ? "✓ wearing it" : "tap to try it on"}
                </p>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
