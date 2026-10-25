import {
  noteFolder,
  noteHref,
  noteLabel,
  type NoteFrontmatter,
} from "@/app/lib/brain/parse";

export type GraphNode = {
  id: string;
  label: string;
  group: string;
  inbound: number;
  href: string;
};

export type GraphLink = {
  source: string;
  target: string;
};

export type GraphData = {
  nodes: GraphNode[];
  links: GraphLink[];
};

// Path prefixes that earn their own graph group instead of folding into their
// top-level folder. Canvas Reports is an operational pile that would otherwise
// swamp Courses/, and the archive categories belong with the hub note that
// indexes them rather than with the dozen real Topics notes.
const GROUP_PREFIXES: { prefix: string; group: string }[] = [
  { prefix: "Courses/Canvas Reports/", group: "Canvas Reports" },
  { prefix: "Topics/Archive categories/", group: "Archive map" },
];

const GROUP_EXACT: Record<string, string> = {
  "Topics/Archive map.md": "Archive map",
};

// A node's group is its top-level folder ("" for a root note), unless its path
// matches one of the overrides above. Groups are derived from the data, never
// enumerated: a new vault folder shows up as its own chip on the next read.
export function graphGroup(path: string): string {
  const exact = GROUP_EXACT[path];
  if (exact) return exact;
  const prefixed = GROUP_PREFIXES.find((entry) => path.startsWith(entry.prefix));
  return prefixed ? prefixed.group : noteFolder(path);
}

export function buildGraphData(
  notes: {
    path: string;
    title: string;
    frontmatter: NoteFrontmatter;
    outgoing: string[];
    backlinks: string[];
  }[],
): GraphData {
  const paths = new Set(notes.map((note) => note.path));
  const nodes: GraphNode[] = notes.map((note) => ({
    id: note.path,
    label: noteLabel(note.frontmatter, note.title),
    group: graphGroup(note.path),
    inbound: note.backlinks.length,
    href: noteHref(note.path),
  }));
  const links: GraphLink[] = [];
  for (const note of notes) {
    for (const target of note.outgoing) {
      if (target === note.path || !paths.has(target)) continue;
      links.push({ source: note.path, target });
    }
  }
  return { nodes, links };
}

// "both" walks edges in either direction; "out" follows only the links a note
// writes, which is what turns a hub into a tree. Undirected depth 2 from
// Topics/Archive map.md reaches ~620 notes, because everything that links TO
// the hub (Home, the journals, the video library) lands at depth 1 and drags
// its own neighbours in behind it.
export type TraversalDirection = "out" | "both";

export type TraversalOptions = {
  // The viewer's visible set, so a hidden group cannot act as a bridge between
  // two shown notes. The caller is responsible for putting the focus node
  // itself in here — focusing a note in a hidden group is legal, and its edges
  // have to stay walkable.
  allowed?: ReadonlySet<string>;
  direction?: TraversalDirection;
};

// The focus lens: every node within `depth` hops of `focusId`.
export function nodesWithinHops(
  links: GraphLink[],
  focusId: string,
  depth: number,
  { allowed, direction = "both" }: TraversalOptions = {},
): Set<string> {
  const reachable = new Set<string>([focusId]);
  if (depth <= 0) return reachable;

  const neighbors = new Map<string, string[]>();
  const connect = (from: string, to: string) => {
    const bucket = neighbors.get(from);
    if (bucket) bucket.push(to);
    else neighbors.set(from, [to]);
  };
  for (const link of links) {
    if (allowed && (!allowed.has(link.source) || !allowed.has(link.target))) {
      continue;
    }
    connect(link.source, link.target);
    if (direction === "both") connect(link.target, link.source);
  }

  let frontier = [focusId];
  for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of neighbors.get(id) ?? []) {
        if (reachable.has(neighbor)) continue;
        reachable.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return reachable;
}
