"use client";

import { useState, useSyncExternalStore } from "react";
import { ColorPicker } from "./color-picker";
import {
  GOOGLE_MODELS,
  OPENAI_MODELS,
  readImageGenSettings,
  writeImageGenSettings,
  type ImageGenSettings,
  type ImageProvider,
} from "./image-gen-settings";
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

// The appearance sections (theme grid, palette editor, image-gen keys),
// rendered inline on /settings. The old header popover retired with the Dock.
export function SettingsSections() {
  const theme = useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    getThemeServerSnapshot,
  );

  function selectTheme(next: ThemeName) {
    setActiveTheme(next);
    notifyTheme();
  }

  return (
    <div className="space-y-5">
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

      <ImageGenEditor />
    </div>
  );
}

function ImageGenEditor() {
  const [settings, setSettings] = useState<ImageGenSettings>(
    readImageGenSettings,
  );

  function update(patch: Partial<ImageGenSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    writeImageGenSettings(next);
  }

  const providers: { id: ImageProvider; label: string }[] = [
    { id: "openai", label: "openai" },
    { id: "google", label: "google" },
  ];

  return (
    <section className="space-y-3">
      <p className="text-[10px] tracking-widest uppercase text-muted">
        ai image generation
      </p>

      <div className="grid grid-cols-2 gap-px border border-line bg-line">
        {providers.map((p) => {
          const selected = settings.provider === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => update({ provider: p.id })}
              className={`min-h-11 px-2 py-2 text-[10px] tracking-widest uppercase transition-colors ${
                selected
                  ? "bg-accent text-accent-fg"
                  : "bg-page text-muted hover:text-fg"
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {settings.provider === "openai" ? (
        <div className="space-y-2">
          <KeyInput
            label="openai api key"
            value={settings.openaiKey}
            onChange={(v) => update({ openaiKey: v })}
          />
          <ModelSelect
            value={settings.openaiModel}
            options={OPENAI_MODELS}
            onChange={(v) => update({ openaiModel: v })}
          />
        </div>
      ) : (
        <div className="space-y-2">
          <KeyInput
            label="google api key"
            value={settings.googleKey}
            onChange={(v) => update({ googleKey: v })}
          />
          <ModelSelect
            value={settings.googleModel}
            options={GOOGLE_MODELS}
            onChange={(v) => update({ googleModel: v })}
          />
        </div>
      )}

      <p className="text-[10px] leading-relaxed text-muted">
        keys are stored only in this browser and sent to the provider when you
        generate an icon.
      </p>
    </section>
  );
}

function KeyInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [reveal, setReveal] = useState(false);
  return (
    <div>
      <p className="text-[10px] tracking-widest uppercase text-muted mb-1.5">
        {label}
      </p>
      <div className="flex items-stretch gap-px">
        <input
          type={reveal ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="paste key…"
          autoComplete="off"
          spellCheck={false}
          className="flex-1 min-w-0 bg-page border border-line-strong focus:border-accent text-fg placeholder-muted text-xs px-2 py-2 focus:outline-none transition-colors font-mono"
        />
        <button
          type="button"
          onClick={() => setReveal((v) => !v)}
          className="px-2 border border-l-0 border-line-strong text-[10px] tracking-widest uppercase text-muted hover:text-fg transition-colors"
        >
          {reveal ? "hide" : "show"}
        </button>
      </div>
    </div>
  );
}

function ModelSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <p className="text-[10px] tracking-widest uppercase text-muted mb-1.5">
        model
      </p>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="image model"
        className="w-full bg-page border border-line-strong focus:border-accent text-fg text-xs px-2 py-2 focus:outline-none transition-colors font-mono"
      >
        {options.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
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
