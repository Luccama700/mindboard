// Pure math for the tour overlay: spotlight rect, card placement, and step
// bounds. Unit-tested in __tests__/tour-geometry.test.ts; keep DOM access out.

export type Rect = { top: number; left: number; width: number; height: number };
export type Viewport = { width: number; height: number };

export const SPOTLIGHT_PAD = 8;
// Worst-case card footprint used for fit checks (height + breathing room).
export const CARD_EST = 240;
const GAP = 12;
const MARGIN = 16;

/** An anchor that is display:none (or detached) measures as a zero rect. */
export function isVisibleRect(rect: Rect): boolean {
  return rect.width > 0 && rect.height > 0;
}

/**
 * Pad the anchor rect and clamp it to the viewport. Anchors taller than ~3/4
 * of the viewport (whole-page sections like the finance calendar) get their
 * spotlight capped so a dim ring stays visible and the card has room.
 */
export function spotlightRect(
  anchor: Rect,
  viewport: Viewport,
  pad: number = SPOTLIGHT_PAD,
): Rect {
  const top = Math.max(0, anchor.top - pad);
  const left = Math.max(0, anchor.left - pad);
  const right = Math.min(viewport.width, anchor.left + anchor.width + pad);
  const bottom = Math.min(viewport.height, anchor.top + anchor.height + pad);
  const maxHeight = viewport.height * 0.72;
  return {
    top,
    left,
    width: Math.max(0, right - left),
    height: Math.min(Math.max(0, bottom - top), maxHeight),
  };
}

export type CardPlacement =
  | { kind: "below"; top: number; left: number }
  | { kind: "above"; bottom: number; left: number }
  | { kind: "pinned"; bottom: number; left: number };

/**
 * Desktop card position. Space-aware: below the spotlight when it fits,
 * above when it fits, otherwise pinned to the bottom of the viewport — the
 * card must always be fully on screen and reachable. A forced placement
 * (steps that spotlight the Dock) is honored when it fits.
 */
export function cardPlacement(
  spotlight: Rect,
  viewport: Viewport,
  cardWidth: number,
  forced?: "top" | "bottom",
): CardPlacement {
  const centerX = spotlight.left + spotlight.width / 2;
  const left = Math.min(
    Math.max(MARGIN, centerX - cardWidth / 2),
    Math.max(MARGIN, viewport.width - cardWidth - MARGIN),
  );

  const fitsBelow =
    spotlight.top + spotlight.height + GAP + CARD_EST + MARGIN <=
    viewport.height;
  const fitsAbove = spotlight.top - GAP - CARD_EST - MARGIN >= 0;

  const preferAbove = forced === "top";
  const preferBelow = forced === "bottom";

  if (preferAbove && fitsAbove) {
    return {
      kind: "above",
      bottom: viewport.height - spotlight.top + GAP,
      left,
    };
  }
  if (preferBelow && fitsBelow) {
    return {
      kind: "below",
      top: spotlight.top + spotlight.height + GAP,
      left,
    };
  }
  if (!preferAbove && fitsBelow) {
    return {
      kind: "below",
      top: spotlight.top + spotlight.height + GAP,
      left,
    };
  }
  if (fitsAbove) {
    return {
      kind: "above",
      bottom: viewport.height - spotlight.top + GAP,
      left,
    };
  }
  if (fitsBelow) {
    return {
      kind: "below",
      top: spotlight.top + spotlight.height + GAP,
      left,
    };
  }
  return { kind: "pinned", bottom: MARGIN, left };
}

/**
 * Mobile: the card is a fixed sheet at the top or bottom of the screen.
 * It goes top when the spotlight sits in the lower half (or a step forces
 * "top" for Dock spotlights), bottom otherwise.
 */
export function mobilePlacement(
  spotlight: Rect,
  viewport: Viewport,
  forced?: "top" | "bottom",
): "top" | "bottom" {
  if (forced) return forced;
  const centerY = spotlight.top + spotlight.height / 2;
  return centerY >= viewport.height / 2 ? "top" : "bottom";
}

export function clampStep(step: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(Math.max(0, step), total - 1);
}
