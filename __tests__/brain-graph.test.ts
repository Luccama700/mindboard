import { describe, expect, test } from "vitest";

import { buildGraphData } from "@/app/lib/brain/graph";

const notes = [
  {
    path: "Home.md",
    folder: "",
    title: "Home",
    outgoing: ["CLAUDE.md", "Journal/A day.md"],
    backlinks: [],
  },
  {
    path: "CLAUDE.md",
    folder: "",
    title: "CLAUDE",
    outgoing: ["Home.md"],
    backlinks: ["Home.md"],
  },
  {
    path: "Journal/A day.md",
    folder: "Journal",
    title: "A day",
    outgoing: ["Journal/A day.md", "Missing.md"],
    backlinks: ["Home.md"],
  },
];

describe("buildGraphData", () => {
  test("creates one node per note with folder, inbound count, and href", () => {
    const { nodes } = buildGraphData(notes);
    expect(nodes).toHaveLength(3);

    const home = nodes.find((n) => n.id === "Home.md")!;
    expect(home).toEqual({
      id: "Home.md",
      label: "Home",
      folder: "",
      inbound: 0,
      href: "/brain/note/Home",
    });

    const journal = nodes.find((n) => n.id === "Journal/A day.md")!;
    expect(journal.folder).toBe("Journal");
    expect(journal.inbound).toBe(1);
    expect(journal.href).toBe("/brain/note/Journal/A%20day");
  });

  test("creates one link per resolved outgoing wikilink", () => {
    const { links } = buildGraphData(notes);
    expect(links).toContainEqual({ source: "Home.md", target: "CLAUDE.md" });
    expect(links).toContainEqual({
      source: "Home.md",
      target: "Journal/A day.md",
    });
    expect(links).toContainEqual({ source: "CLAUDE.md", target: "Home.md" });
  });

  test("drops self-links and links to notes outside the corpus", () => {
    const { links } = buildGraphData(notes);
    expect(links).toHaveLength(3);
    expect(
      links.some((l) => l.source === l.target || l.target === "Missing.md"),
    ).toBe(false);
  });

  test("handles an empty corpus", () => {
    expect(buildGraphData([])).toEqual({ nodes: [], links: [] });
  });
});
