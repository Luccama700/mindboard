"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { NodeObject } from "react-force-graph-2d";

import type { GraphData, GraphNode } from "@/app/lib/brain/graph";
import { ForceGraph, type ForceGraphInstance } from "./force-graph-wrapper";

// Fixed hex values (canvas cannot read theme CSS variables); the folder colors
// match the vault's Obsidian graph groups per the kickoff.
const FOLDER_COLORS: Record<string, string> = {
  People: "#4ade80",
  Projects: "#fb923c",
  Areas: "#60a5fa",
  Topics: "#c084fc",
  Journal: "#9ca3af",
  Archive: "#4b5563",
  "": "#e8e0d0",
};
const FALLBACK_COLOR = "#e8e0d0";
const LINK_COLOR = "#88888855";
const LABEL_COLOR = "#888888";

const FILTER_FOLDERS = [
  "People",
  "Projects",
  "Areas",
  "Topics",
  "Journal",
  "Archive",
];

type SimNode = NodeObject & GraphNode;

function nodeRadius(node: SimNode): number {
  return 3 + 1.5 * Math.sqrt(node.inbound);
}

export function GraphClient({ data }: { data: GraphData }) {
  const router = useRouter();
  const graphRef = useRef<ForceGraphInstance | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [hiddenFolders, setHiddenFolders] = useState<Set<string>>(new Set());
  const fittedRef = useRef(false);

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

  const graphData = useMemo(() => {
    const visible = data.nodes.filter(
      (node) => !hiddenFolders.has(node.folder),
    );
    const visibleIds = new Set(visible.map((node) => node.id));
    return {
      // the simulation mutates node objects, so hand it fresh copies
      nodes: visible.map((node) => ({ ...node })),
      links: data.links
        .filter(
          (link) => visibleIds.has(link.source) && visibleIds.has(link.target),
        )
        .map((link) => ({ ...link })),
    };
  }, [data, hiddenFolders]);

  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of data.nodes) {
      counts.set(node.folder, (counts.get(node.folder) ?? 0) + 1);
    }
    return counts;
  }, [data]);

  const toggleFolder = (folder: string) => {
    setHiddenFolders((current) => {
      const next = new Set(current);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex gap-2 overflow-x-auto px-5 pb-3 shrink-0">
        {FILTER_FOLDERS.map((folder) => {
          const hidden = hiddenFolders.has(folder);
          return (
            <button
              key={folder}
              type="button"
              onClick={() => toggleFolder(folder)}
              className={`flex items-center gap-1.5 min-h-11 px-3 text-xs tracking-widest uppercase border rounded-full transition-colors whitespace-nowrap ${
                hidden
                  ? "border-line text-muted"
                  : "border-line-strong text-fg"
              }`}
            >
              <span
                className="w-2 h-2 rounded-full"
                style={{
                  backgroundColor: hidden
                    ? "transparent"
                    : (FOLDER_COLORS[folder] ?? FALLBACK_COLOR),
                  boxShadow: hidden
                    ? `inset 0 0 0 1px ${FOLDER_COLORS[folder] ?? FALLBACK_COLOR}`
                    : "none",
                }}
              />
              {folder.toLowerCase()}
              <span className="text-muted">
                {folderCounts.get(folder) ?? 0}
              </span>
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
              if (fittedRef.current) return;
              fittedRef.current = true;
              graphRef.current?.zoomToFit(400, 40);
            }}
            nodeCanvasObject={(rawNode, ctx, globalScale) => {
              const node = rawNode as SimNode;
              const radius = nodeRadius(node);
              ctx.beginPath();
              ctx.arc(node.x ?? 0, node.y ?? 0, radius, 0, 2 * Math.PI);
              ctx.fillStyle = FOLDER_COLORS[node.folder] ?? FALLBACK_COLOR;
              ctx.fill();
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
            nodeLabel={(rawNode) => (rawNode as SimNode).label}
            onNodeClick={(rawNode) => {
              router.push((rawNode as SimNode).href);
            }}
          />
        )}
      </div>
    </div>
  );
}
