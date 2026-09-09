// The TypeScript appendSection must stay byte-identical to the overnight
// worker's .mjs version: both append sections to the SAME tasks.notes blob
// (the app on dispatch, the worker on result), so any divergence in the
// divider or the trimming rule corrupts a note mid-conversation.
import { describe, expect, it } from "vitest";
import { appendSection, clip } from "@/app/lib/notes";
import {
  appendSection as appendSectionMjs,
  clip as clipMjs,
} from "../overnight/lib.mjs";

describe("clip", () => {
  it("passes short text through untouched", () => {
    expect(clip("hello", 10)).toBe("hello");
  });

  it("truncates with a marker inside the cap", () => {
    const out = clip("x".repeat(100), 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith("[truncated]")).toBe(true);
  });
});

describe("appendSection", () => {
  it("appends a section to existing notes", () => {
    const out = appendSection(
      "old notes",
      "Operator note (2026-07-31)",
      "do the thing",
    );
    expect(out).toBe(
      "old notes\n\n---\n\n## Operator note (2026-07-31)\n\ndo the thing",
    );
  });

  it("handles null/empty notes", () => {
    expect(appendSection(null, "H", "b")).toBe("## H\n\nb");
    expect(appendSection("  ", "H", "b")).toBe("## H\n\nb");
  });

  it("caps the total size, preserving what the user wrote", () => {
    const out = appendSection("user context", "H", "y".repeat(20000), 2000);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out.startsWith("user context")).toBe(true);
    expect(out).toContain("[truncated]");
  });

  it("keeps the new section when over maxLen, trimming old notes", () => {
    const out = appendSection("x".repeat(3000), "H", "body", 2000);
    expect(out).toContain("## H\n\nbody");
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out).toContain("[truncated]");
    // the user's own text lives at the top and its start is kept
    expect(out.startsWith("x")).toBe(true);
  });

  it("clips an oversized body rather than dropping it", () => {
    const out = appendSection("", "H", "y".repeat(300), 120);
    expect(out.startsWith("## H")).toBe(true);
    expect(out).toContain("[truncated]");
  });

  it("matches the overnight worker's .mjs implementation byte for byte", () => {
    const cases: [string | null, string, string, number | undefined][] = [
      ["old notes", "Operator note (2026-07-31)", "do the thing", undefined],
      [null, "H", "b", undefined],
      ["  ", "H", "b", undefined],
      ["user context", "H", "y".repeat(20000), 2000],
      ["x".repeat(3000), "H", "body", 2000],
      ["", "H", "y".repeat(300), 120],
      ["a\n\n---\n\n## H\n\nprevious", "H", "next", 500],
    ];
    for (const [notes, heading, body, maxLen] of cases) {
      const mine =
        maxLen === undefined
          ? appendSection(notes, heading, body)
          : appendSection(notes, heading, body, maxLen);
      const theirs =
        maxLen === undefined
          ? appendSectionMjs(notes, heading, body)
          : appendSectionMjs(notes, heading, body, maxLen);
      expect(mine).toBe(theirs);
    }
    expect(clip("z".repeat(80), 30)).toBe(clipMjs("z".repeat(80), 30));
  });
});
