import { describe, expect, test } from "vitest";

import {
  buildReelDocument,
  buildReelFailureDocument,
  embedFor,
  extractInstagramUrl,
  isInstagramUrl,
  reelFailureNotePath,
  reelNotePath,
  reelThumbnailPath,
} from "@/app/lib/reels/detect";

describe("extractInstagramUrl", () => {
  test("matches the four share shapes and normalizes to /reel/<code>/", () => {
    for (const [input, code] of [
      ["https://www.instagram.com/reel/ABC123def/", "ABC123def"],
      ["https://instagram.com/reels/xy_Z-9/?igsh=track", "xy_Z-9"],
      ["check this https://www.instagram.com/p/CoolPost1/ out", "CoolPost1"],
      ["https://www.instagram.com/tv/LongVid99/", "LongVid99"],
    ] as const) {
      const ref = extractInstagramUrl(input);
      expect(ref?.shortcode).toBe(code);
      expect(ref?.url).toBe(`https://www.instagram.com/reel/${code}/`);
    }
  });

  test("ignores non-instagram and profile URLs", () => {
    expect(extractInstagramUrl("https://instagram.com/someuser")).toBeNull();
    expect(extractInstagramUrl("https://tiktok.com/@x/video/1")).toBeNull();
    expect(extractInstagramUrl("just a note, no link")).toBeNull();
    expect(isInstagramUrl("https://youtube.com/watch?v=x")).toBe(false);
  });

  test("finds the link inside a longer captured note body", () => {
    const note = "Saved from Instagram\n\nhttps://www.instagram.com/reel/GfX_1/\n\n#cooking";
    expect(extractInstagramUrl(note)?.shortcode).toBe("GfX_1");
  });
});

describe("reelNotePath / reelThumbnailPath", () => {
  test("note path is Reels/<safe title>.md with -N on retry", () => {
    expect(reelNotePath("Easy pasta trick")).toBe("Reels/Easy pasta trick.md");
    expect(reelNotePath("Easy pasta trick", 2)).toBe("Reels/Easy pasta trick -2.md");
  });

  test("falls back to 'reel' for empty/traversal titles", () => {
    expect(reelNotePath("../../etc/passwd")).toBe("Reels/reel.md");
    expect(reelNotePath("")).toBe("Reels/reel.md");
  });

  test("thumbnail path sits under Reels/attachments with a safe extension", () => {
    expect(reelThumbnailPath("Clip", "jpg")).toBe("Reels/attachments/Clip.jpg");
    expect(reelThumbnailPath("Clip", "gif/../x")).toBe("Reels/attachments/Clip.jpg");
    expect(reelThumbnailPath("Clip", "png", 3)).toBe("Reels/attachments/Clip -3.png");
  });

  test("embedFor takes the basename as a wikilink", () => {
    expect(embedFor("Reels/attachments/Clip.jpg")).toBe("![[Clip.jpg]]");
  });
});

describe("buildReelDocument", () => {
  const base = {
    url: "https://www.instagram.com/reel/ABC/",
    title: "Knife skills",
    author: "chef.jo",
    caption: "3 cuts everyone should know",
    durationSec: 42,
    transcript: "First, the julienne.",
    stampIso: "2026-07-18 09:30",
  };

  test("carries frontmatter, source link, caption, and transcript", () => {
    const doc = buildReelDocument(base);
    expect(doc).toContain("type: reel");
    expect(doc).toContain('source: "https://www.instagram.com/reel/ABC/"');
    expect(doc).toContain("duration_sec: 42");
    expect(doc).toContain("[watch on instagram](https://www.instagram.com/reel/ABC/)");
    expect(doc).toContain("## Caption");
    expect(doc).toContain("## Transcript\n\nFirst, the julienne.");
  });

  test("renders frame descriptions + OCR under On screen, skipping empty frames", () => {
    const doc = buildReelDocument({
      ...base,
      thumbnailEmbed: "![[Knife skills.jpg]]",
      frames: [
        { at: "frame 1", describe: "hands dicing an onion", text: "JULIENNE" },
        { at: "frame 2", describe: "", text: "" },
      ],
    });
    expect(doc).toContain("![[Knife skills.jpg]]");
    expect(doc).toContain("## On screen");
    expect(doc).toContain("**frame 1** — hands dicing an onion");
    expect(doc).toContain("> JULIENNE");
    expect(doc).not.toContain("frame 2");
  });

  test("no-speech reel still produces a note via its caption", () => {
    const doc = buildReelDocument({ ...base, transcript: "" });
    expect(doc).toContain("_(no speech detected)_");
    expect(doc).toContain("## Caption");
  });
});

describe("reel failure record", () => {
  test("path is Reels/failed/<shortcode>.md, sanitized", () => {
    expect(reelFailureNotePath("GfX_1")).toBe("Reels/failed/GfX_1.md");
    expect(reelFailureNotePath("../evil")).toBe("Reels/failed/reel.md");
    expect(reelFailureNotePath("GfX_1", 2)).toBe("Reels/failed/GfX_1 -2.md");
  });

  test("document carries the link, error, and a retry hint", () => {
    const doc = buildReelFailureDocument({
      url: "https://www.instagram.com/reel/GfX_1/",
      error: "yt-dlp: video unavailable",
      stampIso: "2026-07-18 09:30",
    });
    expect(doc).toContain("type: reel-failed");
    expect(doc).toContain("[watch on instagram](https://www.instagram.com/reel/GfX_1/)");
    expect(doc).toContain("yt-dlp: video unavailable");
    expect(doc).toContain("process_reel");
  });
});
