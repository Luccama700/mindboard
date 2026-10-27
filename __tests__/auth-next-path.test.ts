import { describe, expect, it } from "vitest";

import { safeNextPath } from "@/app/auth/callback/next-path";

const ORIGIN = "https://mindboard.example.app";

describe("safeNextPath", () => {
  it("keeps same-origin paths intact", () => {
    for (const next of [
      "/",
      "/tasks",
      "/finance?month=2026-10",
      "/brain/note/People/Lucca.md#open-questions",
      "/people/8a1f?from=dock",
    ]) {
      expect(safeNextPath(next, ORIGIN)).toBe(next);
    }
  });

  it("falls back to / when next is missing", () => {
    expect(safeNextPath(null, ORIGIN)).toBe("/");
    expect(safeNextPath(undefined, ORIGIN)).toBe("/");
    expect(safeNextPath("", ORIGIN)).toBe("/");
  });

  it("rejects anything that does not start with a single slash", () => {
    for (const next of [
      "https://evil.com",
      "http://evil.com/path",
      "evil.com",
      "tasks",
      "javascript:alert(1)",
      "data:text/html,<script>",
      "\\\\evil.com",
    ]) {
      expect(safeNextPath(next, ORIGIN)).toBe("/");
    }
  });

  it("rejects protocol-relative targets in both spellings", () => {
    expect(safeNextPath("//evil.com", ORIGIN)).toBe("/");
    expect(safeNextPath("//evil.com/tasks", ORIGIN)).toBe("/");
    // Browsers treat a backslash here exactly like a slash.
    expect(safeNextPath("/\\evil.com", ORIGIN)).toBe("/");
    expect(safeNextPath("/\\/evil.com", ORIGIN)).toBe("/");
  });

  it("rejects the userinfo trick the finding was filed for", () => {
    // `${origin}${next}` turned this into https://mindboard.example.app@evil.com
    expect(safeNextPath("@evil.com", ORIGIN)).toBe("/");
  });

  it("rejects whitespace-smuggled protocol-relative targets", () => {
    // WHATWG URL parsing strips tabs and newlines before resolving, so the
    // string prefix check passes and only the origin comparison catches these.
    expect(safeNextPath("/\t/evil.com", ORIGIN)).toBe("/");
    expect(safeNextPath("/\n/evil.com", ORIGIN)).toBe("/");
    expect(safeNextPath("/\r/evil.com", ORIGIN)).toBe("/");
  });

  it("compares against the origin it is given, not a hard-coded one", () => {
    expect(safeNextPath("/tasks", "http://localhost:3000")).toBe("/tasks");
    expect(safeNextPath("//evil.com", "http://localhost:3000")).toBe("/");
  });
});
