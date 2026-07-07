// Pure grammar for the /inventory stock capture bar. Quantity-first segments,
// comma/semicolon/newline separated:
//   "12 eggs"   → set (recount to 12; creates the item if it doesn't exist)
//   "+2 milk"   → add (got more)
//   "-1 rice"   → remove (used some)
//   "0 coffee"  → set 0 (ran out)
// Anything that doesn't parse falls through to the natural-language path
// (Claude → proposal receipt), so this stays deliberately strict.

export type ParsedStockSegment = {
  sign: "+" | "-" | null;
  value: number;
  ref: string;
};

const SEGMENT_RE = /^([+-])?\s*(\d+(?:[.,]\d+)?)\s+(.+)$/;

export function splitStockSegments(text: string): string[] {
  return text
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseStockSegment(segment: string): ParsedStockSegment | null {
  const match = SEGMENT_RE.exec(segment.trim());
  if (!match) return null;
  const value = Number(match[2].replace(",", "."));
  if (!Number.isFinite(value) || value < 0) return null;
  const sign = (match[1] as "+" | "-" | undefined) ?? null;
  if (sign && value === 0) return null;
  const ref = match[3].trim();
  if (!ref) return null;
  return { sign, value: Math.round(value * 1000) / 1000, ref };
}

// null → at least one segment failed to parse; send the whole text to the
// natural-language path instead of half-applying it.
export function parseStockText(text: string): ParsedStockSegment[] | null {
  const segments = splitStockSegments(text);
  if (segments.length === 0) return null;
  const parsed: ParsedStockSegment[] = [];
  for (const segment of segments) {
    const p = parseStockSegment(segment);
    if (!p) return null;
    parsed.push(p);
  }
  return parsed;
}
