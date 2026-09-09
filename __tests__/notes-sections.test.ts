import { describe, expect, it } from "vitest";
import { firstLine, latestSection } from "@/app/_components/notes-sections";

const NOTES = [
  "call the landlord about the lease",
  "",
  "---",
  "",
  "## AI approach — 2026-09-01",
  "",
  "draft the email for you",
  "",
  "---",
  "",
  "## AI triage — 2026-09-09",
  "",
  "needs a phone call, which I can't make",
  "",
  "*✦ follow up or ✦ do it if you want the PC to try anyway.*",
].join("\n");

describe("latestSection", () => {
  it("returns the body of the last section whose heading starts with the name", () => {
    expect(latestSection(NOTES, "AI triage")).toBe(
      "needs a phone call, which I can't make\n\n*✦ follow up or ✦ do it if you want the PC to try anyway.*",
    );
  });

  it("matches the heading prefix, ignoring the date suffix", () => {
    expect(latestSection(NOTES, "AI approach")).toBe("draft the email for you");
  });

  it("picks the LAST matching section when there are several", () => {
    const twice = `${NOTES}\n\n---\n\n## AI triage — 2026-09-10\n\nstill a phone call`;
    expect(latestSection(twice, "AI triage")).toBe("still a phone call");
  });

  it("returns null when the section is absent or the notes are empty", () => {
    expect(latestSection(NOTES, "AI result")).toBeNull();
    expect(latestSection(null, "AI triage")).toBeNull();
    expect(latestSection("", "AI triage")).toBeNull();
  });
});

describe("firstLine", () => {
  it("returns the first non-empty line, clipped with an ellipsis", () => {
    expect(firstLine("needs a phone call\n\nmore")).toBe("needs a phone call");
    expect(firstLine("x".repeat(200), 20)).toBe(`${"x".repeat(19)}…`);
    expect(firstLine(null)).toBeNull();
    expect(firstLine("   ")).toBeNull();
  });
});
