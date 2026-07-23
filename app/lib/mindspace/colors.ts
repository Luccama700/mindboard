// Deterministic fallback palette for topics seeded without a group color.
export const FALLBACK_COLORS = [
  "#b5ff3c",
  "#3cd9ff",
  "#ffb73c",
  "#c892ff",
  "#3c8fff",
  "#ff6b9d",
  "#7cff6b",
  "#fb623c",
  "#9e44f8",
  "#3cffc9",
];

export function assignTopicColors<T extends { color: string | null }>(
  topics: T[],
): (T & { color: string })[] {
  return topics.map((topic, index) => ({
    ...topic,
    color: topic.color ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length],
  }));
}
