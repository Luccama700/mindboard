import { describe, expect, test } from "vitest";
import {
  buildChoreRow,
  describeChore,
  feedingSlot,
  nextUpAfter,
  resolveNames,
  rotationFor,
  vanToday,
  type HomeChore,
  type HomeMember,
} from "@/app/lib/home/logic";

const lucca: HomeMember = { id: "l", name: "Lucca", email: "l@x", role: "resident", sort_order: 1, in_rotation: true };
const julia: HomeMember = { id: "j", name: "Julia", email: "j@x", role: "resident", sort_order: 2, in_rotation: true };
const nikki: HomeMember = { id: "n", name: "Nikki", email: "n@x", role: "guest", sort_order: 3, in_rotation: false };
const members = [nikki, julia, lucca];

const chore = (over: Partial<HomeChore> = {}): HomeChore => ({
  id: "c1",
  name: "Dishes",
  frequency: "daily",
  interval_days: 1,
  assigned_to: "l",
  assignees: null,
  due_date: "2026-09-25",
  ...over,
});

describe("Vancouver dates", () => {
  test("today follows Vancouver, not the UTC process clock", () => {
    expect(vanToday(new Date("2026-09-25T06:30:00Z"))).toBe("2026-09-24");
  });

  test("feeding slot flips halfway between the two times", () => {
    expect(feedingSlot(new Date("2026-09-24T19:59:00Z"), "08:00:00", "18:00:00")).toBe("morning");
    expect(feedingSlot(new Date("2026-09-24T20:00:00Z"), "08:00", "18:00")).toBe("evening");
  });
});

describe("rotation", () => {
  test("default rotation is the in-rotation members in order", () => {
    expect(rotationFor(chore(), members).map((m) => m.name)).toEqual(["Lucca", "Julia"]);
  });

  test("a chore's own assignees override the default, guests included", () => {
    expect(rotationFor(chore({ assignees: ["n"] }), members).map((m) => m.name)).toEqual(["Nikki"]);
  });

  test("next up mirrors complete_chore_as", () => {
    expect(nextUpAfter(chore(), members, "l")?.name).toBe("Julia");
    expect(nextUpAfter(chore(), members, "j")?.name).toBe("Lucca");
    expect(nextUpAfter(chore({ assigned_to: "j" }), members, "n")?.name).toBe("Lucca");
    expect(nextUpAfter(chore({ assignees: ["l"] }), members, "l")?.name).toBe("Lucca");
  });
});

describe("resolveNames", () => {
  test("matches case-insensitively and returns rotation order", () => {
    expect(resolveNames(["julia", "LUCCA"], members)).toEqual({ ok: true, value: ["l", "j"] });
  });

  test("rejects unknown names", () => {
    const r = resolveNames(["Taiga"], members);
    expect(r.ok).toBe(false);
  });
});

describe("buildChoreRow", () => {
  test("new chore needs a name", () => {
    expect(buildChoreRow({}, null, members, "2026-09-25").ok).toBe(false);
  });

  test("interval chores need intervalDays", () => {
    expect(buildChoreRow({ name: "Plants", frequency: "interval" }, null, members, "2026-09-25").ok).toBe(false);
  });

  test("upNext outside the assignees snaps to the first assignee", () => {
    const r = buildChoreRow({ name: "Litter", assignees: ["Lucca"], upNext: "Julia" }, null, members, "2026-09-25");
    expect(r).toEqual({
      ok: true,
      value: {
        name: "Litter",
        frequency: "weekly",
        interval_days: 7,
        assigned_to: "l",
        assignees: ["l"],
        due_date: "2026-09-25",
      },
    });
  });

  test("edits keep omitted fields; [] clears assignees back to the default rotation", () => {
    const existing = chore({ assignees: ["l"], frequency: "interval", interval_days: 4 });
    const r = buildChoreRow({ assignees: [] }, existing, members, "2026-09-26");
    expect(r.ok && r.value).toMatchObject({ name: "Dishes", interval_days: 4, assignees: null, due_date: "2026-09-25" });
  });
});

test("describeChore labels who and when", () => {
  const d = describeChore(chore({ assignees: ["l"], due_date: "2026-09-23" }), members, "2026-09-25");
  expect(d).toMatchObject({ upNext: "Lucca", whoDoesIt: "Lucca only", status: "overdue by 2 days" });
});
