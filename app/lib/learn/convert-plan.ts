// Pure planning/stitching logic for the Claude API PDF→markdown converter.
// The server orchestration (storage download, unpdf probe, pdf-lib slicing,
// Anthropic calls, vault write) lives in ./convert.ts; this module has no
// server imports so it unit-tests directly.

export const SLICE_PAGES = 20;

export type PageSlice = { from: number; to: number };

// 1-based inclusive ranges. Consecutive slices overlap by one page so a
// section split mid-page can be stitched; stitchConverted drops the overlap
// using the page anchors.
export function planSlices(
  pageCount: number,
  slicePages: number = SLICE_PAGES,
): PageSlice[] {
  if (!Number.isInteger(pageCount) || pageCount < 1) return [];
  if (pageCount <= slicePages) return [{ from: 1, to: pageCount }];

  const slices: PageSlice[] = [{ from: 1, to: slicePages }];
  while (slices[slices.length - 1].to < pageCount) {
    const from = slices[slices.length - 1].to; // 1-page overlap
    slices.push({ from, to: Math.min(from + slicePages - 1, pageCount) });
  }
  return slices;
}

export function pageAnchor(page: number): string {
  return `<!-- p.${page} -->`;
}

// Later slices re-transcribe their first (overlap) page; cut everything
// before the first genuinely-new page's anchor. If the anchor is missing the
// whole part is kept — a duplicated page beats a silent hole.
export function trimOverlap(markdown: string, overlapPage: number): string {
  const anchor = pageAnchor(overlapPage + 1);
  const index = markdown.indexOf(anchor);
  return index === -1 ? markdown : markdown.slice(index);
}

export function stitchConverted(
  parts: { slice: PageSlice; markdown: string }[],
): string {
  return parts
    .map((part, i) =>
      (i === 0
        ? part.markdown
        : trimOverlap(part.markdown, part.slice.from)
      ).trim(),
    )
    .filter(Boolean)
    .join("\n\n");
}

export function conversionSystemPrompt(): string {
  return [
    "You transcribe course documents into Markdown for an Obsidian vault.",
    "Rules:",
    "- Transcribe faithfully and completely. Never summarize, never skip content, never add commentary.",
    "- GitHub-flavored markdown. Headings for the document's own structure.",
    "- Math as LaTeX: $…$ inline, $$…$$ display.",
    "- Tables as markdown tables.",
    "- Before each page's content, emit the comment <!-- p.N --> with that page's absolute page number.",
    "- Describe figures/diagrams in one bracketed line: [figure: …].",
    "- For scanned or handwritten pages, read from the page image.",
    "- Output ONLY the markdown transcription — no preamble, no code fence around the whole document.",
  ].join("\n");
}

export function conversionUserPrompt(
  slice: PageSlice,
  totalPages: number,
  title: string,
): string {
  return `This PDF slice contains pages ${slice.from}–${slice.to} of ${totalPages} of "${title}". The slice's first page is absolute page ${slice.from} — number the <!-- p.N --> anchors accordingly (${slice.from}, ${slice.from + 1}, …). Transcribe every page in the slice.`;
}
