import { describe, expect, test } from "vitest";

import {
  extractTrailingRecurrence,
  extractTrailingTime,
  parseCapture,
  suggestCategory,
} from "@/app/lib/capture/parse";

const CATEGORIES = [
  { id: "food", name: "food" },
  { id: "transit", name: "transit" },
  { id: "groceries", name: "groceries" },
];

describe("parseCapture — mode routing", () => {
  test("bare text is a task, with trailing time extracted", () => {
    expect(parseCapture("call landlord 3pm")).toEqual({
      mode: "task",
      title: "call landlord",
      time: "15:00",
    });
    expect(parseCapture("buy milk")).toEqual({
      mode: "task",
      title: "buy milk",
      time: null,
    });
  });

  test("$ parses amount, description, and a suggested category", () => {
    expect(parseCapture("$ 12.50 groceries run", CATEGORIES)).toEqual({
      mode: "spend",
      amount: 12.5,
      description: "groceries run",
      categoryId: "groceries",
    });
    expect(parseCapture("$14 lunch", CATEGORIES)).toEqual({
      mode: "spend",
      amount: 14,
      description: "lunch",
      categoryId: null,
    });
  });

  test("$ with a comma decimal and no description still parses", () => {
    expect(parseCapture("$9,99", [])).toEqual({
      mode: "spend",
      amount: 9.99,
      description: "",
      categoryId: null,
    });
  });

  test("$ without a valid amount yields amount null (never a silent guess)", () => {
    expect(parseCapture("$ lunch", [])).toEqual({
      mode: "spend",
      amount: null,
      description: "lunch",
      categoryId: null,
    });
  });

  test("? hands the message to the copilot", () => {
    expect(parseCapture("? plan my evening")).toEqual({
      mode: "copilot",
      message: "plan my evening",
    });
    expect(parseCapture("?")).toEqual({ mode: "copilot", message: "" });
  });

  test("sigils only count at the start", () => {
    expect(parseCapture("pay $14 back to Dan").mode).toBe("task");
    expect(parseCapture("what? really").mode).toBe("task");
  });
});

describe("suggestCategory", () => {
  test("exact name containment wins", () => {
    expect(suggestCategory("weekly groceries haul", CATEGORIES)).toBe(
      "groceries",
    );
  });

  test("word-prefix match with 4+ chars", () => {
    expect(suggestCategory("groc run", CATEGORIES)).toBe("groceries");
  });

  test("no match yields null — suggestion only, never a guess", () => {
    expect(suggestCategory("random thing", CATEGORIES)).toBeNull();
    expect(suggestCategory("", CATEGORIES)).toBeNull();
  });
});

describe("extractTrailingTime", () => {
  test.each([
    ["call landlord 3pm", "call landlord", "15:00"],
    ["call landlord at 3pm", "call landlord", "15:00"],
    ["gym 17:30", "gym", "17:30"],
    ["standup 9:15am", "standup", "09:15"],
    ["lunch 12pm", "lunch", "12:00"],
    ["night walk 12am", "night walk", "00:00"],
    ["review notes 08:00", "review notes", "08:00"],
    ["dinner 7 pm", "dinner", "19:00"],
  ])("%s -> %s @ %s", (input, title, time) => {
    const parsed = extractTrailingTime(input);
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe(title);
    expect(parsed!.time).toBe(time);
  });

  test.each([
    "buy 2", // bare number: quantity, not a time
    "buy milk", // no time at all
    "call at 25:00", // invalid hour
    "3pm", // time only, no title left
    "meet at 9:75", // invalid minutes
  ])("rejects %s", (input) => {
    expect(extractTrailingTime(input)).toBeNull();
  });

  test("a time in the middle of the title is not extracted", () => {
    expect(extractTrailingTime("3pm call with landlord")).toBeNull();
  });
});

describe("extractTrailingRecurrence", () => {
  test("daily forms", () => {
    for (const input of ["lunch daily", "lunch every day", "lunch everyday"]) {
      const rec = extractTrailingRecurrence(input);
      expect(rec).not.toBeNull();
      expect(rec!.title).toBe("lunch");
      expect(rec!.rule.frequency).toBe("daily");
    }
  });

  test("weekday slash lists dedupe and sort", () => {
    const rec = extractTrailingRecurrence("gym fri/mon/wed/mon");
    expect(rec).not.toBeNull();
    expect(rec!.title).toBe("gym");
    expect(rec!.rule).toMatchObject({ frequency: "weekly", weekdays: [1, 3, 5] });
  });

  test("every <weekday> and weekdays", () => {
    expect(extractTrailingRecurrence("laundry every sunday")!.rule).toMatchObject({
      frequency: "weekly",
      weekdays: [0],
    });
    expect(extractTrailingRecurrence("standup weekdays")!.rule).toMatchObject({
      frequency: "weekly",
      weekdays: [1, 2, 3, 4, 5],
    });
  });

  test("every N days is custom; every 1 day collapses to daily", () => {
    expect(extractTrailingRecurrence("water plants every 3 days")!.rule).toMatchObject({
      frequency: "custom",
      interval_days: 3,
    });
    expect(extractTrailingRecurrence("stretch every 1 day")!.rule.frequency).toBe(
      "daily",
    );
  });

  test.each([
    "buy every day pass tomorrow", // recurrence words not trailing
    "call mom mon", // single bare weekday is too ambiguous
    "run every morning", // not a weekday
    "daily", // no title left
  ])("rejects %s", (input) => {
    expect(extractTrailingRecurrence(input)).toBeNull();
  });

  test("the three modes stay untouched", () => {
    expect(parseCapture("$12 lunch daily").mode).toBe("spend");
    expect(parseCapture("? plan my week daily").mode).toBe("copilot");
    expect(parseCapture("lunch daily")).toEqual({
      mode: "task",
      title: "lunch daily",
      time: null,
    });
  });
});
