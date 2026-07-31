// Task-notes composition, shared by every surface that writes back into
// tasks.notes. This is a straight port of overnight/lib.mjs (clip +
// appendSection) and MUST stay byte-identical to it: the app appends the
// operator note, the overnight worker appends the result, and the two must
// agree on the divider and the trimming rule or a note gets mangled.
// __tests__/notes-append.test.ts asserts the parity.

export function clip(text: string | null | undefined, max: number): string {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  const marker = "\n\n[truncated]";
  return value.slice(0, Math.max(0, max - marker.length)) + marker;
}

// Append a dated markdown section to a task's notes without clobbering what
// the user wrote. The whole blob is hard-capped so repeated runs cannot grow
// it without bound — and the NEW section always survives the cap (it is the
// deliverable): over cap, old notes are trimmed instead, keeping their start
// (the user's own text lives at the top).
export function appendSection(
  notes: string | null | undefined,
  heading: string,
  body: string,
  maxLen = 12000,
): string {
  const head = notes?.trim() ? `${notes.trim()}\n\n---\n\n` : "";
  const bodyRoom = Math.max(200, maxLen - head.length - heading.length - 8);
  const section = `## ${heading}\n\n${clip(body.trim(), bodyRoom)}`;
  if (head.length + section.length <= maxLen) return head + section;
  // Only reachable when the head itself is oversized: trim the old notes.
  const room = maxLen - section.length - 8;
  const trimmedHead =
    room > 40 ? `${clip((notes as string).trim(), room)}\n\n---\n\n` : "";
  return trimmedHead + section;
}
