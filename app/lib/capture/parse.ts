// Pure capture-text parsing. M3 ships trailing-time extraction (the ⌚ chip);
// the full three-mode grammar (task / $ spend / ? copilot) lands with M4.

export type TrailingTime = {
  title: string; // input with the time phrase removed
  time: string; // "HH:MM" 24h
  matched: string; // the raw phrase that was removed
};

// Trailing forms only — a time in the middle of a title is part of the title:
//   "call landlord 3pm" · "gym at 17:30" · "standup 9:15am" · "lunch 12 pm"
const TRAILING_TIME_RE =
  /(?:^|\s)(?:at\s+)?((?:[01]?\d|2[0-3])(?::([0-5]\d))?\s*(am|pm)?)\s*$/i;

export function extractTrailingTime(input: string): TrailingTime | null {
  const match = TRAILING_TIME_RE.exec(input);
  if (!match) return null;

  const [, , minutesRaw, meridiem] = match;
  const hourRaw = match[1].replace(/\s*(am|pm)\s*$/i, "").split(":")[0];
  let hours = Number(hourRaw);
  const minutes = minutesRaw ? Number(minutesRaw) : 0;

  // A bare number with no colon and no am/pm is too ambiguous to be a time
  // ("buy 2" is a quantity, not 2 o'clock).
  if (!minutesRaw && !meridiem) return null;
  if (!Number.isFinite(hours) || hours > 23) return null;

  if (meridiem) {
    const isPm = meridiem.toLowerCase() === "pm";
    if (hours === 12) hours = isPm ? 12 : 0;
    else if (isPm) hours += 12;
    if (hours > 23) return null;
  }

  const title = input.slice(0, match.index).trim();
  if (!title) return null;

  return {
    title,
    time: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`,
    matched: input.slice(match.index).trim(),
  };
}
