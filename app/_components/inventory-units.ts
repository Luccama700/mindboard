export const UNIT_SUGGESTIONS: { category: string; units: string[] }[] = [
  { category: "count", units: ["units", "bottles", "cans", "packs", "boxes"] },
  { category: "volume", units: ["ml", "cl", "L"] },
  { category: "mass", units: ["g", "kg", "oz", "lb"] },
];

const SUGGESTED = new Set(
  UNIT_SUGGESTIONS.flatMap((c) => c.units).map((u) => u.toLowerCase()),
);

export function isSuggestedUnit(unit: string): boolean {
  return SUGGESTED.has(unit.trim().toLowerCase());
}
