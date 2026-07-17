export type ThemeName =
  | "dark"
  | "cream"
  | "midnight"
  | "forest"
  | "slate"
  | "sand";

export type Palette = {
  bg: string;
  bgPopover: string;
  bgCard: string;
  bgCardHover: string;
  borderLine: string;
  borderStrong: string;
  borderSubtle: string;
  muted: string;
  fg: string;
  accent: string;
  accentFg: string;
  danger: string;
  dangerHover: string;
  positive: string;
};

export type ThemeDef = {
  name: ThemeName;
  label: string;
  tagline: string;
  palette: Palette;
};

export const PALETTE_KEYS: (keyof Palette)[] = [
  "bg",
  "bgPopover",
  "bgCard",
  "bgCardHover",
  "borderLine",
  "borderStrong",
  "borderSubtle",
  "muted",
  "fg",
  "accent",
  "accentFg",
  "danger",
  "dangerHover",
  "positive",
];

export const PALETTE_LABELS: Record<keyof Palette, string> = {
  bg: "page",
  bgPopover: "popover",
  bgCard: "card",
  bgCardHover: "card hover",
  borderLine: "line",
  borderStrong: "line strong",
  borderSubtle: "line subtle",
  muted: "muted text",
  fg: "foreground",
  accent: "accent",
  accentFg: "accent text",
  danger: "danger",
  dangerHover: "danger hover",
  positive: "positive",
};

export const PALETTE_GROUPS: { label: string; keys: (keyof Palette)[] }[] = [
  { label: "surfaces", keys: ["bg", "bgPopover", "bgCard", "bgCardHover"] },
  { label: "text", keys: ["fg", "muted"] },
  { label: "lines", keys: ["borderLine", "borderStrong", "borderSubtle"] },
  { label: "accent", keys: ["accent", "accentFg"] },
  { label: "danger", keys: ["danger", "dangerHover"] },
  { label: "signal", keys: ["positive"] },
];

const VAR_MAP: Record<keyof Palette, string> = {
  bg: "--bg",
  bgPopover: "--bg-popover",
  bgCard: "--bg-card",
  bgCardHover: "--bg-card-hover",
  borderLine: "--border-line",
  borderStrong: "--border-strong",
  borderSubtle: "--border-subtle",
  muted: "--muted",
  fg: "--fg",
  accent: "--accent",
  accentFg: "--accent-fg",
  danger: "--danger",
  dangerHover: "--danger-hover",
  positive: "--positive",
};

export const THEMES: ThemeDef[] = [
  {
    name: "dark",
    label: "dark",
    tagline: "terminal calm",
    palette: {
      bg: "#0d0d0d",
      bgPopover: "#101010",
      bgCard: "#141414",
      bgCardHover: "#1a1a1a",
      borderLine: "#1f1f1f",
      borderStrong: "#2a2a2a",
      borderSubtle: "#3a3a3a",
      muted: "#6b6b6b",
      fg: "#f5f0e8",
      accent: "#b5ff3c",
      accentFg: "#0d0d0d",
      danger: "#ff6b6b",
      dangerHover: "#ff8b8b",
      positive: "#4ade80",
    },
  },
  {
    name: "cream",
    label: "cream",
    tagline: "warm paper",
    palette: {
      bg: "#f5f0e8",
      bgPopover: "#efe7d8",
      bgCard: "#ece4d4",
      bgCardHover: "#e8dfcd",
      borderLine: "#d4c9b1",
      borderStrong: "#beb18f",
      borderSubtle: "#a99979",
      muted: "#897e62",
      fg: "#2a2620",
      accent: "#c9a572",
      accentFg: "#2a2620",
      danger: "#ff6b6b",
      dangerHover: "#ff8b8b",
      positive: "#3d7a4a",
    },
  },
  {
    name: "midnight",
    label: "midnight",
    tagline: "deep navy",
    palette: {
      bg: "#0a0e1c",
      bgPopover: "#0d1224",
      bgCard: "#11172d",
      bgCardHover: "#161e38",
      borderLine: "#1d2645",
      borderStrong: "#2a3559",
      borderSubtle: "#3d4970",
      muted: "#7587a8",
      fg: "#e8ecf8",
      accent: "#6b9eff",
      accentFg: "#0a0e1c",
      danger: "#ff6b6b",
      dangerHover: "#ff8b8b",
      positive: "#4ade80",
    },
  },
  {
    name: "forest",
    label: "forest",
    tagline: "deep moss",
    palette: {
      bg: "#0a140d",
      bgPopover: "#0d1810",
      bgCard: "#111d14",
      bgCardHover: "#16261b",
      borderLine: "#1d3024",
      borderStrong: "#2a4031",
      borderSubtle: "#3d5645",
      muted: "#7a9886",
      fg: "#eaf3ec",
      accent: "#6bff9b",
      accentFg: "#0a140d",
      danger: "#ff6b6b",
      dangerHover: "#ff8b8b",
      positive: "#4ade80",
    },
  },
  {
    name: "slate",
    label: "slate",
    tagline: "cool gray",
    palette: {
      bg: "#1a1d23",
      bgPopover: "#1e2229",
      bgCard: "#23272f",
      bgCardHover: "#292e37",
      borderLine: "#2f3540",
      borderStrong: "#404856",
      borderSubtle: "#525c6d",
      muted: "#8a93a3",
      fg: "#e8eaef",
      accent: "#b5ff3c",
      accentFg: "#1a1d23",
      danger: "#ff6b6b",
      dangerHover: "#ff8b8b",
      positive: "#4ade80",
    },
  },
  {
    name: "sand",
    label: "sand",
    tagline: "warm khaki",
    palette: {
      bg: "#ede4d0",
      bgPopover: "#e6dcc2",
      bgCard: "#ddd1b1",
      bgCardHover: "#d1c39c",
      borderLine: "#c2b18a",
      borderStrong: "#a89976",
      borderSubtle: "#8a7a5c",
      muted: "#6e6043",
      fg: "#2d251a",
      accent: "#d97757",
      accentFg: "#2d251a",
      danger: "#c14b4b",
      dangerHover: "#b03e3e",
      positive: "#2f6b3c",
    },
  },
];

export const THEME_NAMES: ThemeName[] = THEMES.map((t) => t.name);

export function isThemeName(value: unknown): value is ThemeName {
  return (
    typeof value === "string" && THEME_NAMES.includes(value as ThemeName)
  );
}

export function getTheme(name: ThemeName): ThemeDef {
  return THEMES.find((t) => t.name === name) ?? THEMES[0];
}

export function readStoredTheme(): ThemeName {
  if (typeof window === "undefined") return "dark";
  try {
    const v = localStorage.getItem("theme");
    if (isThemeName(v)) return v;
  } catch {
    // localStorage unavailable
  }
  // Fall back to whatever the server rendered from the theme cookie, so a
  // cleared localStorage doesn't snap the UI back to dark.
  const root = document.documentElement;
  for (const n of THEME_NAMES) {
    if (n !== "dark" && root.classList.contains(`theme-${n}`)) return n;
  }
  return "dark";
}

export function storeTheme(name: ThemeName) {
  try {
    localStorage.setItem("theme", name);
  } catch {
    // ignore
  }
  try {
    // Mirrored into a cookie so the server can render the right theme class
    // on first paint (no FOUC on non-dark themes).
    document.cookie = `theme=${name}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    // ignore
  }
}

export function readStoredPalette(theme: ThemeName): Partial<Palette> | null {
  if (typeof window === "undefined") return null;
  try {
    const json = localStorage.getItem(`palette-${theme}`);
    if (!json) return null;
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const out: Partial<Palette> = {};
    for (const key of PALETTE_KEYS) {
      const v = parsed[key];
      if (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)) {
        out[key] = v.toUpperCase();
      }
    }
    return out;
  } catch {
    return null;
  }
}

export function storePalette(
  theme: ThemeName,
  palette: Partial<Palette> | null,
) {
  try {
    if (palette && Object.keys(palette).length > 0) {
      localStorage.setItem(`palette-${theme}`, JSON.stringify(palette));
    } else {
      localStorage.removeItem(`palette-${theme}`);
    }
  } catch {
    // ignore
  }
}

export function resolvedPalette(
  theme: ThemeName,
  overrides: Partial<Palette> | null,
): Palette {
  const base = getTheme(theme).palette;
  if (!overrides) return base;
  return { ...base, ...overrides };
}

export function applyThemeClass(name: ThemeName) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const n of THEME_NAMES) {
    if (n === "dark") continue;
    root.classList.remove(`theme-${n}`);
  }
  if (name !== "dark") root.classList.add(`theme-${name}`);
}

export function applyPaletteOverrides(overrides: Partial<Palette> | null) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const key of PALETTE_KEYS) {
    const cssVar = VAR_MAP[key];
    if (overrides && overrides[key]) {
      root.style.setProperty(cssVar, overrides[key]!);
    } else {
      root.style.removeProperty(cssVar);
    }
  }
}

export function setActiveTheme(name: ThemeName) {
  applyThemeClass(name);
  storeTheme(name);
  applyPaletteOverrides(readStoredPalette(name));
  applyTextureOverride(readStoredTexture());
}

// Background texture (the fixed grain layer) — one global knob, stored as a
// 0..MAX opacity; null means "use the theme's default" (--texture-opacity in
// globals.css: 0.10 dark themes, 0.11 light).
export const TEXTURE_MAX = 0.3;

export function textureDefaultFor(theme: ThemeName): number {
  return theme === "cream" || theme === "sand" ? 0.11 : 0.1;
}

export function readStoredTexture(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem("texture-opacity");
    if (raw === null) return null;
    const value = Number(raw);
    if (!Number.isFinite(value)) return null;
    return Math.min(TEXTURE_MAX, Math.max(0, value));
  } catch {
    return null;
  }
}

export function storeTexture(value: number | null) {
  try {
    if (value === null) localStorage.removeItem("texture-opacity");
    else localStorage.setItem("texture-opacity", String(value));
  } catch {
    // ignore
  }
}

export function applyTextureOverride(value: number | null) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (value === null) root.style.removeProperty("--texture-opacity");
  else root.style.setProperty("--texture-opacity", String(value));
}
