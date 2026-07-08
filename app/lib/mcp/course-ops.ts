// Pure logic for the chunked course-source upload (begin_source_upload →
// append_source_markdown → finalize_source): validation, part assembly,
// vault path building, and the frontmatter document. No server imports so it
// unit-tests directly; the server glue lives in ./courses.ts.

import {
  sanitizeCaptureTitle,
  vancouverStamp,
  type CaptureStamp,
} from "./capture";
import type { Result } from "./validate";

export const SOURCE_PART_MAX_CHARS = 20_000;
export const SOURCE_MAX_PARTS = 60;
export const SOURCE_TITLE_MAX = 200;

export type SourcePart = { part_index: number; markdown: string };

export function validateBeginUpload(raw: {
  title?: unknown;
  page_count?: unknown;
}): Result<{ title: string; pageCount: number | null }> {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return { ok: false, error: "title is required" };
  if (title.length > SOURCE_TITLE_MAX) {
    return {
      ok: false,
      error: `title must be at most ${SOURCE_TITLE_MAX} characters (got ${title.length})`,
    };
  }
  let pageCount: number | null = null;
  if (raw.page_count != null) {
    const parsed = Number(raw.page_count);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5000) {
      return { ok: false, error: "page_count must be a positive integer" };
    }
    pageCount = parsed;
  }
  return { ok: true, value: { title, pageCount } };
}

export function validatePart(raw: {
  part_index?: unknown;
  markdown?: unknown;
}): Result<SourcePart> {
  const index = Number(raw.part_index);
  if (!Number.isInteger(index) || index < 1 || index > SOURCE_MAX_PARTS) {
    return {
      ok: false,
      error: `part_index must be an integer between 1 and ${SOURCE_MAX_PARTS}`,
    };
  }
  const markdown = typeof raw.markdown === "string" ? raw.markdown : "";
  if (!markdown.trim()) return { ok: false, error: "markdown is required" };
  if (markdown.length > SOURCE_PART_MAX_CHARS) {
    return {
      ok: false,
      error: `markdown must be at most ${SOURCE_PART_MAX_CHARS} characters per part (got ${markdown.length}) — split into more parts`,
    };
  }
  return { ok: true, value: { part_index: index, markdown } };
}

// Parts must be contiguous 1..n — a gap means an append never landed, and
// silently stitching around it would ship a hole into the vault.
export function assembleParts(parts: SourcePart[]): Result<string> {
  if (parts.length === 0) {
    return { ok: false, error: "no parts uploaded — call append_source_markdown first" };
  }
  const sorted = [...parts].sort((a, b) => a.part_index - b.part_index);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].part_index !== i + 1) {
      return {
        ok: false,
        error: `parts are not contiguous: expected part ${i + 1}, found part ${sorted[i].part_index}`,
      };
    }
  }
  return {
    ok: true,
    value: sorted.map((part) => part.markdown.replace(/\s+$/, "")).join("\n\n"),
  };
}

export function courseSourcePath(
  courseName: string,
  sourceTitle: string,
  attempt: number,
): Result<string> {
  const safeCourse = sanitizeCaptureTitle(courseName);
  if (!safeCourse.ok) return safeCourse;
  const safeTitle = sanitizeCaptureTitle(sourceTitle);
  if (!safeTitle.ok) return safeTitle;
  const suffix = attempt > 1 ? ` -${attempt}` : "";
  return {
    ok: true,
    value: `Courses/${safeCourse.value}/Sources/${safeTitle.value}${suffix}.md`,
  };
}

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildSourceDocument(input: {
  courseName: string;
  title: string;
  kind: string;
  pageCount: number | null;
  markdown: string;
  stamp: CaptureStamp;
  via: string;
}): string {
  const lines = [
    "---",
    "type: course-source",
    `course: ${yamlQuote(input.courseName)}`,
    `source_kind: ${input.kind}`,
    `created: ${input.stamp.created}`,
    `via: ${yamlQuote(input.via)}`,
  ];
  if (input.pageCount) lines.push(`pages: ${input.pageCount}`);
  lines.push("---", "", `# ${input.title}`, "", input.markdown, "");
  return lines.join("\n");
}

export { vancouverStamp };
