"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ColorPicker } from "./color-picker";
import {
  PALETTE_GROUPS,
  PALETTE_LABELS,
  THEMES,
  applyPaletteOverrides,
  getTheme,
  readStoredPalette,
  readStoredTheme,
  resolvedPalette,
  setActiveTheme,
  storePalette,
  type Palette,
  type ThemeName,
} from "./themes";

const themeListeners = new Set<() => void>();

function notifyTheme() {
  for (const cb of themeListeners) cb();
}

function subscribeTheme(cb: () => void) {
  themeListeners.add(cb);
  if (typeof document === "undefined") return () => themeListeners.delete(cb);
  const observer = new MutationObserver(cb);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => {
    themeListeners.delete(cb);
    observer.disconnect();
  };
}

function getThemeSnapshot(): ThemeName {
  return readStoredTheme();
}

function getThemeServerSnapshot(): ThemeName {
  return "dark";
}

export function SettingsPanel() {
  const theme = useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    getThemeServerSnapshot,
  );

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function selectTheme(next: ThemeName) {
    setActiveTheme(next);
    notifyTheme();
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="settings"
        aria-expanded={open}
        className="text-xs tracking-widest uppercase px-3 py-2 border border-fg text-fg hover:bg-fg hover:text-page transition-colors"
      >
        settings
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="settings"
          className="absolute right-0 top-full mt-2 w-[min(384px,calc(100vw-2rem))] z-50 border border-line bg-card max-h-[calc(100vh-6rem)] overflow-y-auto shadow-[0_8px_32px_rgba(0,0,0,0.55)]"
        >
          <div className="p-4 space-y-5">
            <section>
              <p className="text-[10px] tracking-widest uppercase text-muted mb-2">
                theme
              </p>
              <div className="grid grid-cols-3 gap-px border border-line bg-line">
                {THEMES.map((t) => {
                  const selected = t.name === theme;
                  return (
                    <button
                      key={t.name}
                      type="button"
                      onClick={() => selectTheme(t.name)}
                      title={t.tagline}
                      className={`min-h-12 px-2 py-2 text-[10px] tracking-widest uppercase transition-colors flex flex-col items-center justify-center gap-1 ${
                        selected
                          ? "bg-accent text-accent-fg"
                          : "bg-page text-muted hover:text-fg"
                      }`}
                    >
                      <span>{t.label}</span>
                      <span
                        aria-hidden
                        className="w-6 h-1.5"
                        style={{ backgroundColor: t.palette.accent }}
                      />
                    </button>
                  );
                })}
              </div>
              <p className="text-[10px] tracking-widest uppercase text-muted mt-2">
                {getTheme(theme).tagline}
              </p>
            </section>

            <PaletteEditor key={theme} theme={theme} />
          </div>
        </div>
      )}
    </div>
  );
}

function PaletteEditor({ theme }: { theme: ThemeName }) {
  const [overrides, setOverrides] = useState<Partial<Palette>>(() =>
    readStoredPalette(theme) ?? {},
  );
  const [activeSlot, setActiveSlot] = useState<keyof Palette | null>(null);

  const palette = resolvedPalette(theme, overrides);
  const hasOverrides = Object.keys(overrides).length > 0;

  function setColor(slot: keyof Palette, value: string) {
    const upper = value.toUpperCase();
    const nextOverrides: Partial<Palette> = { ...overrides, [slot]: upper };
    setOverrides(nextOverrides);
    storePalette(theme, nextOverrides);
    applyPaletteOverrides(nextOverrides);
  }

  function resetPalette() {
    setOverrides({});
    storePalette(theme, null);
    applyPaletteOverrides(null);
    setActiveSlot(null);
  }

  return (
    <>
      <section className="space-y-3">
        <p className="text-[10px] tracking-widest uppercase text-muted">
          colors
        </p>
        <div className="border border-line">
          {PALETTE_GROUPS.map((group) => (
            <div
              key={group.label}
              className="border-b border-line last:border-b-0"
            >
              <p className="text-[10px] tracking-widest uppercase text-muted px-3 py-1.5 bg-popover">
                {group.label}
              </p>
              {group.keys.map((key) => {
                const value = palette[key];
                const isActive = activeSlot === key;
                return (
                  <div
                    key={key}
                    className="border-t border-line first:border-t-0"
                  >
                    <button
                      type="button"
                      onClick={() => setActiveSlot(isActive ? null : key)}
                      aria-expanded={isActive}
                      className="flex items-center justify-between w-full px-3 py-2 hover:bg-card-hover transition-colors"
                    >
                      <span className="text-[10px] tracking-widest uppercase text-muted">
                        {PALETTE_LABELS[key]}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] text-muted">
                          {value.toUpperCase()}
                        </span>
                        <span
                          aria-hidden
                          className="w-6 h-6 border border-line-strong"
                          style={{ backgroundColor: value }}
                        />
                      </div>
                    </button>
                    {isActive && (
                      <div className="px-3 pb-3 pt-1">
                        <ColorPicker
                          value={value}
                          onChange={(c) => setColor(key, c)}
                          label={`${PALETTE_LABELS[key]} · ${theme}`}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </section>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={resetPalette}
          disabled={!hasOverrides}
          className="text-[10px] tracking-widest uppercase text-muted hover:text-fg transition-colors py-1.5 px-3 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-muted"
        >
          reset to preset
        </button>
      </div>
    </>
  );
}
