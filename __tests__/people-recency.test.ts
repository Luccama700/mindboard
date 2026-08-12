import { describe, expect, it } from "vitest";

import {
  daysBetweenKeys,
  formatOccurred,
  looseBand,
  recencyBand,
} from "@/app/_components/people-recency";

describe("daysBetweenKeys", () => {
  it("counts calendar days between day keys", () => {
    expect(daysBetweenKeys("2026-08-01", "2026-08-12")).toBe(11);
    expect(daysBetweenKeys("2026-08-12", "2026-08-12")).toBe(0);
  });

  it("crosses month and year boundaries", () => {
    expect(daysBetweenKeys("2026-07-31", "2026-08-01")).toBe(1);
    expect(daysBetweenKeys("2025-12-31", "2026-01-01")).toBe(1);
  });

  it("is DST-immune because keys are parsed as UTC midnights", () => {
    // 2026-03-08 is the US spring-forward date; a local-time diff would
    // yield 0.958 days and round-trip errors.
    expect(daysBetweenKeys("2026-03-07", "2026-03-09")).toBe(2);
    expect(daysBetweenKeys("2026-10-31", "2026-11-02")).toBe(2);
  });
});

describe("recencyBand", () => {
  it("is cadence-relative, not absolute", () => {
    expect(recencyBand(5, 7)).toBe("in touch");
    expect(recencyBand(7, 7)).toBe("in touch");
    expect(recencyBand(8, 7)).toBe("a while");
    expect(recencyBand(14, 7)).toBe("a while");
    expect(recencyBand(15, 7)).toBe("quiet");
  });

  it("a long cadence keeps long gaps calm", () => {
    // 80 days since talking to a yearly-check-in friend is "in touch".
    expect(recencyBand(80, 90)).toBe("in touch");
  });
});

describe("looseBand", () => {
  it("stays coarse and judgment-free", () => {
    expect(looseBand(3)).toBe("recently");
    expect(looseBand(30)).toBe("it's been a while");
    expect(looseBand(200)).toBe("not lately");
  });
});

describe("formatOccurred", () => {
  const today = "2026-08-12";

  it("renders exact rows as real dates", () => {
    expect(
      formatOccurred({ occurred_at: "2026-08-12", occurred_precision: "exact" }, today),
    ).toBe("today");
    expect(
      formatOccurred({ occurred_at: "2026-08-11", occurred_precision: "exact" }, today),
    ).toBe("yesterday");
    expect(
      formatOccurred({ occurred_at: "2026-08-03", occurred_precision: "exact" }, today),
    ).toBe("Aug 3");
  });

  it("never renders a fabricated date for approx rows", () => {
    // The §2.4 rule: 'approx' rows say roughly when, never a day.
    const approx = (occurred_at: string) =>
      formatOccurred({ occurred_at, occurred_precision: "approx" }, today);
    expect(approx("2026-08-11")).toBe("in the last few days");
    expect(approx("2026-08-05")).toBe("about a week ago");
    expect(approx("2026-07-15")).toBe("about a month ago");
    expect(approx("2026-05-01")).toBe("a while ago");
    for (const key of ["2026-08-11", "2026-08-05", "2026-07-15", "2026-05-01"]) {
      expect(approx(key)).not.toMatch(/\d/);
    }
  });
});
