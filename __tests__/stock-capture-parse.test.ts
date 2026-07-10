import { describe, expect, it } from "vitest";
import {
  parseStockSegment,
  parseStockText,
  splitStockSegments,
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
    expect(parseStockSegment("-0 eggs")).toBeNull();
    expect(parseStockSegment("")).toBeNull();
  });

  it("rejects a number with more than one decimal separator", () => {
    expect(parseStockSegment("1.2.3 eggs")).toBeNull();
    expect(parseStockSegment("2.5,5 eggs")).toBeNull();
  });

  it("tolerates extra whitespace (including tabs) between sign, number, and ref", () => {
    expect(parseStockSegment("+\t3 eggs")).toEqual({ sign: "+", value: 3, ref: "eggs" });
    expect(parseStockSegment("12   eggs")).toEqual({ sign: null, value: 12, ref: "eggs" });
  });

  it("only the leading number is parsed; the rest of the segment is a literal ref", () => {
    expect(parseStockSegment("12 rice 5lb bag")).toEqual({
      sign: null,
      value: 12,
      ref: "rice 5lb bag",
    });
    // a stray minus inside the ref does not become a second signed number
    expect(parseStockSegment("12 -5 rice")).toEqual({ sign: null, value: 12, ref: "-5 rice" });
  });

  it("treats a comma as a decimal separator, not a thousands separator", () => {
    // consistent with the "2,5 rice" -> 2.5 case: this is a European-style
    // decimal input, so "1,234" reads as 1.234, not one thousand two hundred
    // thirty-four.
    expect(parseStockSegment("1,234 eggs")).toEqual({ sign: null, value: 1.234, ref: "eggs" });
  });

  it("rounds the parsed value to 3 decimal places", () => {
    expect(parseStockSegment("1.23456 eggs")).toEqual({
      sign: null,
      value: 1.235,
      ref: "eggs",
    });
  });
});

describe("splitStockSegments", () => {
  it("collapses consecutive, leading, and trailing separators", () => {
    expect(splitStockSegments(",,12 eggs,,")).toEqual(["12 eggs"]);
    expect(splitStockSegments("12 eggs,, +2 milk")).toEqual(["12 eggs", "+2 milk"]);
  });

  it("treats commas, semicolons, and newlines interchangeably as separators", () => {
    expect(splitStockSegments("12 eggs,+2 milk;-1 rice\n0 coffee")).toEqual([
      "12 eggs",
      "+2 milk",
      "-1 rice",
      "0 coffee",
    ]);
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

  it("fails the whole batch even when the bad segment comes first", () => {
    expect(parseStockText("back from costco, 12 eggs")).toBeNull();
  });
});
