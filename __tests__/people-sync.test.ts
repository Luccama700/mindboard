import { describe, expect, test } from "vitest";

import { seedAliases } from "@/app/lib/people/sync";

// Alias seeding is one-way and one-time, at row creation (docs/people-plan.md
// §5). Curated aliases from mindspace_topics win when the user already tuned
// them there; otherwise the seed is the FIRST name token only — seeding
// surnames adds terms that match relatives and strangers, which turns M4's
// precision layer into cleanup. The 3-character floor is the mindspace
// matcher's only false-positive defence (classify.ts:21) and applies to both.
describe("seedAliases", () => {
  const cases: [string, string, string[] | null | undefined, string[]][] = [
    [
      "falls back to the first name token only",
      "Lucca Martins de Andrade",
      undefined,
      ["Lucca"],
    ],
    ["a single-token name seeds itself", "Davi", null, ["Davi"]],
    ["an empty curated list falls back to the token", "Emma", [], ["Emma"]],
    [
      "curated aliases win over the name token",
      "Lucca Martins de Andrade",
      ["Lucca", "lu"],
      ["Lucca"],
    ],
    [
      "curated aliases keep their order and are not merged with the token",
      "Isabella",
      ["Isa", "Bella"],
      ["Isa", "Bella"],
    ],
    ["a first token under three characters seeds nothing", "Bo Nguyen", null, []],
    [
      "entries under three characters are dropped from curated lists",
      "Vinicius",
      ["Vini", "vi", "V"],
      ["Vini"],
    ],
    [
      "dedupes case-insensitively, keeping the first spelling",
      "Carla",
      ["Carla", "carla", "CARLA", "Carlinha"],
      ["Carla", "Carlinha"],
    ],
    ["trims surrounding whitespace", "  Denise  ", null, ["Denise"]],
    [
      "trims curated entries before measuring them",
      "Luis",
      ["  Lu  ", "  Luisinho  "],
      ["Luisinho"],
    ],
    ["an empty name seeds nothing", "", null, []],
  ];

  test.each(cases)("%s", (_label, name, curated, expected) => {
    expect(seedAliases(name, curated)).toEqual(expected);
  });
});
