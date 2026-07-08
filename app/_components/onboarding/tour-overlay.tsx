"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cardPlacement,
  clampStep,
  isVisibleRect,
  mobilePlacement,
  spotlightRect,
  type Rect,
} from "./tour-geometry";
import type { TourStep } from "./tours";

const CARD_WIDTH = 352;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// The coach-mark renderer for one active tour. Spotlight is a single div
// whose giant box-shadow dims everything around the anchor; a missing or
// hidden anchor (e.g. the desktop-only calendar pane on a phone) degrades to
// a centered card over a plain dim.
export function TourOverlay({
  steps,
  onFinish,
}: {
  steps: TourStep[];
  onFinish: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [spot, setSpot] = useState<Rect | null>(null);
  const [desktop, setDesktop] = useState(false);
  const [keyboardUp, setKeyboardUp] = useState(false);
  const anchorRef = useRef<Element | null>(null);

  const step = steps[clampStep(index, steps.length)];
  const last = index >= steps.length - 1;

  const measure = useCallback(() => {
    const el = anchorRef.current;
    if (!el || !el.isConnected) {
      setSpot(null);
      return;
    }
    const r = el.getBoundingClientRect();
    const rect: Rect = {
      top: r.top,
      left: r.left,
      width: r.width,
      height: r.height,
    };
    if (!isVisibleRect(rect)) {
      setSpot(null);
      return;
    }
    setSpot(
      spotlightRect(rect, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = () => setDesktop(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    anchorRef.current = step.anchor
      ? document.querySelector(`[data-tour="${step.anchor}"]`)
      : null;

    const el = anchorRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      if (isVisibleRect(r)) {
        el.scrollIntoView({
          block: "center",
          behavior: prefersReducedMotion() ? "auto" : "smooth",
        });
      }
    }
    measure();
    // Re-measure once the smooth scroll settles.
    const settle = window.setTimeout(measure, 420);

    window.addEventListener("scroll", measure, { capture: true, passive: true });
    window.addEventListener("resize", measure);
    return () => {
      window.clearTimeout(settle);
      window.removeEventListener("scroll", measure, { capture: true });
      window.removeEventListener("resize", measure);
    };
  }, [step.anchor, measure]);

  // Interactive steps point at text inputs; hide the card while the phone
  // keyboard is up so it never covers what the user is typing.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => setKeyboardUp(window.innerHeight - vv.height > 120);
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onFinish();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onFinish]);

  const viewport =
    typeof window !== "undefined"
      ? { width: window.innerWidth, height: window.innerHeight }
      : { width: 0, height: 0 };

  const cardStyle: React.CSSProperties = {};
  let cardClass =
    "pointer-events-auto fixed border border-line-strong bg-popover p-4 shadow-[0_0_28px_rgba(0,0,0,0.65)] max-h-[70svh] overflow-y-auto";
  if (spot && desktop) {
    const pos = cardPlacement(spot, viewport, CARD_WIDTH, step.placement);
    cardStyle.left = pos.left;
    cardStyle.width = CARD_WIDTH;
    if (pos.kind === "below") {
      cardStyle.top = pos.top;
    } else {
      cardStyle.bottom = pos.bottom;
    }
  } else if (spot) {
    const placement = mobilePlacement(spot, viewport, step.placement);
    cardClass += ` left-4 right-4 ${placement === "top" ? "top-[max(env(safe-area-inset-top),1rem)]" : "bottom-[max(env(safe-area-inset-bottom),1rem)]"}`;
  } else {
    cardClass +=
      " left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(22rem,calc(100vw-2rem))]";
  }

  const reduced = prefersReducedMotion();

  return (
    <div
      className="fixed inset-0 z-50"
      style={{ pointerEvents: step.interactive ? "none" : "auto" }}
      role="dialog"
      aria-label={step.title}
    >
      {spot ? (
        <div
          aria-hidden
          className="pointer-events-none fixed"
          style={{
            top: spot.top,
            left: spot.left,
            width: spot.width,
            height: spot.height,
            borderRadius: 4,
            boxShadow: "0 0 0 100vmax rgba(0,0,0,0.72)",
            transition: reduced
              ? "none"
              : "top 300ms ease, left 300ms ease, width 300ms ease, height 300ms ease",
          }}
        />
      ) : (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 bg-black/70"
        />
      )}

      {!(keyboardUp && step.interactive) && (
        <div className={cardClass} style={cardStyle}>
          <p className="text-label uppercase text-muted mb-2">
            {index + 1}/{steps.length}
          </p>
          <p className="text-body font-bold text-fg mb-1">{step.title}</p>
          <p className="text-body text-muted leading-relaxed mb-4">
            {step.body}
          </p>
          <div className="flex items-center gap-2">
            {index > 0 && (
              <button
                type="button"
                onClick={() => setIndex((i) => clampStep(i - 1, steps.length))}
                className="min-h-11 px-3 text-action lowercase border border-line-strong text-muted hover:text-fg hover:border-fg transition-colors"
              >
                ← back
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                last ? onFinish() : setIndex((i) => clampStep(i + 1, steps.length))
              }
              className="min-h-11 px-4 text-action lowercase font-bold bg-accent text-accent-fg hover:opacity-90 transition-opacity"
            >
              {last ? "done ✓" : "next →"}
            </button>
            {!last && (
              <button
                type="button"
                onClick={onFinish}
                className="min-h-11 px-3 ml-auto text-action lowercase text-muted hover:text-fg transition-colors"
              >
                skip tour
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
