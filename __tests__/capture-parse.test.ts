import { describe, expect, test } from "vitest";

import { extractTrailingTime } from "@/app/lib/capture/parse";

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
