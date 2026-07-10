"use client";

import { useEffect } from "react";
import { NEWS } from "./whats-new";

// The patch-notes dropdown, opened from the ※ button next to the ? replay
// button. Pure presentation — the controller owns open state and the
// seen-marker. Renders inside the controller's fixed top-right container.
export function WhatsNewPanel({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-label="what's new"
        className="absolute right-0 top-full mt-1 max-h-[70vh] w-[min(20rem,calc(100vw-1rem))] overflow-y-auto border border-line bg-popover p-3 shadow-[0_0_28px_rgba(0,0,0,0.65)]"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-meta lowercase text-muted">
            what&apos;s new
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="close what's new"
            className="flex h-11 w-11 items-center justify-center text-muted hover:text-fg transition-colors -mr-2 -mt-2"
          >
            ×
          </button>
        </div>
        <ul className="flex flex-col gap-4">
          {NEWS.map((entry) => (
            <li key={entry.id}>
              <div className="text-meta lowercase text-muted">
                {entry.date}
              </div>
              <div className="text-action lowercase text-fg">
                {entry.title}
              </div>
              <ul className="mt-1 flex flex-col gap-1">
                {entry.items.map((item, index) => (
                  <li
                    key={index}
                    className="flex gap-2 text-meta lowercase text-muted"
                  >
                    <span aria-hidden className="text-accent">
                      ·
                    </span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
