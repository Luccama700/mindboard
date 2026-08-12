// Pure recency display logic for People (docs/people-plan.md §3.1, §6).
// Bands, never counters: the specific number appears only inside a
// suggestion, where it is a reason — these helpers render qualitative text.
// All math is on YYYY-MM-DD day keys; callers pass the page's resolved
// `today`, never a device-derived one.

import type { PersonInteraction } from "./people-types";

export function daysBetweenKeys(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000,
  );
}

export type RecencyBand = "in touch" | "a while" | "quiet";

// Cadence-relative on purpose: the user's own rhythm defines "a while",
// so no product-imposed tier ever ships (§3.6). Within cadence = in touch;
// up to double = a while; beyond = quiet.
export function recencyBand(
  daysSinceTalked: number,
  checkinDays: number,
): RecencyBand {
  if (daysSinceTalked <= checkinDays) return "in touch";
  if (daysSinceTalked <= checkinDays * 2) return "a while";
  return "quiet";
}

// The dossier header line for people with no cadence set falls back to
// coarse, judgment-free phrasing.
export function looseBand(daysSince: number): string {
  if (daysSince <= 14) return "recently";
  if (daysSince <= 45) return "it's been a while";
  return "not lately";
}

// 'approx' rows never render a fabricated date (§2.4).
export function formatOccurred(
  interaction: Pick<PersonInteraction, "occurred_at" | "occurred_precision">,
  today: string,
): string {
  const days = daysBetweenKeys(interaction.occurred_at, today);
  if (interaction.occurred_precision === "exact") {
    if (days === 0) return "today";
    if (days === 1) return "yesterday";
    return new Date(`${interaction.occurred_at}T00:00:00Z`).toLocaleDateString(
      "en-US",
      { month: "short", day: "numeric", timeZone: "UTC" },
    );
  }
  if (days <= 2) return "in the last few days";
  if (days <= 10) return "about a week ago";
  if (days <= 45) return "about a month ago";
  return "a while ago";
}
