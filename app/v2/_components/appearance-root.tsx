"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";

import {
  APPEARANCE_COPY,
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  parseAppearance,
  resolveAppearance,
  tokensFor,
  type Appearance,
} from "@/app/lib/v2/view/appearance";
import { AppearancePanel } from "./appearance-panel";

/**
 * The scheme, for anything under it that needs a colour computed rather than a
 * class: the stops, whose identity colours are the user's own data and have to
 * be lifted until they read on whatever scheme is on.
 */
interface AppearanceHandle {
  appearance: Appearance;
  tokens: Record<string, string>;
  choose: (next: Appearance) => void;
  /** Opens the panel, remembering which control did it so focus can go back. */
  openPanel: (trigger: HTMLElement | null) => void;
}

/**
 * Black and purple, with both actions inert.
 *
 * It is a real default rather than a thrown error on purpose: the screen renders
 * in tests (and could render in a story) without this provider, and a palette
 * that works without a provider is one less way for the page to come up blank.
 */
const FALLBACK: AppearanceHandle = {
  appearance: DEFAULT_APPEARANCE,
  tokens: tokensFor(DEFAULT_APPEARANCE),
  choose: () => {},
  openPanel: () => {},
};

const AppearanceContext = createContext<AppearanceHandle>(FALLBACK);

export function useAppearance(): AppearanceHandle {
  return useContext(AppearanceContext);
}

/**
 * The stored choice, as an external store.
 *
 * It is a store rather than a piece of state seeded in an effect so that the
 * snapshot React hydrates with (`serverSnapshot`) is the one the server
 * rendered, and the browser's own value arrives as a store change immediately
 * after. That is the same "applied after hydration" behaviour
 * app/_components/theme-initializer.tsx has, without an effect that calls
 * setState during the first commit.
 *
 * `read` caches, because useSyncExternalStore needs the same reference back
 * until the value actually changes. parseAppearance returns DEFAULT_APPEARANCE
 * itself when there is nothing stored, so the common case is reference equal to
 * the server snapshot and causes no second render at all.
 */
let cached: Appearance | null = null;
const listeners = new Set<() => void>();

function read(): Appearance {
  if (cached !== null) return cached;
  if (typeof window === "undefined") return DEFAULT_APPEARANCE;
  try {
    cached = parseAppearance(window.localStorage.getItem(APPEARANCE_STORAGE_KEY));
  } catch {
    // Private mode, blocked site data, a disabled storage API: the page works
    // without it and shows the default.
    cached = DEFAULT_APPEARANCE;
  }
  return cached;
}

/** What the server rendered, so hydration has nothing to disagree about. */
function serverSnapshot(): Appearance {
  return DEFAULT_APPEARANCE;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function write(next: Appearance): void {
  cached = next;
  try {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Nothing to do and nothing to say: the choice still applies to this page.
  }
  for (const listener of listeners) listener();
}

/**
 * The v2 root element, and the scheme on it.
 *
 * WHY THE TOKENS ARE INLINE AND IN THE STYLESHEET BOTH. The stylesheet declares
 * the black and purple tokens on `[data-v2-root]`, so the very first paint is
 * already right even before any script has run. This component then writes the
 * same ten tokens inline, which is what a chosen scheme changes. For a user who
 * has chosen nothing the two agree exactly (a test asserts it), so there is
 * nothing to flash.
 *
 * The stored choice is applied AFTER HYDRATION, through the store above: the
 * server and the hydrating client both see the default, and the browser's own
 * value arrives as a store change straight after. Reading it during the first
 * client render instead would make that render disagree with the server's HTML,
 * which is a hydration mismatch rather than a saved frame. So a user who has
 * chosen Paper sees one frame of black and purple; a user who has chosen
 * nothing sees no change at all, which is the case the brief guards.
 */
export function AppearanceRoot({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const appearance = useSyncExternalStore(subscribe, read, serverSnapshot);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);

  const choose = useCallback((next: Appearance) => {
    write(next);
  }, []);

  const openPanel = useCallback((trigger: HTMLElement | null) => {
    opener.current = trigger;
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    // The control that opened the panel is still mounted (one in the rail, one
    // in the phone header), so focus goes back to whichever one it was.
    opener.current?.focus();
  }, []);

  const tokens = useMemo(() => tokensFor(appearance), [appearance]);
  const handle = useMemo<AppearanceHandle>(
    () => ({ appearance, tokens, choose, openPanel }),
    [appearance, tokens, choose, openPanel],
  );

  return (
    <div
      data-v2-root
      // Always present and always in step with the choice: a built-in scheme's
      // id, or "custom" for a pair the user picked. It is `data-v2-scheme`, with
      // the same v2- prefix every class and token on this screen carries.
      data-v2-scheme={appearance.schemeId}
      className={className}
      style={tokens as CSSProperties}
    >
      <AppearanceContext.Provider value={handle}>
        {children}
        {open && (
          <AppearancePanel appearance={appearance} onChoose={choose} onClose={close} />
        )}
      </AppearanceContext.Provider>
    </div>
  );
}

/**
 * The control that opens the panel. There are two of them, one per layout: the
 * rail's foot on desktop and a small swatch in the header on the phone. Each
 * hides at the other's width, and the one that was pressed is the one focus
 * returns to.
 */
export function AppearanceTrigger({ variant }: { variant: "rail" | "header" }) {
  const { appearance, openPanel } = useAppearance();
  const { accent } = resolveAppearance(appearance);

  if (variant === "header") {
    return (
      <button
        type="button"
        className="v2-appearance-dot"
        aria-label={APPEARANCE_COPY.open}
        title={APPEARANCE_COPY.open}
        onClick={(event) => openPanel(event.currentTarget)}
      >
        {/* The current accent, so the control says what it is about. It is a
            mark rather than text, so the raw accent is right here. */}
        <span style={{ background: accent }} />
      </button>
    );
  }

  return (
    <button
      type="button"
      className="v2-rail-appearance"
      onClick={(event) => openPanel(event.currentTarget)}
    >
      {APPEARANCE_COPY.open}
    </button>
  );
}
