"use client";

import { useState, useSyncExternalStore } from "react";
import { ColorPicker } from "./color-picker";
import { INPUT_CLASS } from "./ui";
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

// The appearance section (theme dropdown + collapsible palette editor),
// rendered inline on /settings. The old header popover retired with the Dock;
// image-gen keys moved to settings → connections.
export function SettingsSections() {
  const theme = useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    getThemeServerSnapshot,
  );
  const [showColors, setShowColors] = useState(false);

  function selectTheme(next: ThemeName) {
    setActiveTheme(next);
    notifyTheme();
  }

  return (
    <div className="space-y-5">
      <section>
        <p className="text-[10px] tracking-widest uppercase text-muted mb-1.5">
          theme
        </p>
        <div className="flex items-center gap-2">
          <select
            value={theme}
            onChange={(e) => selectTheme(e.target.value as ThemeName)}
            aria-label="theme"
            className={INPUT_CLASS}
          >
            {THEMES.map((t) => (
              <option key={t.name} value={t.name}>
                {t.label} — {t.tagline}
              </option>
            ))}
          </select>
          <span
            aria-hidden
            className="w-6 h-6 shrink-0 rounded-full border border-line-strong"
            style={{ backgroundColor: getTheme(theme).palette.accent }}
          />
        </div>
      </section>

      <section className="space-y-3">
        <button
          type="button"
          onClick={() => setShowColors((v) => !v)}
          aria-expanded={showColors}
          className="flex items-center justify-between w-full min-h-11 glass-panel rounded-field px-3 py-2 hover:bg-card-hover transition-colors"
        >
          <span className="text-[10px] tracking-widest uppercase text-muted">
            customize colors
          </span>
          <span aria-hidden className="text-[10px] text-muted">
            {showColors ? "▲" : "▼"}
          </span>
        </button>
        {showColors && <PaletteEditor key={theme} theme={theme} />}
      </section>
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
        <div className="glass-panel overflow-hidden">
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
                          className="w-6 h-6 rounded-full border border-line-strong"
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
