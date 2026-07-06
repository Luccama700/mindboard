import { describe, expect, test } from "vitest";

import {
  buildResolver,
  computeBacklinks,
  extractWikilinks,
  noteFolder,
  noteHref,
  noteTitle,
  parseCalloutMarker,
  parseFrontmatter,
  rewriteWikilinks,
} from "@/app/lib/brain/parse";

describe("parseFrontmatter", () => {
  test("parses a flat frontmatter block and strips it from the body", () => {
    const raw = "---\ntype: journal\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n\n# Title\n\nBody.";
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({
      type: "journal",
      created: "2026-07-01",
      updated: "2026-07-01",
    });
    expect(body).toBe("\n# Title\n\nBody.");
  });

  test("returns the raw text untouched when there is no frontmatter", () => {
    const raw = "# Title\n\nBody.";
    expect(parseFrontmatter(raw)).toEqual({ frontmatter: {}, body: raw });
  });

  test("treats an unterminated block as plain body", () => {
    const raw = "---\ntype: note\n\n# Title";
    expect(parseFrontmatter(raw)).toEqual({ frontmatter: {}, body: raw });
  });

  test("strips surrounding quotes from values", () => {
    const raw = '---\nstatus: "in progress"\nname: \'x\'\n---\nbody';
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({ status: "in progress", name: "x" });
  });

  test("values containing colons are preserved", () => {
    const raw = "---\nsource: https://example.com/a\n---\nbody";
    expect(parseFrontmatter(raw).frontmatter).toEqual({
      source: "https://example.com/a",
    });
  });
});

describe("noteHref / noteTitle / noteFolder", () => {
  test("encodes each segment and strips .md", () => {
    expect(noteHref("Journal/2026-07-01 Setup and first interview.md")).toBe(
      "/brain/note/Journal/2026-07-01%20Setup%20and%20first%20interview",
    );
  });

  test("handles root notes and nested folders", () => {
    expect(noteHref("Home.md")).toBe("/brain/note/Home");
    expect(noteHref("Topics/Deep/Nested.md")).toBe(
      "/brain/note/Topics/Deep/Nested",
    );
  });

  test("title and folder helpers", () => {
    expect(noteTitle("Journal/A day.md")).toBe("A day");
    expect(noteFolder("Journal/A day.md")).toBe("Journal");
    expect(noteFolder("Home.md")).toBe("");
  });
});

describe("buildResolver", () => {
  const resolve = buildResolver([
    "Home.md",
    "CLAUDE.md",
    "Journal/2026-07-01 Setup and first interview.md",
    "Archive/Welcome.md",
  ]);

  test("resolves by basename", () => {
    expect(resolve("CLAUDE")).toBe("CLAUDE.md");
    expect(resolve("2026-07-01 Setup and first interview")).toBe(
      "Journal/2026-07-01 Setup and first interview.md",
    );
  });

  test("is case-insensitive", () => {
    expect(resolve("claude")).toBe("CLAUDE.md");
    expect(resolve("home")).toBe("Home.md");
  });

  test("accepts full-path targets", () => {
    expect(resolve("Archive/Welcome")).toBe("Archive/Welcome.md");
  });

  test("returns null on a miss", () => {
    expect(resolve("Nonexistent")).toBeNull();
    expect(resolve("")).toBeNull();
  });

  test("duplicate basenames prefer folder priority (root before Archive)", () => {
    const dup = buildResolver(["Welcome.md", "Archive/Welcome.md"]);
    expect(dup("Welcome")).toBe("Welcome.md");
    const dup2 = buildResolver(["Archive/Plan.md", "Projects/Plan.md"]);
    expect(dup2("Plan")).toBe("Projects/Plan.md");
  });

  test("duplicate basenames prefer exact-case match", () => {
    const dup = buildResolver(["Topics/claude.md", "People/CLAUDE.md"]);
    expect(dup("CLAUDE")).toBe("People/CLAUDE.md");
  });
});

describe("rewriteWikilinks", () => {
  const resolve = buildResolver([
    "Home.md",
    "CLAUDE.md",
    "Journal/2026-07-01 Setup and first interview.md",
  ]);

  test("rewrites a plain wikilink", () => {
    expect(rewriteWikilinks("See [[CLAUDE]].", resolve)).toBe(
      "See [CLAUDE](/brain/note/CLAUDE).",
    );
  });

  test("rewrites an aliased wikilink", () => {
    expect(rewriteWikilinks("[[CLAUDE|the rules]]", resolve)).toBe(
      "[the rules](/brain/note/CLAUDE)",
    );
  });

  test("drops heading anchors but keeps the link", () => {
    expect(rewriteWikilinks("[[Home#Sessions]]", resolve)).toBe(
      "[Home](/brain/note/Home)",
    );
  });

  test("percent-encodes targets with spaces", () => {
    expect(
      rewriteWikilinks("[[2026-07-01 Setup and first interview]]", resolve),
    ).toBe(
      "[2026-07-01 Setup and first interview](/brain/note/Journal/2026-07-01%20Setup%20and%20first%20interview)",
    );
  });

  test("marks unresolved wikilinks", () => {
    expect(rewriteWikilinks("[[Missing note]]", resolve)).toBe(
      "[Missing note](#unresolved)",
    );
  });

  test("leaves wikilinks inside code fences untouched", () => {
    const md = "before\n```\n[[CLAUDE]]\n```\nafter [[CLAUDE]]";
    expect(rewriteWikilinks(md, resolve)).toBe(
      "before\n```\n[[CLAUDE]]\n```\nafter [CLAUDE](/brain/note/CLAUDE)",
    );
  });

  test("leaves wikilinks inside inline code untouched", () => {
    expect(rewriteWikilinks("use `[[CLAUDE]]` to link [[Home]]", resolve)).toBe(
      "use `[[CLAUDE]]` to link [Home](/brain/note/Home)",
    );
  });

  test("rewrites multiple wikilinks on one line", () => {
    expect(rewriteWikilinks("[[Home]] and [[CLAUDE]]", resolve)).toBe(
      "[Home](/brain/note/Home) and [CLAUDE](/brain/note/CLAUDE)",
    );
  });
});

describe("extractWikilinks", () => {
  test("extracts targets, skipping code", () => {
    const md = "[[Home]] `[[skip]]`\n```\n[[also skip]]\n```\n[[CLAUDE|alias]] [[Missing]]";
    expect(extractWikilinks(md)).toEqual(["Home", "CLAUDE", "Missing"]);
  });
});

describe("computeBacklinks", () => {
  test("collects, dedupes, excludes self-links, and sorts by title", () => {
    const backlinks = computeBacklinks([
      { path: "Home.md", outgoing: ["CLAUDE.md", "Journal/A.md"] },
      { path: "Journal/A.md", outgoing: ["CLAUDE.md", "CLAUDE.md", "Journal/A.md"] },
      { path: "CLAUDE.md", outgoing: [] },
    ]);
    expect(backlinks.get("CLAUDE.md")).toEqual(["Journal/A.md", "Home.md"]);
    expect(backlinks.get("Journal/A.md")).toEqual(["Home.md"]);
    expect(backlinks.get("Home.md")).toBeUndefined();
  });
});

describe("parseCalloutMarker", () => {
  test("parses kind and title", () => {
    expect(parseCalloutMarker("[!warning] Watch out")).toEqual({
      kind: "warning",
      title: "Watch out",
    });
  });

  test("parses a bare kind with no title", () => {
    expect(parseCalloutMarker("[!note]")).toEqual({ kind: "note", title: "" });
  });

  test("parses foldable markers", () => {
    expect(parseCalloutMarker("[!tip]- Folded")).toEqual({
      kind: "tip",
      title: "Folded",
    });
  });

  test("returns null for a plain blockquote", () => {
    expect(parseCalloutMarker("just a quote")).toBeNull();
    expect(parseCalloutMarker("[not!] a callout")).toBeNull();
  });
});
