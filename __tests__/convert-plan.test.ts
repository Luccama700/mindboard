import { describe, expect, it } from "vitest";
import {
  planSlices,
  stitchConverted,
  trimOverlap,
} from "@/app/lib/learn/convert-plan";

describe("planSlices", () => {
  it("returns one slice when the document fits", () => {
    expect(planSlices(12)).toEqual([{ from: 1, to: 12 }]);
    expect(planSlices(20)).toEqual([{ from: 1, to: 20 }]);
  });

  it("overlaps consecutive slices by one page", () => {
    expect(planSlices(50)).toEqual([
      { from: 1, to: 20 },
      { from: 20, to: 39 },
      { from: 39, to: 50 },
    ]);
  });

  it("covers every page exactly up to the end", () => {
    const slices = planSlices(21);
    expect(slices).toEqual([
      { from: 1, to: 20 },
      { from: 20, to: 21 },
    ]);
  });

  it("handles invalid counts", () => {
    expect(planSlices(0)).toEqual([]);
    expect(planSlices(2.5)).toEqual([]);
  });
});

describe("trimOverlap", () => {
  it("cuts everything before the first new page's anchor", () => {
    const markdown = "<!-- p.20 -->\nold tail\n<!-- p.21 -->\nnew content";
    expect(trimOverlap(markdown, 20)).toBe("<!-- p.21 -->\nnew content");
  });

  it("keeps the whole part when the anchor is missing", () => {
    const markdown = "no anchors here";
    expect(trimOverlap(markdown, 20)).toBe(markdown);
  });
});

describe("stitchConverted", () => {
  it("keeps the first part whole and trims later overlaps", () => {
    const stitched = stitchConverted([
      {
        slice: { from: 1, to: 20 },
        markdown: "<!-- p.1 -->\nstart\n<!-- p.20 -->\npage twenty",
      },
      {
        slice: { from: 20, to: 30 },
        markdown: "<!-- p.20 -->\npage twenty again\n<!-- p.21 -->\npage twenty-one",
      },
    ]);
    expect(stitched).toBe(
      "<!-- p.1 -->\nstart\n<!-- p.20 -->\npage twenty\n\n<!-- p.21 -->\npage twenty-one",
    );
  });

  it("drops empty parts", () => {
    const stitched = stitchConverted([
      { slice: { from: 1, to: 20 }, markdown: "a" },
      { slice: { from: 20, to: 21 }, markdown: "   " },
    ]);
    expect(stitched).toBe("a");
  });
});
