export type NoteFrontmatter = Record<string, string>;

export type ParsedFrontmatter = {
  frontmatter: NoteFrontmatter;
  body: string;
};

export type WikilinkResolver = (target: string) => string | null;

const FOLDER_PRIORITY = [
  "",
  "People",
  "Projects",
  "Areas",
  "Topics",
  "Journal",
  "Archive",
];

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return { frontmatter: {}, body: raw };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { frontmatter: {}, body: raw };
  const frontmatter: NoteFrontmatter = {};
  for (const line of lines.slice(1, end)) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key) frontmatter[key] = value;
  }
  return { frontmatter, body: lines.slice(end + 1).join("\n") };
}

export function noteTitle(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

export function noteFolder(path: string): string {
  const idx = path.indexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

export function noteHref(path: string): string {
  return (
    "/brain/note/" +
    path
      .replace(/\.md$/i, "")
      .split("/")
      .map(encodeURIComponent)
      .join("/")
  );
}

export function buildResolver(paths: string[]): WikilinkResolver {
  const byPath = new Map<string, string>();
  const byBasename = new Map<string, string[]>();
  for (const path of paths) {
    byPath.set(path.replace(/\.md$/i, "").toLowerCase(), path);
    const base = noteTitle(path).toLowerCase();
    const bucket = byBasename.get(base);
    if (bucket) bucket.push(path);
    else byBasename.set(base, [path]);
  }
  return (target: string) => {
    const cleaned = target.trim();
    if (!cleaned) return null;
    const pathHit = byPath.get(cleaned.toLowerCase());
    if (pathHit) return pathHit;
    const candidates = byBasename.get(cleaned.toLowerCase());
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    const exact = candidates.filter((p) => noteTitle(p) === cleaned);
    const pool = exact.length > 0 ? exact : candidates;
    return [...pool].sort((a, b) => {
      const fa = FOLDER_PRIORITY.indexOf(noteFolder(a));
      const fb = FOLDER_PRIORITY.indexOf(noteFolder(b));
      const ra = fa === -1 ? FOLDER_PRIORITY.length : fa;
      const rb = fb === -1 ? FOLDER_PRIORITY.length : fb;
      if (ra !== rb) return ra - rb;
      return a.localeCompare(b);
    })[0];
  };
}

const WIKILINK_RE = /\[\[([^[\]|#]+)(#[^[\]|]*)?(?:\|([^[\]]*))?\]\]/g;
const FENCE_RE = /^\s*(```|~~~)/;
const INLINE_CODE_RE = /(`+)[^`]*?\1/g;

function walkEligible(
  markdown: string,
  onSlice: (slice: string) => string,
): string {
  const lines = markdown.split("\n");
  let inFence = false;
  const out = lines.map((line) => {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    let result = "";
    let last = 0;
    INLINE_CODE_RE.lastIndex = 0;
    for (const match of line.matchAll(INLINE_CODE_RE)) {
      result += onSlice(line.slice(last, match.index));
      result += match[0];
      last = match.index + match[0].length;
    }
    result += onSlice(line.slice(last));
    return result;
  });
  return out.join("\n");
}

export function rewriteWikilinks(
  markdown: string,
  resolve: WikilinkResolver,
): string {
  return walkEligible(markdown, (slice) =>
    slice.replace(WIKILINK_RE, (_full, target: string, _heading, alias?: string) => {
      const label = (alias ?? "").trim() || target.trim();
      const path = resolve(target);
      if (!path) return `[${label}](#unresolved)`;
      return `[${label}](${noteHref(path)})`;
    }),
  );
}

export function extractWikilinks(markdown: string): string[] {
  const targets: string[] = [];
  walkEligible(markdown, (slice) => {
    for (const match of slice.matchAll(WIKILINK_RE)) {
      targets.push(match[1].trim());
    }
    return slice;
  });
  return targets;
}

export function computeBacklinks(
  notes: { path: string; outgoing: string[] }[],
): Map<string, string[]> {
  const backlinks = new Map<string, Set<string>>();
  for (const note of notes) {
    for (const target of note.outgoing) {
      if (target === note.path) continue;
      const set = backlinks.get(target);
      if (set) set.add(note.path);
      else backlinks.set(target, new Set([note.path]));
    }
  }
  const result = new Map<string, string[]>();
  for (const [target, sources] of backlinks) {
    result.set(
      target,
      [...sources].sort((a, b) => noteTitle(a).localeCompare(noteTitle(b))),
    );
  }
  return result;
}

// Line-level twin of walkEligible's fence state machine. walkEligible rewrites
// inline *slices*, so it cannot answer "is this whole line inside a fence" —
// which is the only question section and prose extraction ask. Same FENCE_RE,
// same toggle, at line granularity: fenced lines are dropped, and a heading or
// bullet inside a code block is therefore invisible to both extractors below.
function* eligibleLines(markdown: string): Generator<string> {
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) yield line;
  }
}

const MARKDOWN_LINK_RE = /!?\[([^\]]*)\]\([^)]*\)/g;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

// Reduce a markdown fragment to the text a person reads: [[a|b]] and [[a]] to
// their label, [x](y) to x, whitespace collapsed.
function plainText(input: string): string {
  return input
    .replace(WIKILINK_RE, (_full, target: string, _heading, alias?: string) =>
      (alias ?? "").trim() || target.trim(),
    )
    .replace(MARKDOWN_LINK_RE, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// Extracts the bullets under a named heading, stopping at the next heading of
// the same or a shallower level (a `###` subsection stays part of the section).
// Skips fenced code and strikethrough bullets, which the vault ritual uses to
// mark resolved questions:
//   ~~…~~ Overtaken by events: … (resolved 2026-07-20)
// A missing section is normal — three of twenty person notes have none — and
// yields [] rather than throwing, so the caller renders nothing at all.
export function extractSectionBullets(
  markdown: string,
  heading: string,
): string[] {
  const target = heading.trim().replace(/^#+\s*/, "").toLowerCase();
  if (!target) return [];
  const bullets: string[] = [];
  let sectionLevel = 0;
  for (const line of eligibleLines(markdown)) {
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      const level = headingMatch[1].length;
      if (sectionLevel > 0) {
        if (level <= sectionLevel) break;
        continue;
      }
      if (headingMatch[2].trim().toLowerCase() === target) sectionLevel = level;
      continue;
    }
    if (sectionLevel === 0) continue;
    const bulletMatch = line.match(BULLET_RE);
    if (!bulletMatch) continue;
    const content = bulletMatch[1].trim();
    if (content.startsWith("~~")) continue;
    const text = plainText(content);
    if (text) bullets.push(text);
  }
  return bullets;
}

// The note's opening prose paragraph, for the roster's secondary line and the
// dossier subtitle. Skips frontmatter (parseFrontmatter already handles the
// notes that have no blank line after the closing `---`), the H1, headings,
// bullets, callouts/quotes, tables, thematic breaks and fenced code; takes the
// first run of plain lines; reduces links to their labels. Returns null when
// the note has no prose paragraph — including the person created from the
// search field, who has no note at all.
export function extractIntro(markdown: string): string | null {
  const { body } = parseFrontmatter(markdown);
  const paragraph: string[] = [];
  for (const line of eligibleLines(body)) {
    const trimmed = line.trim();
    const skip =
      !trimmed ||
      HEADING_RE.test(line) ||
      BULLET_RE.test(line) ||
      trimmed.startsWith(">") ||
      trimmed.startsWith("|") ||
      /^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed);
    if (skip) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(trimmed);
  }
  if (paragraph.length === 0) return null;
  return plainText(paragraph.join(" ")) || null;
}

export type CalloutMarker = { kind: string; title: string };

export function parseCalloutMarker(text: string): CalloutMarker | null {
  const firstLine = text.split("\n")[0];
  const match = firstLine.match(/^\[!([a-zA-Z]+)\][+-]?\s?(.*)$/);
  if (!match) return null;
  return { kind: match[1].toLowerCase(), title: match[2].trim() };
}

export const CALLOUT_MARKER_STRIP_RE = /^\[!\w+\][+-]?\s?[^\n]*\n?/;
