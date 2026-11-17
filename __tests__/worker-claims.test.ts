// The home worker's claim guards (audit 2026-10-26, C1 + M7). Everything the
// PC is handed must be re-derived by the server, because `jobs.payload` was
// client-writable: a reel URL goes onto a command line, and a course source's
// storage path gets signed with the service role.
import { describe, expect, test } from "vitest";

import {
  canonicalReelRef,
  followupContext,
  FOLLOWUP_INSTRUCTION_MAX,
  FOLLOWUP_NOTES_MAX,
  FOLLOWUP_TITLE_MAX,
  parseFollowupResult,
  storagePathBelongsTo,
} from "@/app/lib/worker/claims";

describe("canonicalReelRef", () => {
  test("accepts the canonical form the enqueue paths write", () => {
    const ref = canonicalReelRef("https://www.instagram.com/reel/AbC-1_2/");
    expect(ref.ok).toBe(true);
    expect(ref.ok === true && ref.value).toEqual({
      url: "https://www.instagram.com/reel/AbC-1_2/",
      shortcode: "AbC-1_2",
    });
  });

  test("rejects a command-injection tail even though a reel link is in there", () => {
    // The exploit shape from the audit: extractInstagramUrl matches the head,
    // so "contains a reel link" is not a sufficient check — equality is.
    const ref = canonicalReelRef(
      "https://www.instagram.com/reel/AbC123/ & powershell -enc ZQBj",
    );
    expect(ref.ok).toBe(false);
  });

  test.each([
    ["a non-canonical but real share link", "https://instagram.com/p/AbC123/?igsh=xyz"],
    ["a lookalike host", "https://www.instagram.com.evil.test/reel/AbC123/"],
    ["a bare shell command", "x & powershell -enc ZQBj"],
    ["an empty url", ""],
    ["a non-string payload", { url: "https://www.instagram.com/reel/AbC123/" }],
    ["a trailing newline injection", "https://www.instagram.com/reel/AbC123/\nrm -rf /"],
  ])("rejects %s", (_label, value) => {
    expect(canonicalReelRef(value).ok).toBe(false);
  });

  test("trims surrounding whitespace before comparing", () => {
    expect(canonicalReelRef("  https://www.instagram.com/reel/AbC123/  ").ok).toBe(true);
  });
});

describe("storagePathBelongsTo", () => {
  const user = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";
  const source = "33333333-3333-4333-8333-333333333333";

  test("accepts the prefix attachSourceFile writes", () => {
    expect(storagePathBelongsTo(user, source, `${user}/${source}/lecture.pdf`)).toBe(true);
  });

  test("rejects another tenant's object path", () => {
    expect(storagePathBelongsTo(user, source, `${other}/${source}/lecture.pdf`)).toBe(false);
  });

  test("rejects another source's folder in the same account", () => {
    expect(
      storagePathBelongsTo(user, source, `${user}/44444444-4444-4444-8444-444444444444/x.pdf`),
    ).toBe(false);
  });

  test("rejects a path that only starts like the folder", () => {
    expect(storagePathBelongsTo(user, source, `${user}/${source}-evil/x.pdf`)).toBe(false);
  });

  test("rejects a missing or non-string path", () => {
    expect(storagePathBelongsTo(user, source, null)).toBe(false);
    expect(storagePathBelongsTo(user, source, 7)).toBe(false);
  });
});

describe("followupContext", () => {
  const task = {
    title: "book the dentist",
    notes: "called once, no answer",
    priority: "high",
    due_date: "2026-11-04",
    due_time: "09:30:00",
  };

  test("carries only server-read fields plus the instruction", () => {
    const context = followupContext(task, "health", {
      task_id: "t1",
      instruction: "find a clinic open saturdays",
      source: "apple watch",
      // Everything below is the forged half of a client-written payload.
      group_id: "forged-group",
      title: "forged title",
      notes: "forged notes",
      priority: "forged",
    });
    expect(context).toEqual({
      title: "book the dentist",
      notes: "called once, no answer",
      group_name: "health",
      due_date: "2026-11-04",
      due_time: "09:30:00",
      priority: "high",
      instruction: "find a clinic open saturdays",
      source: "apple watch",
    });
    expect(Object.keys(context)).not.toContain("group_id");
    expect(Object.keys(context)).not.toContain("task_id");
  });

  test("falls back when the payload's source is not one of the two known ones", () => {
    expect(followupContext(task, null, { source: "https://evil.test" }).source).toBe(
      "mindboard app",
    );
  });

  test("falls back when the stored priority is not a known one", () => {
    expect(followupContext({ ...task, priority: null }, null, {}).priority).toBe("med");
  });

  test("caps the instruction and the notes it ships to the pc", () => {
    const context = followupContext({ ...task, notes: "n".repeat(50_000) }, null, {
      instruction: "i".repeat(50_000),
    });
    expect(context.instruction.length).toBeLessThanOrEqual(FOLLOWUP_INSTRUCTION_MAX);
    expect(context.notes.length).toBeLessThanOrEqual(FOLLOWUP_NOTES_MAX);
  });

  test("a non-string instruction becomes empty, never 'undefined'", () => {
    expect(followupContext(task, null, { instruction: { toString: "x" } }).instruction).toBe("");
  });
});

describe("parseFollowupResult", () => {
  test("accepts the minimal shape the agent is told to print", () => {
    const parsed = parseFollowupResult({
      title: "call Dr Chen's office",
      notes: "- open sat 9-1\n- https://example.test",
      original_update: null,
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok === true && parsed.value).toEqual({
      title: "call Dr Chen's office",
      notes: "- open sat 9-1\n- https://example.test",
      original_update: null,
    });
  });

  test("a missing original_update is the same as null", () => {
    const parsed = parseFollowupResult({ title: "x" });
    expect(parsed.ok === true && parsed.value).toEqual({
      title: "x",
      notes: "",
      original_update: null,
    });
  });

  test("keeps only the update fields that were actually sent", () => {
    const parsed = parseFollowupResult({
      title: "x",
      original_update: { due_date: "2026-12-01", priority: "low" },
    });
    expect(parsed.ok === true && parsed.value.original_update).toEqual({
      due_date: "2026-12-01",
      priority: "low",
    });
  });

  test("an update with nothing usable in it collapses to null", () => {
    const parsed = parseFollowupResult({
      title: "x",
      original_update: { title: "   ", notes_append: "" },
    });
    expect(parsed.ok === true && parsed.value.original_update).toBeNull();
  });

  test.each([
    ["a non-object", "FOLLOWUP_RESULT: ok"],
    ["an array", [{ title: "x" }]],
    ["null", null],
    ["a missing title", { notes: "found it" }],
    ["a blank title", { title: "   " }],
    ["a non-string title", { title: 7 }],
    ["non-string notes", { title: "x", notes: ["a"] }],
    ["an array original_update", { title: "x", original_update: ["title"] }],
    ["a non-object original_update", { title: "x", original_update: "yes" }],
    ["a bad priority", { title: "x", original_update: { priority: "urgent" } }],
    ["a non-ISO due_date", { title: "x", original_update: { due_date: "Dec 1 2026" } }],
    ["an impossible due_date", { title: "x", original_update: { due_date: "2026-02-31" } }],
    ["a non-string update title", { title: "x", original_update: { title: 7 } }],
  ])("rejects %s", (_label, value) => {
    expect(parseFollowupResult(value).ok).toBe(false);
  });

  test("accepts a leap day and rejects the one that isn't", () => {
    expect(
      parseFollowupResult({ title: "x", original_update: { due_date: "2028-02-29" } }).ok,
    ).toBe(true);
    expect(
      parseFollowupResult({ title: "x", original_update: { due_date: "2027-02-29" } }).ok,
    ).toBe(false);
  });

  test("truncates runaway free text instead of failing a run that already cost money", () => {
    const parsed = parseFollowupResult({
      title: "t".repeat(5_000),
      notes: "n".repeat(100_000),
      original_update: { notes_append: "a".repeat(100_000) },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.title.length).toBeLessThanOrEqual(FOLLOWUP_TITLE_MAX);
    expect(parsed.value.notes.length).toBeLessThanOrEqual(FOLLOWUP_NOTES_MAX);
    expect(parsed.value.original_update?.notes_append?.length).toBeLessThanOrEqual(
      FOLLOWUP_NOTES_MAX,
    );
  });
});
