import { describe, expect, test } from "vitest";

import {
  GROUP_PALETTE,
  MAX_PROMPT_PEOPLE,
  MAX_SUGGESTED_GROUPS,
  buildGroupSuggestionOps,
  type GroupSuggestion,
  type SuggesterGroup,
  type SuggesterPerson,
} from "@/app/lib/people/suggest-groups";
import { MAX_PEOPLE_OPS } from "@/app/lib/mcp/people-ops";

// The Claude call is a thin shell; this is where the correctness lives —
// a model's answer mapped onto an update_people batch, dropping whatever it
// got wrong instead of failing the whole proposal.

const ROSTER: SuggesterPerson[] = [
  { id: "p-davi", name: "Davi" },
  { id: "p-emma", name: "Emma" },
  { id: "p-luis", name: "Luis" },
];

function build(
  suggestions: GroupSuggestion[],
  roster: SuggesterPerson[] = ROSTER,
  existingGroups: SuggesterGroup[] = [],
) {
  return buildGroupSuggestionOps({ roster, existingGroups, suggestions });
}

// isRankingGroupName itself is tested in people-ops.test.ts, where it now
// lives — validatePeopleOps is the enforcement point; this file only checks
// that the mapper DROPS a ranking suggestion rather than failing the batch.

describe("buildGroupSuggestionOps", () => {
  test("creates a group and files its members by id", () => {
    const ops = build([{ name: "family", members: ["Davi", "Emma"] }]);
    expect(ops).toEqual([
      { op: "create_group", name: "family", color: GROUP_PALETTE[0] },
      { op: "set_group", person: "p-davi", group: "family" },
      { op: "set_group", person: "p-emma", group: "family" },
    ]);
  });

  test("reuses an existing group by id instead of re-creating it", () => {
    const ops = build(
      [{ name: "Family", members: ["Davi"] }],
      ROSTER,
      [{ id: "g-family", name: "family" }],
    );
    expect(ops).toEqual([{ op: "set_group", person: "p-davi", group: "g-family" }]);
  });

  test("drops member names that are not on the roster", () => {
    const ops = build([{ name: "family", members: ["Davi", "Nobody At All"] }]);
    expect(ops).toEqual([
      { op: "create_group", name: "family", color: GROUP_PALETTE[0] },
      { op: "set_group", person: "p-davi", group: "family" },
    ]);
  });

  test("drops a whole group once every member is unknown", () => {
    const ops = build([
      { name: "ghosts", members: ["Nobody"] },
      { name: "family", members: ["Davi"] },
    ]);
    expect(ops).toEqual([
      { op: "create_group", name: "family", color: GROUP_PALETTE[0] },
      { op: "set_group", person: "p-davi", group: "family" },
    ]);
  });

  test("refuses closeness tiers even when the model proposes them", () => {
    const ops = build([
      { name: "close friends", members: ["Davi", "Emma"] },
      { name: "ubc", members: ["Luis"] },
    ]);
    expect(ops).toEqual([
      { op: "create_group", name: "ubc", color: GROUP_PALETTE[0] },
      { op: "set_group", person: "p-luis", group: "ubc" },
    ]);
  });

  test("a person lands in only the first group that claims them", () => {
    const ops = build([
      { name: "family", members: ["Davi"] },
      { name: "ubc", members: ["Davi", "Emma"] },
    ]);
    expect(ops.filter((op) => op.op === "set_group")).toEqual([
      { op: "set_group", person: "p-davi", group: "family" },
      { op: "set_group", person: "p-emma", group: "ubc" },
    ]);
  });

  test("an ambiguous duplicate roster name files neither person", () => {
    const ops = build(
      [{ name: "family", members: ["Davi", "Emma"] }],
      [
        { id: "p-1", name: "Davi" },
        { id: "p-2", name: "davi" },
        { id: "p-emma", name: "Emma" },
      ],
    );
    expect(ops).toEqual([
      { op: "create_group", name: "family", color: GROUP_PALETTE[0] },
      { op: "set_group", person: "p-emma", group: "family" },
    ]);
  });

  test("colors round-robin past the groups the user already has", () => {
    const ops = build(
      [
        { name: "ubc", members: ["Davi"] },
        { name: "brazil", members: ["Emma"] },
      ],
      ROSTER,
      [{ id: "g-family", name: "family" }],
    );
    const creates = ops.filter((op) => op.op === "create_group");
    expect(creates).toEqual([
      { op: "create_group", name: "ubc", color: GROUP_PALETTE[1] },
      { op: "create_group", name: "brazil", color: GROUP_PALETTE[2] },
    ]);
  });

  test("a duplicate suggested name is only honoured once", () => {
    const ops = build([
      { name: "family", members: ["Davi"] },
      { name: "Family", members: ["Emma"] },
    ]);
    expect(ops).toEqual([
      { op: "create_group", name: "family", color: GROUP_PALETTE[0] },
      { op: "set_group", person: "p-davi", group: "family" },
    ]);
  });

  // The point of sizing MAX_PROMPT_PEOPLE off MAX_PEOPLE_OPS: a full prompt
  // split into the maximum number of groups must not lose anyone, or the
  // suggester spends the API call to produce ops it then discards.
  test("a maximal prompt fits in one batch with nobody dropped", () => {
    const roster = Array.from({ length: MAX_PROMPT_PEOPLE }, (_, i) => ({
      id: `p-${i}`,
      name: `Person ${i}`,
    }));
    const per = Math.ceil(roster.length / MAX_SUGGESTED_GROUPS);
    const suggestions = Array.from({ length: MAX_SUGGESTED_GROUPS }, (_, g) => ({
      name: `context ${g}`,
      members: roster.slice(g * per, (g + 1) * per).map((p) => p.name),
    }));
    const ops = build(suggestions, roster);
    expect(ops.filter((op) => op.op === "set_group")).toHaveLength(
      MAX_PROMPT_PEOPLE,
    );
    expect(ops.length).toBeLessThanOrEqual(MAX_PEOPLE_OPS);
  });

  test("caps the batch at MAX_PEOPLE_OPS rather than proposing an invalid one", () => {
    const roster = Array.from({ length: 80 }, (_, i) => ({
      id: `p-${i}`,
      name: `Person ${i}`,
    }));
    const ops = build(
      [{ name: "ubc", members: roster.map((p) => p.name) }],
      roster,
    );
    expect(ops.length).toBe(MAX_PEOPLE_OPS);
    expect(ops[0]).toEqual({
      op: "create_group",
      name: "ubc",
      color: GROUP_PALETTE[0],
    });
  });

  test("a group that cannot fit at all is skipped, not half-created", () => {
    const roster = Array.from({ length: 60 }, (_, i) => ({
      id: `p-${i}`,
      name: `Person ${i}`,
    }));
    const ops = build(
      [
        { name: "ubc", members: roster.slice(0, 49).map((p) => p.name) },
        { name: "brazil", members: roster.slice(49).map((p) => p.name) },
      ],
      roster,
    );
    expect(ops.length).toBe(MAX_PEOPLE_OPS);
    expect(ops.filter((op) => op.op === "create_group")).toEqual([
      { op: "create_group", name: "ubc", color: GROUP_PALETTE[0] },
    ]);
  });

  test("garbage in, empty batch out", () => {
    expect(build([])).toEqual([]);
    expect(build([{ name: "   ", members: ["Davi"] }])).toEqual([]);
    expect(build([{ name: "family", members: "Davi" }])).toEqual([]);
    expect(build([{ name: 42, members: [7, null] }])).toEqual([]);
  });

  test("only the first six groups are honoured", () => {
    const roster = Array.from({ length: 8 }, (_, i) => ({
      id: `p-${i}`,
      name: `Person ${i}`,
    }));
    const ops = build(
      roster.map((p, i) => ({ name: `context ${i}`, members: [p.name] })),
      roster,
    );
    expect(ops.filter((op) => op.op === "create_group")).toHaveLength(6);
  });
});
