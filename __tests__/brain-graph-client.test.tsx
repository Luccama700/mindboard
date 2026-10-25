import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { buildGraphData, type GraphData } from "@/app/lib/brain/graph";

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => nav.params,
}));

// The canvas renderer needs a real browser; the stub reports what it was
// handed, which is the whole contract between the lens and the graph. The
// tooltip div injects the nodeLabel string exactly the way float-tooltip does
// (d3 .html()), so an unescaped label would become live DOM here too.
vi.mock("@/app/brain/graph/force-graph-wrapper", () => ({
  ForceGraph: ({
    graphData,
    nodeLabel,
  }: {
    graphData: { nodes: unknown[]; links: unknown[] };
    nodeLabel?: (node: unknown) => string;
  }) => (
    <div
      data-testid="force-graph"
      data-nodes={graphData.nodes.length}
      data-links={graphData.links.length}
    >
      <div
        data-testid="tooltip"
        dangerouslySetInnerHTML={{
          __html:
            nodeLabel && graphData.nodes.length > 0
              ? nodeLabel(graphData.nodes[0])
              : "",
        }}
      />
    </div>
  ),
}));

function note(path: string, outgoing: string[] = []) {
  return {
    path,
    title: path.split("/").pop()!.replace(/\.md$/, ""),
    frontmatter: {},
    outgoing,
    backlinks: [],
  };
}

// Home - Maya, the archive hub chain, a Diary pair, and Areas/Work.md reachable
// from Home only through a Papers note (hidden by default).
const data = buildGraphData([
  note("Home.md", ["People/Maya Chen.md"]),
  note("People/Maya Chen.md"),
  note("Topics/Archive map.md", ["Topics/Archive categories/Emma (archive).md"]),
  note("Topics/Archive categories/Emma (archive).md", [
    "Archive/2026-07-09 The whole story.md",
    "Reels/Video by someone.md",
  ]),
  note("Archive/2026-07-09 The whole story.md"),
  note("Reels/Video by someone.md"),
  note("Courses/Canvas Reports/2026-08-27.md"),
  note("Diary/Diary.md", ["Diary/2026-08-27.md"]),
  note("Diary/2026-08-27.md"),
  note("Areas/Work.md"),
  note("Papers/Attention is all you need.md", ["Home.md", "Areas/Work.md"]),
]);

// Home only points AT the hub, so it is an undirected depth-1 neighbour and an
// out-only non-neighbour: the whole reason dir=out exists.
const directed = buildGraphData([
  note("Topics/Archive map.md", [
    "Topics/Archive categories/Emma (archive).md",
  ]),
  note("Topics/Archive categories/Emma (archive).md", [
    "Archive/2026-07-09 The whole story.md",
  ]),
  note("Archive/2026-07-09 The whole story.md"),
  note("Home.md", ["Topics/Archive map.md"]),
]);

async function renderGraph(graph: GraphData = data) {
  const { GraphClient } = await import("@/app/brain/graph/graph-client");
  return render(<GraphClient data={graph} />);
}

function graphCounts() {
  const el = screen.getByTestId("force-graph");
  return {
    nodes: Number(el.getAttribute("data-nodes")),
    links: Number(el.getAttribute("data-links")),
  };
}

function chip(name: RegExp) {
  return screen.getByRole("button", { name });
}

function focusPill(): HTMLElement {
  return screen.getByText("focus:").parentElement!;
}

describe("GraphClient", () => {
  beforeAll(() => {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  beforeEach(() => {
    // the hidden set is module state, read from storage once per page load
    vi.resetModules();
    window.localStorage.clear();
    nav.params = new URLSearchParams();
    window.history.replaceState(null, "", "/brain/graph");
  });

  afterEach(() => {
    cleanup();
  });

  test("shows one chip per present group with whole-vault counts", async () => {
    await renderGraph();

    expect(chip(/^archive map 2$/i)).toBeDefined();
    expect(chip(/^diary 2$/i)).toBeDefined();
    expect(chip(/^root 1$/i)).toBeDefined();
    expect(chip(/^canvas reports 1$/i)).toBeDefined();
    expect(chip(/^papers 1$/i)).toBeDefined();
    expect(screen.queryByRole("button", { name: /^courses/i })).toBeNull();
  });

  test("opens with the operational groups hidden and the rest shown", async () => {
    await renderGraph();

    expect(chip(/^papers 1$/i).getAttribute("aria-pressed")).toBe("false");
    expect(chip(/^canvas reports 1$/i).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(chip(/^people 1$/i).getAttribute("aria-pressed")).toBe("true");
    // 11 notes less the hidden Papers note and Canvas report
    expect(graphCounts().nodes).toBe(9);
  });

  test("a chip tap hides its group and persists the choice", async () => {
    const { unmount } = await renderGraph();

    fireEvent.click(chip(/^diary 2$/i));
    expect(graphCounts().nodes).toBe(7);
    expect(
      JSON.parse(window.localStorage.getItem("brain-graph-groups")!).hidden,
    ).toContain("Diary");

    unmount();
    vi.resetModules();
    await renderGraph();
    expect(chip(/^diary 2$/i).getAttribute("aria-pressed")).toBe("false");
    expect(graphCounts().nodes).toBe(7);
  });

  test("showing every default group means nothing is hidden", async () => {
    window.localStorage.setItem(
      "brain-graph-groups",
      JSON.stringify({
        shown: [
          "Papers",
          "Daily Briefs",
          "Canvas Reports",
          "Inbox",
          "Templates",
        ],
        hidden: [],
      }),
    );
    await renderGraph();

    expect(chip(/^papers 1$/i).getAttribute("aria-pressed")).toBe("true");
    expect(graphCounts().nodes).toBe(11);
  });

  test("only the deltas from the defaults are persisted", async () => {
    await renderGraph();

    fireEvent.click(chip(/^papers 1$/i));
    fireEvent.click(chip(/^diary 2$/i));
    expect(
      JSON.parse(window.localStorage.getItem("brain-graph-groups")!),
    ).toEqual({ shown: ["Papers"], hidden: ["Diary"] });
  });

  // the reason the deltas are stored instead of the resolved set
  test("a group added to the defaults later still starts hidden", async () => {
    window.localStorage.setItem(
      "brain-graph-groups",
      JSON.stringify({ shown: ["Papers"], hidden: [] }),
    );
    await renderGraph();

    expect(chip(/^papers 1$/i).getAttribute("aria-pressed")).toBe("true");
    expect(chip(/^canvas reports 1$/i).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  test("the focus lens keeps only the notes within the given hops", async () => {
    nav.params = new URLSearchParams("focus=Topics/Archive map.md&depth=1");
    await renderGraph();

    expect(graphCounts()).toEqual({ nodes: 2, links: 1 });
    expect(focusPill().textContent).toContain("archive map");
    expect(screen.getByRole("button", { name: "clear" })).toBeDefined();
  });

  test("depth 2 reaches the items a category note indexes", async () => {
    nav.params = new URLSearchParams("focus=Topics/Archive map.md&depth=2");
    await renderGraph();

    expect(graphCounts()).toEqual({ nodes: 4, links: 3 });
  });

  test("depth defaults to 2 and a missing focus note shows the full graph", async () => {
    nav.params = new URLSearchParams("focus=Topics/Archive map.md");
    await renderGraph();
    expect(graphCounts().nodes).toBe(4);

    cleanup();
    vi.resetModules();
    nav.params = new URLSearchParams("focus=Topics/Nothing here.md");
    await renderGraph();
    expect(graphCounts().nodes).toBe(9);
    expect(screen.queryByText("focus:")).toBeNull();
  });

  test("the focus note itself survives its group being hidden", async () => {
    nav.params = new URLSearchParams(
      "focus=Courses/Canvas Reports/2026-08-27.md&depth=2",
    );
    await renderGraph();

    expect(graphCounts().nodes).toBe(1);
    expect(focusPill().textContent).toContain("2026-08-27");
    expect(chip(/^canvas reports 1$/i).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  test("the focus note's whole group is exempt, so its neighbours come too", async () => {
    const briefs = buildGraphData([
      note("Daily Briefs/2026-10-24.md", ["Daily Briefs/2026-10-23.md"]),
      note("Daily Briefs/2026-10-23.md"),
      note("Home.md"),
    ]);
    nav.params = new URLSearchParams(
      "focus=Daily Briefs/2026-10-24.md&depth=2",
    );
    await renderGraph(briefs);

    expect(graphCounts()).toEqual({ nodes: 2, links: 1 });
  });

  test("a hidden group cannot bridge two notes in the lens", async () => {
    nav.params = new URLSearchParams("focus=Home.md&depth=2");
    await renderGraph();

    // Areas/Work.md hangs off the hidden Papers note, so it stays out
    expect(graphCounts().nodes).toBe(2);

    fireEvent.click(chip(/^papers 1$/i));
    expect(graphCounts().nodes).toBe(4);
  });

  test("the archive preset focuses the hub at depth 2, outwards only", async () => {
    await renderGraph();

    fireEvent.click(chip(/^archive ◇$/i));
    expect(window.location.search).toBe(
      "?focus=Topics%2FArchive+map.md&depth=2&dir=out",
    );
  });

  test("dir=out drops the notes that only point at the focus", async () => {
    nav.params = new URLSearchParams(
      "focus=Topics/Archive map.md&depth=2&dir=out",
    );
    await renderGraph(directed);

    expect(graphCounts()).toEqual({ nodes: 3, links: 2 });
    expect(focusPill().textContent).toContain("out");
    expect(chip(/^archive ◇$/i).getAttribute("aria-pressed")).toBe("true");
  });

  test("the archive chip switches an undirected hub lens to the preset", async () => {
    nav.params = new URLSearchParams("focus=Topics/Archive map.md&depth=2");
    window.history.replaceState(
      null,
      "",
      "/brain/graph?focus=Topics/Archive map.md&depth=2",
    );
    await renderGraph(directed);

    const archive = chip(/^archive ◇$/i);
    expect(archive.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(archive);
    expect(window.location.search).toBe(
      "?focus=Topics%2FArchive+map.md&depth=2&dir=out",
    );
  });

  test("the same lens without dir=out keeps walking inbound links", async () => {
    nav.params = new URLSearchParams("focus=Topics/Archive map.md&depth=2");
    await renderGraph(directed);

    expect(graphCounts()).toEqual({ nodes: 4, links: 3 });
    expect(focusPill().textContent).not.toContain("out");
  });

  test("dir=out respects the depth", async () => {
    nav.params = new URLSearchParams(
      "focus=Topics/Archive map.md&depth=1&dir=out",
    );
    await renderGraph(directed);

    expect(graphCounts()).toEqual({ nodes: 2, links: 1 });
  });

  test("escapes a frontmatter title before the tooltip injects it", async () => {
    const hostile = buildGraphData([
      {
        path: "Reels/Video by someone.md",
        title: "Video by someone",
        frontmatter: { title: '<img src=x onerror="alert(1)">pwn' },
        outgoing: [],
        backlinks: [],
      },
    ]);
    await renderGraph(hostile);

    const tooltip = screen.getByTestId("tooltip");
    expect(tooltip.querySelector("img")).toBeNull();
    expect(tooltip.textContent).toBe('<img src=x onerror="alert(1)">pwn');
  });

  test("clear drops the focus params from the url", async () => {
    nav.params = new URLSearchParams(
      "focus=Topics/Archive map.md&depth=2&dir=out",
    );
    window.history.replaceState(
      null,
      "",
      "/brain/graph?focus=Topics/Archive map.md&depth=2&dir=out",
    );
    await renderGraph();

    fireEvent.click(screen.getByRole("button", { name: "clear" }));
    expect(window.location.search).toBe("");
    expect(window.location.pathname).toBe("/brain/graph");
  });
});
