// The look of the v2 screen, as arithmetic.
//
// WHY THIS IS A MODULE AND NOT A STYLESHEET. Two things about these colours
// cannot be settled by looking at one screenshot:
//
//  1. The owner changes the scheme at runtime, and a custom pair is two colours
//     he picked, so there is no finite set of palettes to eyeball.
//  2. The colours that mark each stop are HIS data (a lane's colour, a group's
//     colour). Real accounts carry a deep navy, a brown, a dark magenta. Any of
//     those used as text on black is invisible, and used as a button fill it
//     swallows its own label.
//
// So the whole palette is derived from exactly two colours by the functions
// below, and the guarantees are ratios a test can compute: every token used as
// text clears 4.5:1 on every surface it sits on, the accent clears 3:1 on the
// page, and an identity colour is lifted until it clears 4.5:1 on the card it
// tints. The stylesheet declares the black and purple scheme as its defaults so
// the server's first paint is already right, and a test asserts those literals
// ARE deriveTokens(SCHEMES[0]) so the two cannot drift.
//
// Pure. No DOM, no storage, no clock. The client component reads and writes
// localStorage and calls parseAppearance on whatever comes back.

const WHITE = "#FFFFFF";
const BLACK = "#000000";

/** A built-in scheme: a page colour and the one accent, nothing else. */
export interface Scheme {
  id: string;
  name: string;
  background: string;
  accent: string;
}

/**
 * The built-in schemes, in the order the panel offers them. Black and purple is
 * first because it is the default: black is the page, purple is the one accent.
 */
export const SCHEMES: readonly Scheme[] = [
  { id: "black-purple", name: "Black and purple", background: "#000000", accent: "#A78BFA" },
  { id: "night-indigo", name: "Night indigo", background: "#171A3D", accent: "#FFFFFF" },
  { id: "graphite-teal", name: "Graphite and teal", background: "#101314", accent: "#5EEAD4" },
  { id: "paper-ink", name: "Paper", background: "#F6F3EC", accent: "#4338CA" },
];

export const DEFAULT_SCHEME_ID = "black-purple";

/** The id a custom pair is stored under. Not a member of SCHEMES. */
export const CUSTOM_SCHEME_ID = "custom";

/** This browser only. There is no account column for the v2 scheme. */
export const APPEARANCE_STORAGE_KEY = "mb-v2-appearance";

/** What is stored: a scheme id, plus the two colours when it is the custom one. */
export interface Appearance {
  schemeId: string;
  background: string | null;
  accent: string | null;
}

export const DEFAULT_APPEARANCE: Appearance = {
  schemeId: DEFAULT_SCHEME_ID,
  background: null,
  accent: null,
};

/** Every token the stylesheet reads from the scheme. */
export const TOKEN_NAMES = [
  "--v2-page",
  "--v2-card",
  "--v2-card-2",
  "--v2-edge",
  "--v2-ink",
  "--v2-ink-2",
  "--v2-ink-3",
  "--v2-accent",
  "--v2-on-accent",
  "--v2-signal",
] as const;

/** Every token one stop sets from its own identity colour. */
export const IDENTITY_TOKEN_NAMES = [
  "--v2-lane",
  "--v2-ident",
  "--v2-on-ident",
  "--v2-lit",
] as const;

/** Every string the appearance panel prints. */
export const APPEARANCE_COPY = {
  /** The accessible name of the control that opens the panel. */
  open: "Appearance",
  title: "Appearance",
  close: "Close",
  schemes: "Colour scheme",
  custom: "Custom",
  customHint: "Pick your own two colours.",
  background: "Background",
  accent: "Accent",
  reset: "Reset to black and purple",
  stored: "Saved in this browser only.",
} as const;

// ---------------------------------------------------------------- colour maths

/** "#RRGGBB" from "#rgb", "rgb", "#rrggbb" or "rrggbb". null for anything else. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`.toUpperCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw}`.toUpperCase();
  return null;
}

function channels(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function toHex(r: number, g: number, b: number): string {
  const byte = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/** `t` of `b` mixed into `a`, channelwise in sRGB. The same mix CSS color-mix does. */
export function mixHex(a: string, b: string, t: number): string {
  const from = normalizeHex(a) ?? BLACK;
  const to = normalizeHex(b) ?? WHITE;
  const amount = Math.max(0, Math.min(1, t));
  const [r1, g1, b1] = channels(from);
  const [r2, g2, b2] = channels(to);
  return toHex(
    r1 + (r2 - r1) * amount,
    g1 + (g2 - g1) * amount,
    b1 + (b2 - b1) * amount,
  );
}

function linear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = channels(normalizeHex(hex) ?? BLACK);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** The WCAG contrast ratio, 1 to 21. Order does not matter. */
export function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Whether this background wants light ink. Read off the colour, never off the
 * scheme id, so a custom pair and a built-in one are decided the same way.
 */
export function isDarkBackground(background: string): boolean {
  return contrast(WHITE, background) >= contrast(BLACK, background);
}

/**
 * The colour itself when it already clears `min` against the background, and
 * otherwise the nearest lighter (on a dark background) or darker (on a light
 * one) mix of it that does.
 *
 * Nearest, not "a safe default": the point is that the user's own colour stays
 * recognisable. Mixing toward white raises every channel, so contrast against a
 * dark background rises monotonically with the mix and a bisection finds the
 * smallest one that works. The byte rounding afterwards can land a hair under
 * the bar, hence the step up.
 *
 * A background in the middle of the range cannot carry readable text at all
 * (nothing clears 4.58:1 on a mid grey). The honest answer there is the best
 * available, which is the extreme, rather than a throw nobody handles.
 */
export function readableOn(color: string, background: string, min = 4.5): string {
  const start = normalizeHex(color) ?? BLACK;
  const page = normalizeHex(background) ?? BLACK;
  if (contrast(start, page) >= min) return start;

  const target = isDarkBackground(page) ? WHITE : BLACK;
  if (contrast(target, page) < min) return target;

  let low = 0;
  let high = 1;
  for (let step = 0; step < 20; step += 1) {
    const mid = (low + high) / 2;
    if (contrast(mixHex(start, target, mid), page) >= min) high = mid;
    else low = mid;
  }
  let out = mixHex(start, target, high);
  for (let step = 1; step <= 64 && contrast(out, page) < min; step += 1) {
    out = mixHex(start, target, Math.min(1, high + step / 256));
  }
  return out;
}

/**
 * The text that sits on a filled control of this colour. Black or white,
 * whichever reads better: the fill can be a group colour the user picked, so the
 * only choice that is right for every possible fill is the extreme one.
 */
export function inkOn(fill: string): string {
  return contrast(WHITE, fill) >= contrast(BLACK, fill) ? WHITE : BLACK;
}

// -------------------------------------------------------------- the scheme

/**
 * How far each surface moves away from the page, and how far the inks move
 * toward their extreme. One fraction per surface, applied to a single colour
 * (`castLift`) that carries both the lift and the accent's cast, so a white
 * accent cannot double the lift the way a separate cast mix did.
 */
const SURFACE = { card: 0.085, card2: 0.145, edge: 0.3 } as const;
const INK = { two: 0.72, three: 0.5 } as const;

/** How much of the accent the lift colour carries. Enough to see, not to tint. */
const CAST = { dark: 0.34, light: 0.26 } as const;

/** How much of a stop's identity colour tints the lit card it sits in. */
export const LIT_TINT = 0.14;

/** The ratios each level of ink has to clear on the worst surface it sits on. */
const INK_MIN = { one: 11, two: 7, three: 4.5 } as const;

/** The ratio a mark that carries no text has to clear (WCAG non-text contrast). */
const MARK_MIN = 3;

export function schemeById(id: string): Scheme | null {
  return SCHEMES.find((scheme) => scheme.id === id) ?? null;
}

/** The two colours an appearance actually resolves to. */
export function resolveAppearance(appearance: Appearance): {
  background: string;
  accent: string;
} {
  const scheme = schemeById(appearance.schemeId);
  if (scheme !== null) {
    return { background: scheme.background, accent: scheme.accent };
  }
  return {
    background: normalizeHex(appearance.background) ?? SCHEMES[0].background,
    accent: normalizeHex(appearance.accent) ?? SCHEMES[0].accent,
  };
}

/**
 * Every colour token the stylesheet uses, from a background and an accent.
 *
 * Light or dark is decided by the background's luminance, so the same code
 * serves Paper and black. The inks are derived against the WORST of the three
 * surfaces (the one furthest from the page in the ink's direction), because a
 * token that only clears the page would fail on a chip sitting on the page.
 */
export function deriveTokens(background: string, accent: string): Record<string, string> {
  const page = normalizeHex(background) ?? SCHEMES[0].background;
  const chosen = normalizeHex(accent) ?? SCHEMES[0].accent;
  const dark = isDarkBackground(page);
  const extreme = dark ? WHITE : BLACK;
  const castLift = mixHex(extreme, chosen, dark ? CAST.dark : CAST.light);

  const card = mixHex(page, castLift, SURFACE.card);
  const cardTwo = mixHex(page, castLift, SURFACE.card2);
  const edge = mixHex(page, castLift, SURFACE.edge);

  // The surface that is hardest for text: the lightest on a dark scheme, the
  // darkest on a light one. Computed rather than assumed to be cardTwo, because
  // the accent's cast moves luminance as well as hue.
  const surfaces = [page, card, cardTwo];
  const worst = surfaces.reduce((a, b) =>
    dark
      ? luminance(a) >= luminance(b)
        ? a
        : b
      : luminance(a) <= luminance(b)
        ? a
        : b,
  );

  const accentMark = readableOn(chosen, page, MARK_MIN);

  return {
    "--v2-page": page,
    "--v2-card": card,
    "--v2-card-2": cardTwo,
    "--v2-edge": edge,
    "--v2-ink": readableOn(mixHex(extreme, chosen, dark ? 0.06 : 0.12), worst, INK_MIN.one),
    "--v2-ink-2": readableOn(mixHex(page, castLift, INK.two), worst, INK_MIN.two),
    "--v2-ink-3": readableOn(mixHex(page, castLift, INK.three), worst, INK_MIN.three),
    // The accent fills: a focus ring, the energy thumb, the rail's marker. 3:1
    // is the bar for a mark. The accent AS TEXT is --v2-signal below.
    "--v2-accent": accentMark,
    "--v2-on-accent": inkOn(accentMark),
    "--v2-signal": readableOn(accentMark, worst, INK_MIN.three),
  };
}

export function tokensFor(appearance: Appearance): Record<string, string> {
  const { background, accent } = resolveAppearance(appearance);
  return deriveTokens(background, accent);
}

/**
 * The four tokens one stop sets from its own identity colour: a lane's colour,
 * or the colour of the group the task lives in.
 *
 *   --v2-lane      the mark on the line (the dot, the rail behind a settled
 *                  stop). The colour the user chose, lifted only when it would
 *                  not be visible at all: a deep navy dot on black is no dot.
 *   --v2-lit       the lit card's fill: the mark tinted into the card surface.
 *                  Computed here rather than with color-mix in the stylesheet,
 *                  so the percentage the ink is measured against and the
 *                  percentage that is painted cannot drift apart.
 *   --v2-ident     the identity as TEXT, as the lit card's edge, and as a
 *                  filled button. Lifted until it reads on the card it tints.
 *   --v2-on-ident  the label on that filled button.
 *
 * A stop with no colour of its own takes the scheme's accent instead, which is
 * behaviour 11's "the primary action when a stop has no colour of its own".
 */
export function identityTokens(
  color: string | null,
  tokens: Record<string, string>,
): Record<string, string> {
  const page = tokens["--v2-page"] ?? SCHEMES[0].background;
  const card = tokens["--v2-card"] ?? SCHEMES[0].background;
  const own = color === null ? null : normalizeHex(color);

  // Measured against the CARD, not the page: the same dot marks a stop on the
  // page and a lane in the side column's list, and a surface one step away from
  // the page is the harder of the two in whichever direction the scheme runs. So
  // clearing 3:1 there clears it on the page as well.
  const mark =
    own === null
      ? (tokens["--v2-accent"] ?? SCHEMES[0].accent)
      : readableOn(own, card, MARK_MIN);
  const lit = mixHex(card, mark, LIT_TINT);
  const seed = own === null ? (tokens["--v2-signal"] ?? mark) : mark;
  // The identity has to read on the card it tints AND on the page, because the
  // same colour prints the quiet line of identity under an unlit stop's title.
  const onCard = readableOn(seed, lit, INK_MIN.three);
  const ident = readableOn(onCard, page, INK_MIN.three);

  return {
    "--v2-lane": own === null ? (tokens["--v2-edge"] ?? mark) : mark,
    "--v2-lit": lit,
    "--v2-ident": ident,
    "--v2-on-ident": inkOn(ident),
  };
}

// ------------------------------------------------------------- what is stored

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * What came out of storage, as an Appearance. Anything malformed comes back as
 * the default, which is the whole point: the key is in the user's browser, so
 * the value can be absent, truncated, from an older shape, or hand edited.
 */
export function parseAppearance(value: unknown): Appearance {
  const stored = record(value);
  if (stored === null) return DEFAULT_APPEARANCE;

  const id = stored.schemeId;
  if (typeof id !== "string") return DEFAULT_APPEARANCE;

  if (schemeById(id) !== null) {
    // A built-in scheme owns its two colours, so anything stored beside it is
    // stale and is dropped rather than half applied.
    return { schemeId: id, background: null, accent: null };
  }

  if (id !== CUSTOM_SCHEME_ID) return DEFAULT_APPEARANCE;

  const background = normalizeHex(stored.background);
  const accent = normalizeHex(stored.accent);
  if (background === null || accent === null) return DEFAULT_APPEARANCE;
  return { schemeId: CUSTOM_SCHEME_ID, background, accent };
}
