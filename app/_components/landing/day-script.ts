// One day on the board, as six stops along a line: everything Mindboard holds,
// in the order a day meets it. Plain data, so the order and the copy are
// checked in __tests__/landing-day.test.ts and the component only draws.

export type StopKey =
  | "stream"
  | "calendar"
  | "money"
  | "shelf"
  | "people"
  | "brain";

export type Stop = {
  key: StopKey;
  /** 24h "HH:MM". */
  time: string;
  /** What this part of the app is called. */
  lane: string;
  caption: string;
};

export const STOPS: Stop[] = [
  {
    key: "stream",
    time: "07:00",
    lane: "the stream",
    caption: "the day is already sorted when you open your eyes.",
  },
  {
    key: "calendar",
    time: "09:41",
    lane: "calendar",
    caption: "your google calendar, and the free hours hiding in it.",
  },
  {
    key: "money",
    time: "13:00",
    lane: "money",
    caption: "every coffee lands in the forecast. no jump-scares.",
  },
  {
    key: "shelf",
    time: "18:00",
    lane: "shelf",
    caption: "milk becomes a plan, not a crisis.",
  },
  {
    key: "people",
    time: "20:15",
    lane: "people",
    caption: "who you meant to call, before it gets weird.",
  },
  {
    key: "brain",
    time: "23:00",
    lane: "second brain",
    caption: "the shower idea, kept and linked to the rest.",
  },
];

/** Minutes after midnight for a "HH:MM" time; NaN if it is not one. */
export function minutesOf(time: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}
