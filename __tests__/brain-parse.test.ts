import { describe, expect, test } from "vitest";

import {
  buildResolver,
  computeBacklinks,
  extractIntro,
  extractSectionBullets,
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

// Fixtures modelled on the real People/*.md notes (docs/people-plan.md §6):
// a note with the standard section plus a resolved (struck-through) question,
// a note with no `## Open questions` at all, Emma's missing blank line after
// the closing `---`, and Carla's wikilink-opening intro.
const DAVI = `---
type: person
updated: 2026-08-09
---

# Davi

Cousin, 14, writes short stories. Lives with [[Denise]] in Santos.

Second paragraph, not the intro.

## Open questions

- does he still want the writing feedback?
- ~~does he still play [[Hytale]]?~~ Overtaken by events: he quit (resolved 2026-07-20)
- [[Denise|his mom]] asked for an update — send one
- \`nothing\` here is still a bullet

## Threads

- unrelated bullet
`;

const LUCIANO = `---
type: person
---

# Luciano

Clubbing friend from the Faculdade crowd.

## Threads

- went to Bemvindo in July
`;

const EMMA = `---
type: person
updated: 2026-08-02
---
# Emma

Isabella's friend, does ceramics on weekends.

## Open questions

- is the studio still running?
`;

const CARLA = `---
type: person
---

# Carla

[[Lucca Martins de Andrade|Lucca]]'s aunt, hosts the Sunday lunches.
`;

const NO_PROSE = `---
type: person
---

# Vini

## Open questions

- who introduced us?
`;

describe("extractSectionBullets", () => {
  const cases: [string, string, string, string[]][] = [
    [
      "takes the section's bullets and skips struck-through (resolved) ones",
      DAVI,
      "Open questions",
      [
        "does he still want the writing feedback?",
        "his mom asked for an update — send one",
        "`nothing` here is still a bullet",
      ],
    ],
    [
      "stops at the next heading rather than bleeding into it",
      DAVI,
      "Threads",
      ["unrelated bullet"],
    ],
    ["a missing section is normal and yields []", LUCIANO, "Open questions", []],
    [
      "matches the heading with no blank line after the frontmatter",
      EMMA,
      "Open questions",
      ["is the studio still running?"],
    ],
    ["is case-insensitive on the heading", DAVI, "open QUESTIONS", [
      "does he still want the writing feedback?",
      "his mom asked for an update — send one",
      "`nothing` here is still a bullet",
    ]],
    ["an empty heading argument yields []", DAVI, "  ", []],
  ];

  test.each(cases)("%s", (_label, markdown, heading, expected) => {
    expect(extractSectionBullets(markdown, heading)).toEqual(expected);
  });

  test("ignores headings and bullets inside fenced code", () => {
    const md = [
      "## Open questions",
      "",
      "```md",
      "## Threads",
      "- fenced bullet",
      "```",
      "",
      "- real bullet",
    ].join("\n");
    expect(extractSectionBullets(md, "Open questions")).toEqual([
      "real bullet",
    ]);
  });

  test("a deeper subheading stays inside the section", () => {
    const md = "## Open questions\n\n- a\n\n### later\n\n- b\n\n## Threads\n\n- c";
    expect(extractSectionBullets(md, "Open questions")).toEqual(["a", "b"]);
  });
});

describe("extractIntro", () => {
  const cases: [string, string, string | null][] = [
    [
      "first prose paragraph, wikilinks reduced to labels",
      DAVI,
      "Cousin, 14, writes short stories. Lives with Denise in Santos.",
    ],
    [
      "no blank line after the closing frontmatter fence",
      EMMA,
      "Isabella's friend, does ceramics on weekends.",
    ],
    [
      "an intro opening with an aliased wikilink renders the alias",
      CARLA,
      "Lucca's aunt, hosts the Sunday lunches.",
    ],
    ["a note with no prose paragraph is null", NO_PROSE, null],
    ["an empty note is null", "", null],
    ["a note that is only frontmatter is null", "---\ntype: person\n---\n", null],
  ];

  test.each(cases)("%s", (_label, markdown, expected) => {
    expect(extractIntro(markdown)).toBe(expected);
  });

  test("joins a wrapped paragraph and stops at the blank line", () => {
    const md = "# X\n\nfirst line\nsecond line\n\nlater paragraph";
    expect(extractIntro(md)).toBe("first line second line");
  });

  test("skips callouts, tables, rules and fenced code before the prose", () => {
    const md = [
      "# X",
      "",
      "> [!note] a callout",
      "",
      "| a | b |",
      "",
      "***",
      "",
      "```ts",
      "const notProse = 1;",
      "```",
      "",
      "the actual intro",
    ].join("\n");
    expect(extractIntro(md)).toBe("the actual intro");
  });

  test("reduces markdown links to their label", () => {
    expect(extractIntro("# X\n\nsee [the plan](https://example.com/a) first")).toBe(
      "see the plan first",
    );
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
