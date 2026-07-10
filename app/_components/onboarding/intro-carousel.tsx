"use client";

import { useEffect, useRef, useState } from "react";
import { INTRO_CARDS } from "./tours";

// The first-run overview: a full-screen scroll story — one snap section per
// card, Football Manager's "map first" idea with momentum instead of a next
// button. Finishing or skipping marks the intro complete; the last section
// offers to chain straight into the dashboard tour.
export function IntroCarousel({
  onFinish,
}: {
  onFinish: (startTour: boolean) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);

  const last = INTRO_CARDS.length - 1;

  function onScroll() {
    const el = scrollerRef.current;
    if (!el) return;
    const next = Math.round(el.scrollTop / el.clientHeight);
    setIndex(Math.min(Math.max(0, next), last));
  }

  function scrollTo(i: number) {
    const el = scrollerRef.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({
      top: i * el.clientHeight,
      behavior: reduced ? "auto" : "smooth",
    });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onFinish(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onFinish]);

  return (
    <div
      className="fixed inset-0 z-[60] bg-page"
      role="dialog"
      aria-label="welcome to mindboard"
    >
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto snap-y snap-mandatory overscroll-contain"
      >
        {INTRO_CARDS.map((card, i) => {
          const active = i === index;
          return (
            <section
              key={i}
              className="relative h-full snap-start flex items-center justify-center overflow-hidden px-6"
            >
              <span
                aria-hidden
                className={`absolute inset-0 flex items-center justify-center text-[17rem] leading-none text-fg select-none pointer-events-none transition-opacity duration-700 ${
                  active ? "opacity-[0.04]" : "opacity-0"
                }`}
              >
                {card.glyph}
              </span>
              <div
                className={`relative max-w-sm w-full transition-all duration-500 ease-signal ${
                  active
                    ? "opacity-100 translate-y-0"
                    : "opacity-0 translate-y-8"
                }`}
              >
                <p className="text-2xl text-accent-ink mb-4" aria-hidden>
                  {card.glyph}
                </p>
                <h2 className="text-2xl font-bold tracking-tight text-fg mb-3">
                  {card.title}
                </h2>
                <p className="text-body text-muted leading-relaxed">
                  {card.body}
                </p>

                {i === last && (
                  <div className="mt-10 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onFinish(true)}
                      className="flex-1 min-h-12 px-4 text-action lowercase font-bold bg-accent text-accent-fg hover:opacity-90 transition-opacity"
                    >
                      show me →
                    </button>
                    <button
                      type="button"
                      onClick={() => onFinish(false)}
                      className="flex-1 min-h-12 px-4 text-action lowercase border border-line-strong text-muted hover:text-fg hover:border-fg transition-colors"
                    >
                      i&apos;ll wander
                    </button>
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between px-5 pt-[max(env(safe-area-inset-top),1.25rem)]">
        <p className="text-label uppercase text-muted">mindboard</p>
        {index < last && (
          <button
            type="button"
            onClick={() => onFinish(false)}
            className="pointer-events-auto min-h-11 px-3 text-action lowercase text-muted hover:text-fg transition-colors"
          >
            skip ✕
          </button>
        )}
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 pb-[max(env(safe-area-inset-bottom),1.25rem)] flex flex-col items-center gap-4">
        <div
          className="pointer-events-auto flex items-center gap-2"
          aria-label={`card ${index + 1} of ${INTRO_CARDS.length}`}
        >
          {INTRO_CARDS.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`go to card ${i + 1}`}
              onClick={() => scrollTo(i)}
              className="flex h-6 items-center"
            >
              <span
                aria-hidden
                className={`h-1.5 transition-all duration-300 ${
                  i === index ? "w-6 bg-accent-ink" : "w-1.5 bg-card-hover"
                }`}
              />
            </button>
          ))}
        </div>
        <p
          className={`text-meta text-muted transition-opacity duration-500 ${
            index === 0 ? "landing-bob opacity-100" : "opacity-0"
          }`}
          aria-hidden
        >
          scroll ▼
        </p>
      </div>
    </div>
  );
}
