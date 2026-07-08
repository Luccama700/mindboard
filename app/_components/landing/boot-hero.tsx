"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useReducedMotion } from "./use-in-view";

type BootLine = {
  text: string;
  tone: "prompt" | "result" | "found";
  /** Extra ticks to hold after the line finishes typing. */
  pause: number;
};

const LINES: BootLine[] = [
  { text: "> where did i put my life?", tone: "prompt", pause: 24 },
  { text: "searching…", tone: "result", pause: 14 },
  { text: "  4 tasks due · 1 overdue", tone: "result", pause: 6 },
  { text: "  rent hits friday · balance survives: yes", tone: "result", pause: 6 },
  { text: "  milk: 2 days left", tone: "result", pause: 6 },
  { text: "  free today: 14:00–17:30", tone: "result", pause: 6 },
  {
    text: "  that idea you had in the shower: saved",
    tone: "result",
    pause: 16,
  },
  { text: "found it.", tone: "found", pause: 20 },
];

const TICK_MS = 32;

const TONE_CLASS: Record<BootLine["tone"], string> = {
  prompt: "text-fg",
  result: "text-muted",
  found: "text-accent",
};

// One tick ≈ one typed character. Ticks are cumulative across lines so the
// whole boot is a pure function of a single counter — click to fast-forward.
const TOTAL_TICKS = LINES.reduce(
  (sum, line) => sum + line.text.length + line.pause,
  0,
);

function visibleLines(ticks: number): { line: BootLine; chars: number }[] {
  const out: { line: BootLine; chars: number }[] = [];
  let remaining = ticks;
  for (const line of LINES) {
    if (remaining <= 0) break;
    out.push({ line, chars: Math.min(line.text.length, remaining) });
    remaining -= line.text.length + line.pause;
  }
  return out;
}

export function BootHero() {
  const reduced = useReducedMotion();
  const [ticks, setTicks] = useState(0);
  const shown = reduced ? TOTAL_TICKS : ticks;
  const done = shown >= TOTAL_TICKS;

  useEffect(() => {
    if (done) return;
    const timer = window.setInterval(() => {
      setTicks((t) => Math.min(t + 1, TOTAL_TICKS));
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [done]);

  const lines = visibleLines(shown);

  return (
    <section
      className="landing-crt relative min-h-[100svh] flex flex-col cursor-default"
      onClick={() => setTicks(TOTAL_TICKS)}
    >
      <div className="flex items-center justify-between px-6 pt-[max(env(safe-area-inset-top),1.5rem)]">
        <p className="text-label uppercase text-muted">mindboard</p>
        <Link
          href="/login"
          onClick={(e) => e.stopPropagation()}
          className="min-h-11 flex items-center px-2 text-action lowercase text-muted hover:text-fg transition-colors"
        >
          sign in →
        </Link>
      </div>

      <div className="flex-1 flex flex-col justify-center px-6 max-w-2xl mx-auto w-full">
        <div
          className="text-body leading-relaxed min-h-[15rem]"
          aria-label="where did i put my life? searching… found it."
        >
          {lines.map(({ line, chars }, index) => (
            <p
              key={index}
              className={`${TONE_CLASS[line.tone]}${line.tone === "found" ? " landing-glow" : ""}`}
            >
              {line.text.slice(0, chars)}
              {index === lines.length - 1 && !done && (
                <span className="landing-caret text-accent" aria-hidden>
                  ▮
                </span>
              )}
            </p>
          ))}
        </div>

        <div
          className={`mt-10 transition-opacity duration-700 ${
            done ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        >
          <div className={done ? "tour-rise" : undefined}>
            <h1
              className={`text-4xl sm:text-6xl font-bold tracking-tight text-fg ${
                done ? "landing-sweep" : ""
              }`}
            >
              mindboard
            </h1>
            <p className="mt-3 text-body text-muted">
              a board for your mind.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <Link
                href="/login"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex min-h-12 items-center bg-accent text-accent-fg text-sm font-bold px-6 hover:opacity-90 transition-opacity"
              >
                $ get started
                <span className="landing-caret ml-1" aria-hidden>
                  _
                </span>
              </Link>
            </div>
          </div>
        </div>
      </div>

      <div
        className={`pb-[max(env(safe-area-inset-bottom),1.5rem)] flex justify-center transition-opacity duration-700 ${
          done ? "opacity-100" : "opacity-0"
        }`}
      >
        <span className="landing-bob text-muted text-meta" aria-hidden>
          ▼
        </span>
      </div>
    </section>
  );
}
