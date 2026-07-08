import { describe, expect, test } from "vitest";
import {
  CHAPTERS,
  chapterAt,
  chapterFade,
  lerp,
  seg,
  typedCount,
} from "@/app/_components/landing/day-script";

describe("chapterAt", () => {
  test("maps global progress onto the five chapters", () => {
    expect(chapterAt(0)).toEqual({ index: 0, local: 0 });
    expect(chapterAt(0.1).index).toBe(0);
    expect(chapterAt(0.1).local).toBeCloseTo(0.5);
    expect(chapterAt(0.5).index).toBe(2);
    expect(chapterAt(1).index).toBe(CHAPTERS.length - 1);
    expect(chapterAt(1).local).toBeCloseTo(1);
  });

  test("clamps out-of-range progress", () => {
    expect(chapterAt(-1)).toEqual({ index: 0, local: 0 });
    expect(chapterAt(2).index).toBe(CHAPTERS.length - 1);
    expect(chapterAt(2).local).toBeCloseTo(1);
  });
});

describe("seg", () => {
  test("is 0 before, 1 after, linear between", () => {
    expect(seg(0.1, 0.2, 0.6)).toBe(0);
    expect(seg(0.4, 0.2, 0.6)).toBeCloseTo(0.5);
    expect(seg(0.9, 0.2, 0.6)).toBe(1);
  });

  test("degenerate ranges act as a step", () => {
    expect(seg(0.4, 0.5, 0.5)).toBe(0);
    expect(seg(0.6, 0.5, 0.5)).toBe(1);
  });
});

describe("typedCount", () => {
  test("types the string across the sub-progress", () => {
    expect(typedCount("buy milk", 0)).toBe(0);
    expect(typedCount("buy milk", 0.5)).toBe(4);
    expect(typedCount("buy milk", 1)).toBe(8);
    expect(typedCount("buy milk", 3)).toBe(8);
  });
});

describe("chapterFade", () => {
  test("first chapter starts visible, middles crossfade, last holds", () => {
    expect(chapterFade(0, 0)).toBe(1);
    expect(chapterFade(1, 0)).toBe(0);
    expect(chapterFade(1, 0.5)).toBe(1);
    expect(chapterFade(1, 1)).toBe(0);
    expect(chapterFade(CHAPTERS.length - 1, 1)).toBe(1);
  });
});

describe("lerp", () => {
  test("interpolates and clamps", () => {
    expect(lerp(10, 20, 0.5)).toBe(15);
    expect(lerp(10, 20, 2)).toBe(20);
    expect(lerp(1240.5, 1236, 1)).toBe(1236);
  });
});
