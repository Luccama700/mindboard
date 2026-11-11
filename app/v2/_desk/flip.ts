// Motion on the desk: every change of arrangement and of layout glides.
//
// FLIP ON THE FRAMES. Each displayed frame's box is read before the change,
// the change is committed (the engine's new boxes apply at once, as CSS), each
// frame's box is read again, and each frame then plays from its old place to
// its new one with `transform: translate(...)` alone. A frame whose size
// changes takes its new size at once and travels by translation: its content
// is never scaled or stretched. A pane that appears fades in from nothing; one
// that disappears is `display: none`, so there is nothing to play.
//
// THE WEB ANIMATIONS API, through `flipRunner.animate`. It leaves no inline
// style behind, it can be cancelled, and a box read while one runs is where the
// frame is DRAWN: a change that starts during another (behaviour 4) reads each
// frame where it is drawn, cancels what was running, and only then reads where
// the frame now lies, so the new glide starts from the drawn place and ends at
// the engine's. `fill: "backwards"` holds a delayed frame at its old place (or
// at nothing) until its turn; nothing is held after the end.
//
// ONLY WHAT IS ASKED FOR. The desk routes the changes a person makes through
// `flipChange`; a change of class, the saved desk loading, the first paint and
// a divider's ratio never come here. Nothing plays while the stage carries
// `data-drag` (a divider drag follows the pointer raw), or under
// `prefers-reduced-motion: reduce`, asked at the moment of each change: the
// stylesheet's reduced motion rule shortens CSS animations and transitions and
// does not reach a script's animation.
//
// THE TOKENS. Durations and easing are v2.css's, read off the stage once per
// change, with a fallback number for each when the value does not parse.
// Nothing here writes a style, an attribute or `inert`: a frame is pressable
// the moment it is drawn.

import type { PaneId, ScreenClass } from "@/app/lib/v2/tiles";

/** Where a frame is drawn, and how opaque, in the page's own pixels. */
export interface FlipBox {
  left: number;
  top: number;
  width: number;
  height: number;
  opacity: number;
}

/** A change inside the layout on screen, or a change of layout. */
export type FlipKind = "arrange" | "layout";

/** The motion tokens, as milliseconds and an easing. */
export interface FlipTimes {
  quick: number;
  std: number;
  slow: number;
  ease: string;
}

/** What is used when a token cannot be read: v2.css's own values. */
export const FLIP_FALLBACK: FlipTimes = Object.freeze({
  quick: 140,
  std: 280,
  slow: 520,
  ease: "cubic-bezier(0.2, 0, 0, 1)",
});

/** A change of layout staggers its frames: at most this much a frame... */
export const STAGGER_STEP = 40;
/** ...and at most this much in all. */
export const STAGGER_TOTAL = 200;

/** Under half a pixel a frame has not moved. */
const STILL = 0.5;

export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** One frame's part in a glide. `opacity` is where a move starts its opacity from: 1 for none. */
export interface FlipPlay {
  pane: PaneId;
  kind: "move" | "appear";
  dx: number;
  dy: number;
  opacity: number;
  duration: number;
  delay: number;
}

/** The step between two frames' starts, for this many frames. */
export function staggerStep(count: number): number {
  if (count < 2) return 0;
  return Math.min(STAGGER_STEP, STAGGER_TOTAL / (count - 1));
}

function readingOrder(a: [PaneId, FlipBox], b: [PaneId, FlipBox]): number {
  const [, one] = a;
  const [, two] = b;
  if (Math.abs(one.top - two.top) > STILL) return one.top - two.top;
  return one.left - two.left;
}

function opaque(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

/**
 * What each frame plays, from the boxes of the displayed frames before and
 * after. A frame that was displayed and moved (or was caught mid fade) plays a
 * move: the standard duration for an arrangement, the slow one for a layout. A
 * frame that was not displayed fades in, quickly. A change of layout staggers
 * them in reading order of where they land, what travels first and what
 * arrives a beat after.
 */
export function planFlip(
  before: ReadonlyMap<PaneId, FlipBox>,
  after: ReadonlyMap<PaneId, FlipBox>,
  kind: FlipKind,
  times: FlipTimes,
): FlipPlay[] {
  const moves: FlipPlay[] = [];
  const appears: FlipPlay[] = [];
  for (const [pane, now] of [...after.entries()].sort(readingOrder)) {
    const was = before.get(pane);
    if (was === undefined) {
      appears.push({ pane, kind: "appear", dx: 0, dy: 0, opacity: 0, duration: times.quick, delay: 0 });
      continue;
    }
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    const opacity = opaque(was.opacity);
    if (Math.abs(dx) < STILL && Math.abs(dy) < STILL && opacity >= 1) continue;
    moves.push({
      pane,
      kind: "move",
      dx,
      dy,
      opacity,
      duration: kind === "layout" ? times.slow : times.std,
      delay: 0,
    });
  }
  const plays = [...moves, ...appears];
  if (kind === "arrange") return plays;
  const step = staggerStep(plays.length);
  return plays.map((play, index) => ({ ...play, delay: index * step }));
}

/** The keyframes of one play: a translation back to nothing, or a fade from nothing. Never a scale. */
export function flipKeyframes(play: FlipPlay): Keyframe[] {
  if (play.kind === "appear") return [{ opacity: 0 }, { opacity: 1 }];
  const from: Keyframe = { transform: `translate(${play.dx}px, ${play.dy}px)` };
  const to: Keyframe = { transform: "none" };
  if (play.opacity < 1) {
    from.opacity = play.opacity;
    to.opacity = 1;
  }
  return [from, to];
}

/** A duration token as milliseconds: `280ms` or `0.28s`, and the fallback for anything else. */
export function msOf(value: string, fallback: number): number {
  const match = /^(\d*\.?\d+)(ms|s)$/i.exec(value.trim());
  if (match === null) return fallback;
  const ms = Number(match[1]) * (match[2].toLowerCase() === "s" ? 1000 : 1);
  return Number.isFinite(ms) ? ms : fallback;
}

/** The one door to the Web Animations API, so a test can stand in for it. */
export const flipRunner = {
  animate(element: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation | null {
    if (typeof element.animate !== "function") return null;
    return element.animate(keyframes, options);
  },
};

/** The glides this module started, per frame, so the next change can cancel them. */
const running = new WeakMap<Element, Animation[]>();

function framesOf(stage: HTMLElement): HTMLElement[] {
  return Array.from(stage.querySelectorAll<HTMLElement>(":scope > section.v2-frame"));
}

/** Displayed on this class: what desk.css keys on, `data-shown`. */
function displayed(frame: HTMLElement, cls: ScreenClass): boolean {
  return (frame.dataset.shown ?? "").split(" ").includes(cls);
}

/** Each displayed frame where it is drawn now, transform and all. */
function snapshot(stage: HTMLElement, cls: ScreenClass): Map<PaneId, FlipBox> {
  const out = new Map<PaneId, FlipBox>();
  for (const frame of framesOf(stage)) {
    const pane = frame.dataset.pane;
    if (pane === undefined || !displayed(frame, cls)) continue;
    const box = frame.getBoundingClientRect();
    const opacity = Number.parseFloat(window.getComputedStyle(frame).opacity);
    out.set(pane, {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      opacity: Number.isFinite(opacity) ? opacity : 1,
    });
  }
  return out;
}

function stopAll(stage: HTMLElement): void {
  for (const frame of framesOf(stage)) {
    for (const animation of running.get(frame) ?? []) animation.cancel();
    running.delete(frame);
  }
}

/** The tokens the stage computes, read once. */
export function readTimes(stage: HTMLElement): FlipTimes {
  const style = window.getComputedStyle(stage);
  const ease = style.getPropertyValue("--v2-ease").trim();
  return {
    quick: msOf(style.getPropertyValue("--v2-quick"), FLIP_FALLBACK.quick),
    std: msOf(style.getPropertyValue("--v2-std"), FLIP_FALLBACK.std),
    slow: msOf(style.getPropertyValue("--v2-slow"), FLIP_FALLBACK.slow),
    ease: ease === "" ? FLIP_FALLBACK.ease : ease,
  };
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION).matches;
}

/** Whether anything may play on this stage now: no divider drag, and no wish for reduced motion. */
export function mayMove(stage: HTMLElement): boolean {
  return !stage.hasAttribute("data-drag") && !reducedMotion();
}

/** One animation through the runner; an easing the browser refuses falls back to v2.css's own curve. */
export function playOn(element: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation | null {
  try {
    return flipRunner.animate(element, keyframes, options);
  } catch {
    return flipRunner.animate(element, keyframes, { ...options, easing: FLIP_FALLBACK.ease });
  }
}

/** The layout on screen, as the desk's root says it. */
function layoutOn(stage: HTMLElement): string | null {
  return stage.closest(".v2-desk")?.getAttribute("data-layout") ?? null;
}

/**
 * Run one change of the desk, committed synchronously by `change` (a
 * `flushSync`), and glide the frames from where they were drawn to where they
 * now lie. `cls` is the class on screen; null (the browser has not said) moves
 * nothing.
 */
export function flipChange(stage: HTMLElement | null, cls: ScreenClass | null, change: () => void): void {
  if (stage === null || cls === null) {
    change();
    return;
  }
  const still = !mayMove(stage);
  // Where each frame is drawn, read BEFORE what is running is cancelled.
  const before = still ? null : snapshot(stage, cls);
  const was = layoutOn(stage);
  stopAll(stage);
  change();
  if (before === null) return;
  const after = snapshot(stage, cls);
  const kind: FlipKind = layoutOn(stage) === was ? "arrange" : "layout";
  const times = readTimes(stage);
  const plays = planFlip(before, after, kind, times);
  if (plays.length === 0) return;
  const byPane = new Map(framesOf(stage).map((frame) => [frame.dataset.pane, frame]));
  for (const play of plays) {
    const frame = byPane.get(play.pane);
    if (frame === undefined) continue;
    const animation = playOn(frame, flipKeyframes(play), {
      duration: play.duration,
      delay: play.delay,
      easing: times.ease,
      fill: "backwards",
    });
    if (animation !== null) running.set(frame, [...(running.get(frame) ?? []), animation]);
  }
}
