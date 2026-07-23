// Parser for the claude.ai data export's conversations.json. Pure and
// browser-safe: the file parses in the client (exports run tens of MB — far
// past server-action body limits) and only compact per-session records reach
// the server. Tolerant of format drift: field names have shifted across export
// versions, so every access has a fallback. Sessions split on hour-plus gaps,
// and only the user's own words are kept, hard-capped per session.

export type ImportedSession = {
  ref: string;
  title: string;
  startedAt: string;
  endedAt: string;
  durationMin: number;
  userText: string;
  wordCount: number;
};

export type ParsedExport = {
  sessions: ImportedSession[];
  conversationCount: number;
  skippedOld: number;
  malformed: number;
};

const SESSION_GAP_MS = 60 * 60 * 1000;
const USER_TEXT_CAP = 6000;
const MAX_SESSION_MINUTES = 120;
const MIN_SESSION_MINUTES = 2;

type RawMessage = { text: string; atMs: number; fromUser: boolean };

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function messageText(raw: Record<string, unknown>): string {
  const direct = asString(raw.text);
  if (direct) return direct;
  const content = raw.content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const b = block as Record<string, unknown>;
        return b.type === "text" ? (asString(b.text) ?? "") : "";
      })
      .filter((text) => text.length > 0)
      .join("\n");
  }
  return asString(content) ?? "";
}

function parseMessages(rawMessages: unknown[]): RawMessage[] {
  const messages: RawMessage[] = [];
  for (const raw of rawMessages) {
    if (typeof raw !== "object" || raw === null) continue;
    const message = raw as Record<string, unknown>;
    const atMs = Date.parse(
      asString(message.created_at) ?? asString(message.updated_at) ?? "",
    );
    if (Number.isNaN(atMs)) continue;
    const sender = asString(message.sender) ?? asString(message.role) ?? "";
    messages.push({
      text: messageText(message),
      atMs,
      fromUser: sender === "human" || sender === "user",
    });
  }
  return messages.sort((a, b) => a.atMs - b.atMs);
}

export function countWordsIn(text: string): number {
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}

export function parseClaudeExport(
  json: unknown,
  nowMs: number,
  maxAgeDays = 60,
): ParsedExport {
  const conversations = Array.isArray(json)
    ? json
    : Array.isArray((json as { conversations?: unknown })?.conversations)
      ? ((json as { conversations: unknown[] }).conversations)
      : null;
  if (!conversations) {
    return { sessions: [], conversationCount: 0, skippedOld: 0, malformed: 1 };
  }

  const cutoffMs = nowMs - maxAgeDays * 24 * 60 * 60 * 1000;
  const sessions: ImportedSession[] = [];
  let skippedOld = 0;
  let malformed = 0;

  for (const raw of conversations) {
    if (typeof raw !== "object" || raw === null) {
      malformed++;
      continue;
    }
    const conversation = raw as Record<string, unknown>;
    const uuid =
      asString(conversation.uuid) ??
      asString(conversation.id) ??
      asString(conversation.conversation_id);
    const rawMessages = Array.isArray(conversation.chat_messages)
      ? conversation.chat_messages
      : Array.isArray(conversation.messages)
        ? conversation.messages
        : null;
    if (!uuid || !rawMessages) {
      malformed++;
      continue;
    }
    const title =
      asString(conversation.name) ?? asString(conversation.title) ?? "untitled";
    const messages = parseMessages(rawMessages);
    if (messages.length === 0) continue;

    let start = 0;
    while (start < messages.length) {
      let end = start;
      while (
        end + 1 < messages.length &&
        messages[end + 1].atMs - messages[end].atMs <= SESSION_GAP_MS
      ) {
        end++;
      }
      const slice = messages.slice(start, end + 1);
      start = end + 1;

      const startMs = slice[0].atMs;
      const endMs = slice[slice.length - 1].atMs;
      if (endMs < cutoffMs) {
        skippedOld++;
        continue;
      }
      const userText = slice
        .filter((message) => message.fromUser)
        .map((message) => message.text)
        .join("\n")
        .slice(0, USER_TEXT_CAP);
      const spanMinutes = Math.round((endMs - startMs) / 60_000);
      sessions.push({
        ref: `${uuid}:${startMs}`,
        title,
        startedAt: new Date(startMs).toISOString(),
        endedAt: new Date(endMs).toISOString(),
        durationMin: Math.min(
          MAX_SESSION_MINUTES,
          Math.max(MIN_SESSION_MINUTES, spanMinutes),
        ),
        userText,
        wordCount: countWordsIn(userText),
      });
    }
  }

  sessions.sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt));
  return {
    sessions,
    conversationCount: conversations.length,
    skippedOld,
    malformed,
  };
}
