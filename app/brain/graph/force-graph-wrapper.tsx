"use client";

import dynamic from "next/dynamic";
import type { ComponentProps, MutableRefObject } from "react";
import type ForceGraph2DType from "react-force-graph-2d";
import type { ForceGraphMethods, NodeObject } from "react-force-graph-2d";

export type ForceGraphInstance = ForceGraphMethods<NodeObject, object>;

type ForceGraphProps = ComponentProps<typeof ForceGraph2DType> & {
  graphRef?: MutableRefObject<ForceGraphInstance | undefined>;
};

// next/dynamic does not forward refs, so the instance is exposed through a
// plain graphRef prop instead.
export const ForceGraph = dynamic(
  () =>
    import("react-force-graph-2d").then((mod) => {
      const ForceGraph2D = mod.default;
      function ForceGraphWithRef({ graphRef, ...props }: ForceGraphProps) {
        return <ForceGraph2D ref={graphRef} {...props} />;
      }
      return ForceGraphWithRef;
    }),
  { ssr: false },
);
