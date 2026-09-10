import { describe, expect, test } from "vitest";

import {
  ENERGY_SCALE,
  energyPrompt,
  parseEnergyRating,
} from "@/app/lib/tasks/energy";

describe("parseEnergyRating", () => {
  test("accepts a clean 1-5 integer", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      expect(parseEnergyRating({ energyCost: n })).toBe(n);
    }
  });

  test("rejects anything else rather than guessing", () => {
    expect(parseEnergyRating({ energyCost: 0 })).toBeNull();
    expect(parseEnergyRating({ energyCost: 6 })).toBeNull();
    expect(parseEnergyRating({ energyCost: 3.5 })).toBeNull();
    expect(parseEnergyRating({ energyCost: "4" })).toBeNull();
    expect(parseEnergyRating({})).toBeNull();
    expect(parseEnergyRating(null)).toBeNull();
    expect(parseEnergyRating(undefined)).toBeNull();
  });
});

describe("energyPrompt", () => {
  test("carries title, group, estimate and squashed notes", () => {
    const prompt = energyPrompt({
      title: "Call the CRA about the T4",
      notes: "line 1\n\n   line 2",
      estimatedMinutes: 15,
      groupName: "admin",
    });
    expect(prompt).toBe(
      "Task: Call the CRA about the T4\nGroup: admin\nEstimated time: 15 minutes\nNotes: line 1 line 2",
    );
  });

  test("omits what is missing", () => {
    expect(
      energyPrompt({ title: "x", notes: null, estimatedMinutes: null, groupName: null }),
    ).toBe("Task: x");
  });

  test("the scale teaches that time and energy are different axes", () => {
    expect(ENERGY_SCALE).toMatch(/90-minute commute/);
    expect(ENERGY_SCALE).toMatch(/bureaucracy/);
  });
});
