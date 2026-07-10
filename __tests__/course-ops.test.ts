import { describe, expect, it } from "vitest";
import {
  assembleParts,
  buildSourceDocument,
  courseSourcePath,
  validateBeginUpload,
  validatePart,
  vancouverStamp,
  SOURCE_MAX_PARTS,
  SOURCE_PART_MAX_CHARS,
} from "@/app/lib/mcp/course-ops";
import { resolveCourse } from "@/app/lib/mcp/courses";
import type { Course } from "@/app/_components/learn-types";

describe("validateBeginUpload", () => {
  it("requires a title", () => {
    const r = validateBeginUpload({ title: "   " });
    expect(r.ok).toBe(false);
  });

  it("caps title length with the actual length in the error", () => {
    const r = validateBeginUpload({ title: "x".repeat(201) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("201");
  });

  it("accepts an optional positive integer page count", () => {
    const r = validateBeginUpload({ title: "Lecture 1", page_count: 42 });
    expect(r).toEqual({ ok: true, value: { title: "Lecture 1", pageCount: 42 } });
  });

  it("rejects a fractional or negative page count", () => {
    expect(validateBeginUpload({ title: "L", page_count: 2.5 }).ok).toBe(false);
    expect(validateBeginUpload({ title: "L", page_count: -3 }).ok).toBe(false);
  });

  it("accepts a title at exactly the length cap", () => {
    const r = validateBeginUpload({ title: "x".repeat(200) });
    expect(r.ok).toBe(true);
  });

  it("enforces the page_count range at its exact boundaries (1-5000)", () => {
    expect(validateBeginUpload({ title: "L", page_count: 0 }).ok).toBe(false);
    expect(validateBeginUpload({ title: "L", page_count: 1 }).ok).toBe(true);
    expect(validateBeginUpload({ title: "L", page_count: 5000 }).ok).toBe(true);
    expect(validateBeginUpload({ title: "L", page_count: 5001 }).ok).toBe(false);
  });
});

describe("validatePart", () => {
  it("accepts a valid part", () => {
    const r = validatePart({ part_index: 1, markdown: "# hi" });
    expect(r).toEqual({ ok: true, value: { part_index: 1, markdown: "# hi" } });
  });

  it("rejects part_index 0, fractions, and beyond the cap", () => {
    expect(validatePart({ part_index: 0, markdown: "x" }).ok).toBe(false);
    expect(validatePart({ part_index: 1.5, markdown: "x" }).ok).toBe(false);
    expect(
      validatePart({ part_index: SOURCE_MAX_PARTS + 1, markdown: "x" }).ok,
    ).toBe(false);
  });

  it("rejects blank and oversized markdown, naming the size", () => {
    expect(validatePart({ part_index: 1, markdown: "  " }).ok).toBe(false);
    const over = validatePart({
      part_index: 1,
      markdown: "y".repeat(SOURCE_PART_MAX_CHARS + 1),
    });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain(String(SOURCE_PART_MAX_CHARS + 1));
  });

  it("accepts part_index and markdown length at their exact caps", () => {
    expect(validatePart({ part_index: SOURCE_MAX_PARTS, markdown: "x" }).ok).toBe(true);
    expect(
      validatePart({ part_index: 1, markdown: "y".repeat(SOURCE_PART_MAX_CHARS) }).ok,
    ).toBe(true);
  });
});

describe("assembleParts", () => {
  it("joins contiguous parts in index order regardless of arrival order", () => {
    const r = assembleParts([
      { part_index: 2, markdown: "second" },
      { part_index: 1, markdown: "first  \n" },
      { part_index: 3, markdown: "third" },
    ]);
    expect(r).toEqual({ ok: true, value: "first\n\nsecond\n\nthird" });
  });

  it("fails on an empty part set", () => {
    expect(assembleParts([]).ok).toBe(false);
  });

  it("fails on a gap, naming the missing part", () => {
    const r = assembleParts([
      { part_index: 1, markdown: "a" },
      { part_index: 3, markdown: "c" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("expected part 2");
  });

  it("fails when parts start past 1", () => {
    const r = assembleParts([{ part_index: 2, markdown: "b" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("expected part 1");
  });

  it("treats a duplicate part_index as a contiguity failure, not a silent overwrite", () => {
    const r = assembleParts([
      { part_index: 1, markdown: "a" },
      { part_index: 2, markdown: "b" },
      { part_index: 2, markdown: "b again" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("expected part 3");
  });
});

describe("courseSourcePath", () => {
  it("builds Courses/<course>/Sources/<title>.md", () => {
    const r = courseSourcePath("Linear Algebra", "Lecture 12", 1);
    expect(r).toEqual({
      ok: true,
      value: "Courses/Linear Algebra/Sources/Lecture 12.md",
    });
  });

  it("suffixes collisions from attempt 2", () => {
    const r = courseSourcePath("Math", "Notes", 3);
    expect(r).toEqual({ ok: true, value: "Courses/Math/Sources/Notes -3.md" });
  });

  it("flattens path separators inside names", () => {
    const r = courseSourcePath("CPSC/110", "a\\b", 1);
    expect(r).toEqual({ ok: true, value: "Courses/CPSC 110/Sources/a b.md" });
  });

  it("rejects traversal in either segment", () => {
    expect(courseSourcePath("..", "notes", 1).ok).toBe(false);
    expect(courseSourcePath("Math", "../../etc", 1).ok).toBe(false);
  });
});

describe("buildSourceDocument", () => {
  it("emits course-source frontmatter, title heading, and the body", () => {
    const doc = buildSourceDocument({
      courseName: 'Phys "101"',
      title: "Lecture 1",
      kind: "pdf",
      pageCount: 12,
      markdown: "<!-- p.1 -->\nBody text",
      stamp: vancouverStamp(new Date("2026-07-08T20:00:00Z")),
      via: "MCP",
    });
    expect(doc).toContain("type: course-source");
    expect(doc).toContain('course: "Phys \\"101\\""');
    expect(doc).toContain("source_kind: pdf");
    expect(doc).toContain("pages: 12");
    expect(doc).toContain('via: "MCP"');
    expect(doc).toContain("# Lecture 1");
    expect(doc).toContain("<!-- p.1 -->\nBody text");
  });

  it("omits the pages line when page count is unknown", () => {
    const doc = buildSourceDocument({
      courseName: "Math",
      title: "T",
      kind: "markdown",
      pageCount: null,
      markdown: "x",
      stamp: vancouverStamp(new Date("2026-07-08T20:00:00Z")),
      via: "assistant",
    });
    expect(doc).not.toContain("pages:");
  });

  it("escapes backslashes in YAML frontmatter fields before quotes", () => {
    const doc = buildSourceDocument({
      courseName: "C:\\Users\\me",
      title: "T",
      kind: "markdown",
      pageCount: null,
      markdown: "x",
      stamp: vancouverStamp(new Date("2026-07-08T20:00:00Z")),
      via: "assistant",
    });
    expect(doc).toContain('course: "C:\\\\Users\\\\me"');
  });
});

const COURSES: Course[] = [
  {
    id: "c-la",
    name: "Linear Algebra",
    code: "MATH 221",
    term: "2026W1",
    color: "#fff",
    archived: false,
    created_at: "",
  },
  {
    id: "c-phys",
    name: "Physics",
    code: "PHYS 101",
    term: null,
    color: "#fff",
    archived: false,
    created_at: "",
  },
  {
    id: "c-phys2",
    name: "Physics Lab",
    code: null,
    term: null,
    color: "#fff",
    archived: false,
    created_at: "",
  },
];

describe("resolveCourse", () => {
  it("resolves by exact id", () => {
    const r = resolveCourse(COURSES, "c-la");
    expect(r.ok && r.value.id).toBe("c-la");
  });

  it("resolves by exact name case-insensitively", () => {
    const r = resolveCourse(COURSES, "physics");
    expect(r.ok && r.value.id).toBe("c-phys");
  });

  it("resolves by course code", () => {
    const r = resolveCourse(COURSES, "MATH 221");
    expect(r.ok && r.value.id).toBe("c-la");
  });

  it("resolves a unique substring", () => {
    const r = resolveCourse(COURSES, "linear");
    expect(r.ok && r.value.id).toBe("c-la");
  });

  it("fails ambiguous substrings with candidates", () => {
    const r = resolveCourse(COURSES, "phys");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Physics");
      expect(r.error).toContain("Physics Lab");
    }
  });

  it("fails unknown refs with a pointer to list_courses", () => {
    const r = resolveCourse(COURSES, "chemistry");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("list_courses");
  });
});
