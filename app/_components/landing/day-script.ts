// Pure math for the pinned "one day on the board" scene. The whole story is
// a function of one scroll fraction (0..1): scrubbing forward plays the day,
// scrubbing back rewinds it — text untypes, bars refill. Unit-tested in
// __tests__/landing-day.test.ts.

export type Chapter = {
  key: "wake" | "capture" | "money" | "shelf" | "night";
  time: string;
  title: string;
  caption: string;
};

export const CHAPTERS: Chapter[] = [
  {
    key: "wake",
    time: "07:00",
    title: "wake",
    caption: "the day is already sorted when you open your eyes.",
  },
  {
    key: "capture",
    time: "09:41",
    title: "capture",
    caption: "you type like you think. i sort out what you meant.",
  },
  {
    key: "money",
    time: "13:00",
    title: "money",
    caption: "every coffee lands in the forecast. no jump-scares.",
  },
  {
    key: "shelf",
    time: "18:00",
    title: "shelf",
    caption: "milk becomes a plan, not a crisis.",
  },
  {
    key: "night",
    time: "23:00",
    title: "rest",
    caption: "you sleep. i hold on to all of it.",
  },
];

/** Which chapter a global progress lands in, plus 0..1 progress inside it. */
export function chapterAt(p: number): { index: number; local: number } {
  const clamped = Math.min(1, Math.max(0, p));
  const span = 1 / CHAPTERS.length;
  const index = Math.min(CHAPTERS.length - 1, Math.floor(clamped / span));
  const local = Math.min(1, Math.max(0, (clamped - index * span) / span));
  return { index, local };
}

/** Sub-progress: 0 before `start`, 1 after `end`, linear between. */
export function seg(local: number, start: number, end: number): number {
  if (end <= start) return local >= end ? 1 : 0;
  return Math.min(1, Math.max(0, (local - start) / (end - start)));
}

/** Characters of `text` typed at sub-progress `t` (0..1). */
export function typedCount(text: string, t: number): number {
  return Math.round(Math.min(1, Math.max(0, t)) * text.length);
}

/**
 * Chapter content opacity: ramps in over the first 12% of the chapter and
 * out over the last 8%, so adjacent chapters crossfade instead of popping.
 * The final chapter holds at full.
 */
export function chapterFade(index: number, local: number): number {
  const fadeIn = index === 0 ? 1 : seg(local, 0, 0.12);
  const fadeOut = index === CHAPTERS.length - 1 ? 1 : 1 - seg(local, 0.92, 1);
  return Math.min(fadeIn, fadeOut);
}

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * Math.min(1, Math.max(0, t));
}
