// Read-side helpers for the "## Heading — <date>" sections the overnight
// agent appends to task notes (appendSection in overnight/lib.mjs separates
// sections with a "---" rule). Pure; used by the task edit panel to surface
// the latest triage reason without parsing markdown.

export function latestSection(
  notes: string | null | undefined,
  heading: string,
): string | null {
  if (!notes) return null;
  const lines = notes.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("## ") && line.slice(3).trim().startsWith(heading)) {
      start = i;
    }
  }
  if (start === -1) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("## ") || trimmed === "---") break;
    body.push(line);
  }
  const text = body.join("\n").trim();
  return text.length > 0 ? text : null;
}

export function firstLine(
  text: string | null | undefined,
  max = 140,
): string | null {
  if (!text) return null;
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
