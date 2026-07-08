"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { completeTour } from "@/app/actions/onboarding";
import { IntroCarousel } from "./intro-carousel";
import { TourOverlay } from "./tour-overlay";
import {
  isTourKey,
  routeTourKey,
  TOURS,
  type TourKey,
} from "./tours";

const MIRROR_KEY = "mb-completed-tours";

function readMirror(): TourKey[] {
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isTourKey) : [];
  } catch {
    return [];
  }
}

function writeMirror(keys: Set<TourKey>) {
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify([...keys]));
  } catch {
    // ignore
  }
}

type ActiveTour = { key: Exclude<TourKey, "intro">; startedOn: string };

// The onboarding brain, mounted once in the root layout (dock-mount pattern).
// Owns: the first-run intro carousel, per-route tour auto-start, completion
// persistence (server + a localStorage render-guard mirror), and the ? replay
// button. Navigating away mid-tour cancels without completing; skip completes.
export function OnboardingController({
  initialCompleted,
}: {
  initialCompleted: string[];
}) {
  const pathname = usePathname();
  // The localStorage mirror merges in the lazy initializer: this component is
  // client-only state, and the mirror never changes what the first DOM paint
  // looks like, so there is no hydration hazard.
  const [completed, setCompleted] = useState<Set<TourKey>>(() => {
    const base = new Set(initialCompleted.filter(isTourKey));
    if (typeof window !== "undefined") {
      for (const key of readMirror()) base.add(key);
    }
    return base;
  });
  const [introOpen, setIntroOpen] = useState(false);
  const [active, setActive] = useState<ActiveTour | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // "i'll wander" suppresses the auto-start on the page where the user chose
  // it; the suppression lifts as soon as they navigate.
  const wanderedOn = useRef<string | null>(null);

  // Leaving a page cancels its tour without completing — it re-offers on the
  // next visit (only skip/finish complete). Render-time state adjustment, per
  // the React "adjusting state when a prop changes" pattern.
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    setMenuOpen(false);
    if (active && active.startedOn !== pathname) setActive(null);
  }

  useEffect(() => {
    if (introOpen || active) return;

    if (!completed.has("intro")) {
      if (pathname !== "/") return;
      const timer = window.setTimeout(() => setIntroOpen(true), 500);
      return () => window.clearTimeout(timer);
    }

    const key = routeTourKey(pathname);
    if (!key || key === "intro") return;
    if (completed.has(key) || wanderedOn.current === pathname) return;
    const timer = window.setTimeout(
      () => setActive({ key, startedOn: pathname }),
      600,
    );
    return () => window.clearTimeout(timer);
  }, [pathname, completed, introOpen, active]);

  function markComplete(key: TourKey) {
    setCompleted((prev) => {
      const next = new Set(prev);
      next.add(key);
      writeMirror(next);
      return next;
    });
    void completeTour(key);
  }

  function finishIntro(startTour: boolean) {
    setIntroOpen(false);
    markComplete("intro");
    if (startTour) {
      setActive({ key: "now", startedOn: pathname });
    } else {
      wanderedOn.current = pathname;
    }
  }

  function finishActive() {
    if (active) markComplete(active.key);
    setActive(null);
  }

  const routeKey = routeTourKey(pathname);
  const showHelp = !introOpen && !active && routeKey !== null;

  return (
    <>
      {showHelp && (
        <div className="fixed top-[max(env(safe-area-inset-top),0.5rem)] right-2 z-30 lg:top-1 lg:right-1">
          {menuOpen && pathname === "/" && (
            <div className="absolute right-0 top-full mt-1 w-52 border border-line bg-popover p-2 shadow-[0_0_28px_rgba(0,0,0,0.65)]">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setActive({ key: "now", startedOn: pathname });
                }}
                className="flex min-h-11 w-full items-center px-3 text-action lowercase text-fg hover:bg-card transition-colors"
              >
                tour this screen
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setIntroOpen(true);
                }}
                className="flex min-h-11 w-full items-center px-3 text-action lowercase text-fg hover:bg-card transition-colors"
              >
                replay the full intro
              </button>
            </div>
          )}
          <button
            type="button"
            aria-label="replay this screen's tour"
            onClick={() => {
              if (pathname === "/") {
                setMenuOpen((v) => !v);
              } else if (routeKey && routeKey !== "intro") {
                setActive({ key: routeKey, startedOn: pathname });
              }
            }}
            className="flex h-11 w-11 items-center justify-center text-muted opacity-50 hover:opacity-100 hover:text-fg transition-opacity lg:h-9 lg:w-9"
          >
            <span
              aria-hidden
              className="flex h-6 w-6 items-center justify-center rounded-full border border-line-strong text-meta"
            >
              ?
            </span>
          </button>
        </div>
      )}

      {introOpen && <IntroCarousel onFinish={finishIntro} />}

      {active && (
        <TourOverlay
          key={`${active.key}-${active.startedOn}`}
          steps={TOURS[active.key]}
          onFinish={finishActive}
        />
      )}
    </>
  );
}
