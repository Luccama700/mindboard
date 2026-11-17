import { describe, expect, test } from "vitest";
import { STOPS, minutesOf } from "@/app/_components/landing/day-script";

describe("minutesOf", () => {
  test("reads a 24h time as minutes after midnight", () => {
    expect(minutesOf("00:00")).toBe(0);
    expect(minutesOf("07:00")).toBe(420);
    expect(minutesOf("23:59")).toBe(1439);
  });

  test("is NaN for anything that is not a 24h time", () => {
    expect(minutesOf("24:00")).toBeNaN();
    expect(minutesOf("7:00")).toBeNaN();
    expect(minutesOf("09:60")).toBeNaN();
    expect(minutesOf("soon")).toBeNaN();
  });
});

describe("the day line", () => {
  test("has one stop for each thing the board holds", () => {
    expect(STOPS.map((stop) => stop.key)).toEqual([
      "stream",
      "calendar",
      "money",
      "shelf",
      "people",
      "brain",
    ]);
  });

  test("runs forward through the day", () => {
    const minutes = STOPS.map((stop) => minutesOf(stop.time));
    expect(minutes.every(Number.isFinite)).toBe(true);
    expect([...minutes].sort((a, b) => a - b)).toEqual(minutes);
    expect(new Set(minutes).size).toBe(STOPS.length);
  });

  test("every stop says something, in the page's lowercase voice", () => {
    for (const stop of STOPS) {
      expect(stop.lane.length).toBeGreaterThan(0);
      expect(stop.caption.length).toBeGreaterThan(0);
      expect(stop.caption).toBe(stop.caption.toLowerCase());
      expect(stop.caption.endsWith(".")).toBe(true);
    }
  });
});
