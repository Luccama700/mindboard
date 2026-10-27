// The home worker's claim guards (audit 2026-10-26, C1 + M7). Everything the
// PC is handed must be re-derived by the server, because `jobs.payload` was
// client-writable: a reel URL goes onto a command line, and a course source's
// storage path gets signed with the service role.
import { describe, expect, test } from "vitest";

import { canonicalReelRef, storagePathBelongsTo } from "@/app/lib/worker/claims";

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
