import { describe, expect, test } from "vitest";

import {
  buildGraphData,
  graphGroup,
  nodesWithinHops,
  type GraphLink,
} from "@/app/lib/brain/graph";

const notes = [
  {
    path: "Home.md",
    title: "Home",
    frontmatter: {},
    outgoing: ["CLAUDE.md", "Journal/A day.md"],
    backlinks: [],
  },
  {
    path: "CLAUDE.md",
    title: "CLAUDE",
    frontmatter: {},
    outgoing: ["Home.md"],
    backlinks: ["Home.md"],
  },
  {
    path: "Journal/A day.md",
    title: "A day",
    frontmatter: {},
    outgoing: ["Journal/A day.md", "Missing.md"],
    backlinks: ["Home.md"],
  },
];

describe("buildGraphData", () => {
  test("creates one node per note with group, inbound count, and href", () => {
    const { nodes } = buildGraphData(notes);
    expect(nodes).toHaveLength(3);

    const home = nodes.find((n) => n.id === "Home.md")!;
    expect(home).toEqual({
      id: "Home.md",
      label: "Home",
      group: "",
      inbound: 0,
      href: "/brain/note/Home",
    });

    const journal = nodes.find((n) => n.id === "Journal/A day.md")!;
    expect(journal.group).toBe("Journal");
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

  test("labels a node from frontmatter when it has a better name", () => {
    const { nodes } = buildGraphData([
      {
        path: "Reels/Video by bilawal.ai.md",
        title: "Video by bilawal.ai",
        frontmatter: { title: "Nano Banana image editing" },
        outgoing: [],
        backlinks: [],
      },
      {
        path: "Reels/Video by raycfu.md",
        title: "Video by raycfu",
        frontmatter: { aliases: "[Agentic OS part 1, Agentic OS]" },
        outgoing: [],
        backlinks: [],
      },
      {
        path: "Reels/Video by nobody.md",
        title: "Video by nobody",
        frontmatter: { type: "reel" },
        outgoing: [],
        backlinks: [],
      },
    ]);
    expect(nodes.map((n) => n.label)).toEqual([
      "Nano Banana image editing",
      "Agentic OS part 1",
      "Video by nobody",
    ]);
  });

  test("groups nodes by the path override, not just the folder", () => {
    const { nodes } = buildGraphData([
      {
        path: "Courses/Canvas Reports/2026-08-27.md",
        title: "2026-08-27",
        frontmatter: {},
        outgoing: [],
        backlinks: [],
      },
      {
        path: "Topics/Archive map.md",
        title: "Archive map",
        frontmatter: {},
        outgoing: [],
        backlinks: [],
      },
    ]);
    expect(nodes.map((n) => n.group)).toEqual(["Canvas Reports", "Archive map"]);
  });
});

describe("graphGroup", () => {
  test("uses the top-level folder, and '' for a root note", () => {
    expect(graphGroup("People/Maya Chen.md")).toBe("People");
    expect(graphGroup("Courses/CPSC 330/CPSC 330.md")).toBe("Courses");
    expect(graphGroup("Home.md")).toBe("");
  });

  test("splits the Canvas reports out of Courses", () => {
    expect(graphGroup("Courses/Canvas Reports/latest.md")).toBe(
      "Canvas Reports",
    );
  });

  test("puts the archive hub and its category notes in one group", () => {
    expect(graphGroup("Topics/Archive map.md")).toBe("Archive map");
    expect(graphGroup("Topics/Archive categories/Emma (archive).md")).toBe(
      "Archive map",
    );
    expect(graphGroup("Topics/Football.md")).toBe("Topics");
  });
});

describe("nodesWithinHops", () => {
  // a - b - c - d, plus an island e - f
  const links: GraphLink[] = [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
    { source: "c", target: "d" },
    { source: "e", target: "f" },
  ];

  test("walks undirected edges out to the given depth", () => {
    expect([...nodesWithinHops(links, "a", 1)].sort()).toEqual(["a", "b"]);
    expect([...nodesWithinHops(links, "a", 2)].sort()).toEqual(["a", "b", "c"]);
    expect([...nodesWithinHops(links, "d", 2)].sort()).toEqual(["b", "c", "d"]);
  });

  test("depth 0 is the focus note alone", () => {
    expect([...nodesWithinHops(links, "a", 0)]).toEqual(["a"]);
  });

  test("never leaves the focus note's component", () => {
    expect([...nodesWithinHops(links, "a", 9)]).not.toContain("e");
  });

  test("an unknown focus note resolves to itself", () => {
    expect([...nodesWithinHops(links, "zz", 3)]).toEqual(["zz"]);
  });

  test("does not walk through a node outside the allowed set", () => {
    const allowed = new Set(["a", "b", "d"]);
    expect([...nodesWithinHops(links, "a", 3, { allowed })].sort()).toEqual([
      "a",
      "b",
    ]);
  });

  // The caller owns the focus exemption: a focus left out of the allowed set
  // has no walkable edges, which is why GraphClient forces it back in.
  test("a focus note missing from the allowed set stands alone", () => {
    expect([
      ...nodesWithinHops(links, "a", 3, { allowed: new Set(["b", "c"]) }),
    ]).toEqual(["a"]);
  });

  // b - c - d walks outwards from b; a - b and e - b only point at it.
  const directed: GraphLink[] = [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
    { source: "c", target: "d" },
    { source: "e", target: "b" },
  ];

  test("direction 'out' follows only the links the notes write", () => {
    expect(
      [...nodesWithinHops(directed, "b", 2, { direction: "out" })].sort(),
    ).toEqual(["b", "c", "d"]);
  });

  test("direction 'out' still respects the depth", () => {
    expect(
      [...nodesWithinHops(directed, "b", 1, { direction: "out" })].sort(),
    ).toEqual(["b", "c"]);
  });

  test("direction 'out' leaves a note with no outgoing links alone", () => {
    expect([...nodesWithinHops(directed, "d", 3, { direction: "out" })]).toEqual(
      ["d"],
    );
  });

  test("'both' is the default and does pick the inbound neighbours up", () => {
    expect([...nodesWithinHops(directed, "b", 1)].sort()).toEqual([
      "a",
      "b",
      "c",
      "e",
    ]);
    expect(
      [...nodesWithinHops(directed, "b", 1, { direction: "both" })].sort(),
    ).toEqual(["a", "b", "c", "e"]);
  });

  test("direction 'out' honours the allowed set too", () => {
    expect([
      ...nodesWithinHops(directed, "b", 3, {
        direction: "out",
        allowed: new Set(["b", "c"]),
      }),
    ].sort()).toEqual(["b", "c"]);
  });
});
