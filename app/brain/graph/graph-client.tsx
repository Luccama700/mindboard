"use client";

import { useRouter, useSearchParams } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { NodeObject } from "react-force-graph-2d";

import {
  nodesWithinHops,
  type GraphData,
  type GraphNode,
  type TraversalDirection,
} from "@/app/lib/brain/graph";
import { ForceGraph, type ForceGraphInstance } from "./force-graph-wrapper";

// Fixed hex values (canvas cannot read theme CSS variables). The first seven
// are the vault's Obsidian graph groups per the kickoff; the rest were picked
// to stay apart from them at a glance, with the archive hub the loudest thing
// on the canvas because it is the entry point to 400-odd archived items.
const GROUP_COLORS: Record<string, string> = {
  People: "#4ade80",
  Projects: "#fb923c",
  Areas: "#60a5fa",
  Topics: "#c084fc",
  Journal: "#9ca3af",
  Archive: "#4b5563",
  "": "#e8e0d0",
  "Archive map": "#fde047",
  Reels: "#f472b6",
  Diary: "#fb7185",
  Courses: "#22d3ee",
  Papers: "#6366f1",
  "Daily Briefs": "#64748b",
  "Canvas Reports": "#2dd4bf",
  Inbox: "#f59e0b",
  Templates: "#52525b",
};
const FALLBACK_COLOR = "#e8e0d0";
const LINK_COLOR = "#88888855";
const LABEL_COLOR = "#888888";

// Chip order for the groups that exist today; anything new sorts in after them
// alphabetically, so an unrecognised folder is still reachable.
const GROUP_ORDER = [
  "People",
  "Projects",
  "Areas",
  "Topics",
  "Archive map",
  "Journal",
  "Diary",
  "Reels",
  "Courses",
  "Archive",
  "",
  "Papers",
  "Daily Briefs",
  "Canvas Reports",
  "Inbox",
  "Templates",
];

// Operational and reference piles: present, counted, one tap away, but off by
// default so the graph opens on the picture of the brain (matches the vault's
// own Obsidian graph filter).
const DEFAULT_HIDDEN_GROUPS = [
  "Papers",
  "Daily Briefs",
  "Canvas Reports",
  "Inbox",
  "Templates",
];

const ARCHIVE_FOCUS = "Topics/Archive map.md";
// The archive hub is read outwards: its 12 category notes and what they index,
// not the notes that happen to point at it.
const ARCHIVE_DIRECTION: TraversalDirection = "out";
const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 6;
const GROUPS_KEY = "brain-graph-groups";

const DEFAULT_HIDDEN_SET: ReadonlySet<string> = new Set(DEFAULT_HIDDEN_GROUPS);

// The viewer's hidden set, as an external store (the repo's localStorage shape,
// see inventory-client.tsx): read from storage once per page load, then held in
// module state. useSyncExternalStore hands the server snapshot to the first
// client render too, so the chips hydrate as they were rendered and only then
// settle onto what this phone remembers.
//
// What is stored is the viewer's DELTAS from the defaults, never the resolved
// set: `{ shown: [...], hidden: [...] }`. Storing the resolved set would freeze
// today's defaults into every phone that has ever opened this page, so a group
// added to DEFAULT_HIDDEN_GROUPS later would arrive already un-hidden.
type StoredGroupPrefs = { shown: string[]; hidden: string[] };

let hiddenState: ReadonlySet<string> | null = null;
const hiddenListeners = new Set<() => void>();

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readStoredHiddenGroups(): ReadonlySet<string> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(GROUPS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const prefs = parsed as Partial<StoredGroupPrefs>;
    const shown = new Set(stringList(prefs.shown));
    const hidden = new Set(stringList(prefs.hidden));
    for (const group of DEFAULT_HIDDEN_GROUPS) {
      if (!shown.has(group)) hidden.add(group);
    }
    return hidden;
  } catch {
    return null;
  }
}

function hiddenGroupsSnapshot(): ReadonlySet<string> {
  if (!hiddenState) hiddenState = readStoredHiddenGroups() ?? DEFAULT_HIDDEN_SET;
  return hiddenState;
}

function setHiddenGroups(groups: ReadonlySet<string>): void {
  hiddenState = groups;
  const prefs: StoredGroupPrefs = {
    shown: DEFAULT_HIDDEN_GROUPS.filter((group) => !groups.has(group)),
    hidden: [...groups].filter((group) => !DEFAULT_HIDDEN_SET.has(group)),
  };
  try {
    window.localStorage.setItem(GROUPS_KEY, JSON.stringify(prefs));
  } catch {
    // private mode / blocked storage: the filter still holds for this session
  }
  for (const listener of hiddenListeners) listener();
}

function subscribeHiddenGroups(listener: () => void): () => void {
  hiddenListeners.add(listener);
  return () => {
    hiddenListeners.delete(listener);
  };
}

function useHiddenGroups(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribeHiddenGroups,
    hiddenGroupsSnapshot,
    () => DEFAULT_HIDDEN_SET,
  );
}

// float-tooltip (1.7.5) injects a string nodeLabel with d3 .html(), and labels
// now come from vault frontmatter, so a note titled `<img src=x onerror=...>`
// would execute. Escaped here rather than handed over as an element, because
// the accessor is typed to a string.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function groupLabel(group: string): string {
  return (group || "root").toLowerCase();
}

function groupColor(group: string): string {
  return GROUP_COLORS[group] ?? FALLBACK_COLOR;
}

type SimNode = NodeObject & GraphNode;

function nodeRadius(node: SimNode): number {
  return 3 + 1.5 * Math.sqrt(node.inbound);
}

export function GraphClient({ data }: { data: GraphData }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const graphRef = useRef<ForceGraphInstance | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const hiddenGroups = useHiddenGroups();
  const fittedRef = useRef<{ key: string; count: number } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () =>
      setSize({
        width: container.clientWidth,
        height: container.clientHeight,
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const focusParam = searchParams.get("focus");
  const depth = useMemo(() => {
    const raw = Number.parseInt(searchParams.get("depth") ?? "", 10);
    if (!Number.isFinite(raw) || raw < 0) return DEFAULT_DEPTH;
    return Math.min(raw, MAX_DEPTH);
  }, [searchParams]);
  const direction: TraversalDirection =
    searchParams.get("dir") === "out" ? "out" : "both";

  // Accepts a vault path with or without the .md suffix, and in any case: the
  // param is typed into a URL or arrives from a note page link.
  const focusNode = useMemo(() => {
    const wanted = focusParam?.trim();
    if (!wanted) return null;
    const lowered = wanted.toLowerCase();
    return (
      data.nodes.find((node) => node.id === wanted) ??
      data.nodes.find(
        (node) =>
          node.id.toLowerCase() === lowered ||
          node.id.toLowerCase() === `${lowered}.md`,
      ) ??
      null
    );
  }, [data, focusParam]);

  const graphData = useMemo(() => {
    // The focus note's own group is exempt from the filter while its lens is
    // active: opening "graph" from a Daily Brief has to show that brief AND the
    // briefs it links, not one lonely dot.
    const shown = data.nodes.filter(
      (node) => !hiddenGroups.has(node.group) || node.group === focusNode?.group,
    );
    let visibleIds = new Set(shown.map((node) => node.id));
    if (focusNode) {
      visibleIds = nodesWithinHops(data.links, focusNode.id, depth, {
        allowed: visibleIds,
        direction,
      });
    }
    return {
      // the simulation mutates node objects, so hand it fresh copies
      nodes: shown
        .filter((node) => visibleIds.has(node.id))
        .map((node) => ({ ...node })),
      links: data.links
        .filter(
          (link) => visibleIds.has(link.source) && visibleIds.has(link.target),
        )
        .map((link) => ({ ...link })),
    };
  }, [data, hiddenGroups, focusNode, depth, direction]);

  // Counts are of the whole vault, not of the current lens: the chip answers
  // "how much of this is there", and a count that shrank with the lens would
  // make an un-hidden group look empty.
  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of data.nodes) {
      counts.set(node.group, (counts.get(node.group) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => {
      const ia = GROUP_ORDER.indexOf(a);
      const ib = GROUP_ORDER.indexOf(b);
      const ra = ia === -1 ? GROUP_ORDER.length : ia;
      const rb = ib === -1 ? GROUP_ORDER.length : ib;
      if (ra !== rb) return ra - rb;
      return a.localeCompare(b);
    });
  }, [data]);

  const toggleGroup = (group: string) => {
    const next = new Set(hiddenGroups);
    if (next.has(group)) next.delete(group);
    else next.add(group);
    setHiddenGroups(next);
  };

  // pushState over router.push: the whole graph is already in this component,
  // so a lens change must not round-trip to the server for the same payload.
  // Next syncs useSearchParams with the native history API, so the URL stays
  // shareable and the back button still unwinds the lens.
  const focusOn = (path: string, dir: TraversalDirection = "both") => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("focus", path);
    params.set("depth", String(DEFAULT_DEPTH));
    if (dir === "out") params.set("dir", dir);
    else params.delete("dir");
    window.history.pushState(null, "", `?${params.toString()}`);
  };

  const clearFocus = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("focus");
    params.delete("depth");
    params.delete("dir");
    const query = params.toString();
    window.history.pushState(
      null,
      "",
      query ? `?${query}` : window.location.pathname,
    );
  };

  // Only the directed lens counts as "on": tapping the chip while looking at an
  // undirected Archive map lens should switch to the preset, not clear it.
  const archiveFocused =
    focusNode?.id === ARCHIVE_FOCUS && direction === ARCHIVE_DIRECTION;
  const hasArchiveHub = data.nodes.some((node) => node.id === ARCHIVE_FOCUS);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {focusNode && (
        <div className="flex items-center gap-2 px-5 pb-2 shrink-0">
          <div className="flex items-center min-h-11 pl-3 pr-1 border border-line-strong rounded-full text-xs min-w-0">
            <span className="text-muted shrink-0">focus:</span>
            <span className="ml-1.5 truncate">
              {focusNode.label.toLowerCase()}
            </span>
            {direction === "out" && (
              <>
                <span className="mx-1.5 text-muted shrink-0">·</span>
                <span className="text-muted shrink-0">out</span>
              </>
            )}
            <span className="mx-1.5 text-muted shrink-0">·</span>
            <button
              type="button"
              onClick={clearFocus}
              className="min-h-11 px-2 text-muted hover:text-fg transition-colors shrink-0"
            >
              clear
            </button>
          </div>
          <span className="text-[10px] tracking-widest uppercase text-muted shrink-0">
            {graphData.nodes.length} · {depth} hop{depth === 1 ? "" : "s"}
          </span>
        </div>
      )}

      <div className="flex gap-2 overflow-x-auto px-5 pb-3 shrink-0">
        {hasArchiveHub && (
          <button
            type="button"
            onClick={() =>
              archiveFocused
                ? clearFocus()
                : focusOn(ARCHIVE_FOCUS, ARCHIVE_DIRECTION)
            }
            aria-pressed={archiveFocused}
            className={`flex items-center gap-1.5 min-h-11 px-3 text-xs tracking-widest uppercase border rounded-full transition-colors whitespace-nowrap ${
              archiveFocused
                ? "border-line-strong text-fg"
                : "border-line text-muted"
            }`}
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: groupColor("Archive map") }}
            />
            archive ◇
          </button>
        )}
        {groups.map(([group, count]) => {
          const hidden = hiddenGroups.has(group);
          return (
            <button
              key={group}
              type="button"
              onClick={() => toggleGroup(group)}
              aria-pressed={!hidden}
              className={`flex items-center gap-1.5 min-h-11 px-3 text-xs tracking-widest uppercase border rounded-full transition-colors whitespace-nowrap ${
                hidden
                  ? "border-line text-muted"
                  : "border-line-strong text-fg"
              }`}
            >
              <span
                className="w-2 h-2 rounded-full"
                style={{
                  backgroundColor: hidden ? "transparent" : groupColor(group),
                  boxShadow: hidden
                    ? `inset 0 0 0 1px ${groupColor(group)}`
                    : "none",
                }}
              />
              {groupLabel(group)}
              <span className="text-muted">{count}</span>
            </button>
          );
        })}
      </div>

      <div ref={containerRef} className="flex-1 min-h-0">
        {size && (
          <ForceGraph
            graphRef={graphRef}
            width={size.width}
            height={size.height}
            graphData={graphData}
            backgroundColor="rgba(0,0,0,0)"
            linkColor={() => LINK_COLOR}
            linkWidth={1}
            cooldownTicks={200}
            onEngineStop={() => {
              // Refit once per lens, not once per page: a new focus is a
              // different graph and needs its own fit. A group toggle refits
              // only when it moved the node count a lot (un-hiding a chip under
              // a lens), so toggling a chip while zoomed into a cluster does not
              // snap the viewer back out to fit-all over a handful of notes.
              const key = `${focusNode?.id ?? ""}|${depth}|${direction}`;
              const count = graphData.nodes.length;
              const last = fittedRef.current;
              if (
                last &&
                last.key === key &&
                Math.abs(count - last.count) <= Math.max(5, last.count * 0.25)
              ) {
                return;
              }
              fittedRef.current = { key, count };
              graphRef.current?.zoomToFit(400, 40);
            }}
            nodeCanvasObject={(rawNode, ctx, globalScale) => {
              const node = rawNode as SimNode;
              const radius = nodeRadius(node);
              const color = groupColor(node.group);
              ctx.beginPath();
              ctx.arc(node.x ?? 0, node.y ?? 0, radius, 0, 2 * Math.PI);
              ctx.fillStyle = color;
              ctx.fill();
              if (node.id === focusNode?.id) {
                ctx.beginPath();
                ctx.arc(node.x ?? 0, node.y ?? 0, radius + 3, 0, 2 * Math.PI);
                ctx.strokeStyle = color;
                ctx.lineWidth = 1.5 / globalScale;
                ctx.stroke();
              }
              if (globalScale >= 1.4) {
                const fontSize = Math.min(12 / globalScale, 5);
                ctx.font = `${fontSize}px monospace`;
                ctx.textAlign = "center";
                ctx.textBaseline = "top";
                ctx.fillStyle = LABEL_COLOR;
                ctx.fillText(
                  node.label,
                  node.x ?? 0,
                  (node.y ?? 0) + radius + 1.5,
                );
              }
            }}
            nodePointerAreaPaint={(rawNode, color, ctx) => {
              const node = rawNode as SimNode;
              ctx.beginPath();
              ctx.arc(
                node.x ?? 0,
                node.y ?? 0,
                nodeRadius(node) + 8,
                0,
                2 * Math.PI,
              );
              ctx.fillStyle = color;
              ctx.fill();
            }}
            nodeLabel={(rawNode) => escapeHtml((rawNode as SimNode).label)}
            onNodeClick={(rawNode) => {
              router.push((rawNode as SimNode).href);
            }}
          />
        )}
      </div>
    </div>
  );
}
