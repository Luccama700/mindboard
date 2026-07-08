"use client";

import { useEffect, useRef, useState } from "react";

// Scroll progress (0..1) through a tall "track" element that hosts a sticky
// scene: 0 when the track's top hits the viewport top, 1 when its bottom
// reaches the viewport bottom. rAF-throttled; works in every browser (no
// dependency on CSS animation-timeline, which Firefox still flags).
export function useScrollProgress<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [progress, setProgress] = useState(0);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    function measure() {
      frame.current = null;
      const node = ref.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const scrollable = rect.height - window.innerHeight;
      if (scrollable <= 0) {
        setProgress(1);
        return;
      }
      const raw = -rect.top / scrollable;
      setProgress(Math.min(1, Math.max(0, raw)));
    }

    function schedule() {
      if (frame.current === null) {
        frame.current = window.requestAnimationFrame(measure);
      }
    }

    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame.current !== null) {
        window.cancelAnimationFrame(frame.current);
        // Reset the guard: StrictMode remounts the effect, and a stale
        // frame id here would make schedule() think a measure is always
        // pending — freezing progress at 0 forever (dev-only bug).
        frame.current = null;
      }
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  return { ref, progress };
}
