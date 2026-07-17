"use client";

import Link from "next/link";
import { useInView } from "./use-in-view";

const LINES = ["this is your mind.", "give it a board."];

export function CloseCta() {
  const { ref, inView } = useInView<HTMLDivElement>();

  return (
    <section className="landing-crt relative px-6 py-32 min-h-[80svh] flex items-center">
      <div ref={ref} className="max-w-2xl mx-auto text-center w-full">
        <div aria-label={LINES.join(" ")}>
          {LINES.map((line, index) => (
            <div key={line} className="overflow-hidden" aria-hidden>
              <p
                className="text-3xl sm:text-5xl font-bold tracking-tight text-fg leading-snug"
                style={{
                  animation: inView
                    ? `landing-mask-rise 700ms var(--ease-signal) ${index * 180}ms both`
                    : "none",
                  transform: inView ? undefined : "translateY(110%)",
                }}
              >
                {line}
              </p>
            </div>
          ))}
        </div>
        <div
          className={`mt-12 landing-reveal ${inView ? "landing-in" : ""}`}
          style={{ transitionDelay: "500ms" }}
        >
          <Link
            href="/login"
            className="inline-flex min-h-12 items-center rounded-full bg-accent text-accent-fg text-sm font-bold px-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] hover:opacity-90 transition-opacity"
          >
            $ continue with google
            <span className="landing-caret ml-1" aria-hidden>
              _
            </span>
          </Link>
          <p className="mt-14 text-meta text-muted">
            built for one person at a time · installs to your home screen ·
            speaks mcp
          </p>
        </div>
      </div>
    </section>
  );
}
