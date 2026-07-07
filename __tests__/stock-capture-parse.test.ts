import { describe, expect, it } from "vitest";
import {
  parseStockSegment,
  parseStockText,
} from "@/app/_components/stock-capture-parse";

describe("parseStockSegment", () => {
  it("parses bare quantities as recounts", () => {
    expect(parseStockSegment("12 eggs")).toEqual({ sign: null, value: 12, ref: "eggs" });
    expect(parseStockSegment("0 coffee")).toEqual({ sign: null, value: 0, ref: "coffee" });
    expect(parseStockSegment("0.5 rice")).toEqual({ sign: null, value: 0.5, ref: "rice" });
    expect(parseStockSegment("2,5 rice")).toEqual({ sign: null, value: 2.5, ref: "rice" });
  });

  it("parses signed quantities as deltas", () => {
    expect(parseStockSegment("+2 milk")).toEqual({ sign: "+", value: 2, ref: "milk" });
    expect(parseStockSegment("-1 dish soap")).toEqual({ sign: "-", value: 1, ref: "dish soap" });
    expect(parseStockSegment("+ 3 paper towels")).toEqual({
      sign: "+",
      value: 3,
      ref: "paper towels",
    });
  });

  it("rejects free-form text, missing names, and signed zeros", () => {
    expect(parseStockSegment("bought some eggs")).toBeNull();
    expect(parseStockSegment("eggs 12")).toBeNull();
    expect(parseStockSegment("12")).toBeNull();
    expect(parseStockSegment("+0 eggs")).toBeNull();
    expect(parseStockSegment("")).toBeNull();
  });
});

describe("parseStockText", () => {
  it("parses multi-segment input", () => {
    const parsed = parseStockText("12 eggs, +2 milk; -1 rice\n0 coffee");
    expect(parsed).toHaveLength(4);
    expect(parsed?.[3]).toEqual({ sign: null, value: 0, ref: "coffee" });
  });

  it("returns null when any segment fails (all-or-nothing)", () => {
    expect(parseStockText("12 eggs, back from costco")).toBeNull();
    expect(parseStockText("")).toBeNull();
  });
});
