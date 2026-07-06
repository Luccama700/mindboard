import { noteHref } from "@/app/lib/brain/parse";

export type GraphNode = {
  id: string;
  label: string;
  folder: string;
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

export function buildGraphData(
  notes: {
    path: string;
    folder: string;
    title: string;
    outgoing: string[];
    backlinks: string[];
  }[],
): GraphData {
  const paths = new Set(notes.map((note) => note.path));
  const nodes: GraphNode[] = notes.map((note) => ({
    id: note.path,
    label: note.title,
    folder: note.folder,
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
