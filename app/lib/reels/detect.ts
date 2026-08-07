// Reel capture (docs/reel-capture-plan.md), pure logic — unit-tested in
// __tests__/reel-detect.test.ts. URL detection, the vault path, and the
// record document. No fetching or GitHub here.

import { sanitizeCaptureTitle } from "@/app/lib/mcp/capture";

// instagram.com/reel|reels|p|tv/<shortcode>/ — the four share-sheet shapes.
// Shortcodes are [A-Za-z0-9_-]. Trailing path/query is tolerated and dropped.
const INSTAGRAM_RE =
  /https?:\/\/(?:www\.)?instagram\.com\/(reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i;

export type ReelRef = { url: string; shortcode: string };

// The first Instagram post/reel URL in shared text, normalized to its
// canonical /reel/<code>/ form (drops tracking query + extra path).
export function extractInstagramUrl(text: string): ReelRef | null {
  const match = INSTAGRAM_RE.exec(String(text ?? ""));
  if (!match) return null;
  const shortcode = match[2];
  return { url: `https://www.instagram.com/reel/${shortcode}/`, shortcode };
}

export function isInstagramUrl(text: string): boolean {
  return extractInstagramUrl(text) !== null;
}

// Link detection over a capture's full reach: the inline note text first,
// then the shared file's decoded text (oversized shares keep their URL in
// the attachment — the 2026-07-24 Instagram share format ships a page dump
// past the inline cap, which is why text alone is not enough).
export function reelRefFromCapture(input: {
  text: string;
  fileText?: string | null;
}): ReelRef | null {
  return (
    extractInstagramUrl(input.text) ??
    (input.fileText ? extractInstagramUrl(input.fileText) : null)
  );
}

// The first ![[embed]] target in markdown (dropping any |alias or #heading).
// Older link captures store the shared URL in an embedded attachment rather
// than the note body, so the reel resolver follows this to the attachment.
export function firstEmbed(markdown: string): string | null {
  const match = String(markdown ?? "").match(/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/);
  return match ? match[1].trim() : null;
}

// Vault note path for a reel record: Reels/<safe title>[ -N].md, sharing the
// create-only writer + traversal-safe sanitizer with capture_to_brain.
export function reelNotePath(title: string, attempt = 1): string {
  const safe = sanitizeCaptureTitle(title);
  const base = safe.ok && safe.value ? safe.value : "reel";
  const suffix = attempt > 1 ? ` -${attempt}` : "";
  return `Reels/${base}${suffix}.md`;
}

// Cover thumbnail lives beside the note as a committed vault attachment
// (like share-sheet images), so the note's ![[embed]] resolves offline with
// no signed-URL expiry. ext is sniffed/whitelisted by the caller.
export function reelThumbnailPath(title: string, ext: string, attempt = 1): string {
  const safe = sanitizeCaptureTitle(title);
  const base = safe.ok && safe.value ? safe.value : "reel";
  const suffix = attempt > 1 ? ` -${attempt}` : "";
  const cleanExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : "jpg";
  return `Reels/attachments/${base}${suffix}.${cleanExt}`;
}

// The wikilink-embeddable basename of a committed vault path.
export function embedFor(path: string): string {
  return `![[${path.split("/").pop() ?? path}]]`;
}

// A dead-lettered reel (private, removed, or undownloadable) gets a visible
// create-only failure note, so the outcome is reported, not silent.
export function reelFailureNotePath(shortcode: string, attempt = 1): string {
  const safe = /^[A-Za-z0-9_-]{1,32}$/.test(shortcode) ? shortcode : "reel";
  const suffix = attempt > 1 ? ` -${attempt}` : "";
  return `Reels/failed/${safe}${suffix}.md`;
}

export function buildReelFailureDocument(input: {
  url: string;
  error: string;
  stampIso: string;
}): string {
  return [
    "---",
    "type: reel-failed",
    `source: "${input.url.replace(/"/g, '\\"')}"`,
    `captured: ${input.stampIso}`,
    "---",
    "",
    "# Reel couldn't be processed",
    "",
    `[watch on instagram](${input.url})`,
    "",
    "The home worker couldn't fetch or transcribe this reel — a private account, a removed post, or a download error. Re-share it, or run process_reel, to retry.",
    "",
    "```",
    input.error.trim() || "unknown error",
    "```",
    "",
  ].join("\n");
}

export type ReelFrame = { at?: string; describe?: string; text?: string };

export type ReelRecord = {
  url: string;
  title: string;
  author?: string | null;
  caption?: string | null;
  durationSec?: number | null;
  transcript: string;
  frames?: ReelFrame[];
  thumbnailEmbed?: string | null; // vault-relative ![[embed]] or markdown img
  stampIso: string;
  via?: string;
};

function yamlEscape(value: string): string {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

// One self-contained vault note: frontmatter for /brain filtering + search,
// then the source link, caption, transcript, and the on-screen record.
export function buildReelDocument(record: ReelRecord): string {
  const fm = [
    "---",
    "type: reel",
    `source: ${yamlEscape(record.url)}`,
    record.author ? `author: ${yamlEscape(record.author)}` : null,
    typeof record.durationSec === "number"
      ? `duration_sec: ${Math.round(record.durationSec)}`
      : null,
    `captured: ${record.stampIso}`,
    "---",
  ]
    .filter(Boolean)
    .join("\n");

  const parts: string[] = [fm, "", `# ${record.title}`, "", `[watch on instagram](${record.url})`];
  if (record.thumbnailEmbed) parts.push("", record.thumbnailEmbed);
  if (record.caption?.trim()) parts.push("", "## Caption", "", record.caption.trim());

  parts.push("", "## Transcript", "", record.transcript.trim() || "_(no speech detected)_");

  const frames = (record.frames ?? []).filter((f) => f.describe?.trim() || f.text?.trim());
  if (frames.length) {
    parts.push("", "## On screen");
    for (const frame of frames) {
      const label = frame.at ? `**${frame.at}** — ` : "";
      if (frame.describe?.trim()) parts.push("", `${label}${frame.describe.trim()}`);
      if (frame.text?.trim()) parts.push(`> ${frame.text.trim().replace(/\n+/g, " ")}`);
    }
  }

  parts.push("", `*Reel record via ${record.via ?? "home worker"}.*`, "");
  return parts.join("\n");
}
