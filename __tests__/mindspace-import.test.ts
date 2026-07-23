import { describe, expect, it } from "vitest";

import { parseClaudeExport } from "@/app/lib/mindspace/import";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain .mjs module
import { parseTranscript, sessionsFrom } from "../overnight/mindspace-sync.mjs";

const NOW = Date.UTC(2026, 6, 22, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describe("parseClaudeExport", () => {
  function conversation(overrides: Record<string, unknown> = {}) {
    return {
      uuid: "conv-1",
      name: "Emma talk",
      chat_messages: [
        {
          sender: "human",
          text: "long night, need to talk about emma",
          created_at: iso(NOW - 2 * HOUR),
        },
        {
          sender: "assistant",
          text: "i'm here",
          created_at: iso(NOW - 2 * HOUR + 60_000),
        },
        {
          sender: "human",
          text: "she didn't reply",
          created_at: iso(NOW - 2 * HOUR + 120_000),
        },
      ],
      ...overrides,
    };
  }

  it("keeps only the user's words and computes the session span", () => {
    const result = parseClaudeExport([conversation()], NOW);
    expect(result.conversationCount).toBe(1);
    expect(result.sessions).toHaveLength(1);
    const session = result.sessions[0];
    expect(session.ref).toBe(`conv-1:${NOW - 2 * HOUR}`);
    expect(session.userText).toContain("long night");
    expect(session.userText).toContain("she didn't reply");
    expect(session.userText).not.toContain("i'm here");
    expect(session.durationMin).toBe(2);
    expect(session.title).toBe("Emma talk");
  });

  it("splits a conversation into gap-separated sessions", () => {
    const convo = conversation({
      chat_messages: [
        { sender: "human", text: "morning", created_at: iso(NOW - 26 * HOUR) },
        { sender: "human", text: "night", created_at: iso(NOW - 1 * HOUR) },
      ],
    });
    const result = parseClaudeExport([convo], NOW);
    expect(result.sessions).toHaveLength(2);
    expect(new Set(result.sessions.map((s) => s.ref)).size).toBe(2);
  });

  it("skips sessions older than the age cap and counts them", () => {
    const convo = conversation({
      chat_messages: [
        { sender: "human", text: "ancient", created_at: iso(NOW - 90 * DAY) },
        { sender: "human", text: "recent", created_at: iso(NOW - DAY) },
      ],
    });
    const result = parseClaudeExport([convo], NOW, 60);
    expect(result.sessions).toHaveLength(1);
    expect(result.skippedOld).toBe(1);
  });

  it("handles content-block message shapes and wrapper objects", () => {
    const convo = conversation({
      chat_messages: [
        {
          sender: "human",
          content: [{ type: "text", text: "block style message" }],
          created_at: iso(NOW - HOUR),
        },
      ],
    });
    const result = parseClaudeExport({ conversations: [convo] }, NOW);
    expect(result.sessions[0].userText).toBe("block style message");
  });

  it("flags non-export json as malformed", () => {
    expect(parseClaudeExport({ nope: true }, NOW).malformed).toBe(1);
    expect(parseClaudeExport("string", NOW).malformed).toBe(1);
    const result = parseClaudeExport([{ junk: 1 }, conversation()], NOW);
    expect(result.malformed).toBe(1);
    expect(result.sessions).toHaveLength(1);
  });
});

describe("mindspace-sync transcript parsing", () => {
  function line(entry: Record<string, unknown>): string {
    return JSON.stringify(entry);
  }

  it("extracts user text, skips noise, sidechains and tool results", () => {
    const raw = [
      line({
        type: "user",
        timestamp: iso(NOW - HOUR),
        cwd: "C:\\Users\\U\\Documents\\mindboard\\mindboard",
        message: { content: "fix the urgency board" },
      }),
      line({
        type: "user",
        timestamp: iso(NOW - HOUR + 60_000),
        message: { content: "<system-reminder>noise</system-reminder>" },
      }),
      line({
        type: "user",
        timestamp: iso(NOW - HOUR + 90_000),
        isSidechain: true,
        message: { content: "subagent chatter" },
      }),
      line({
        type: "user",
        timestamp: iso(NOW - HOUR + 120_000),
        message: {
          content: [
            { type: "tool_result", content: "big dump" },
            { type: "text", text: "also add tests" },
          ],
        },
      }),
      line({
        type: "assistant",
        timestamp: iso(NOW - HOUR + 300_000),
        message: { content: [{ type: "text", text: "done" }] },
      }),
      "not json at all",
    ].join("\n");

    const { messages, cwd } = parseTranscript(raw);
    expect(cwd).toContain("mindboard");
    const userTexts = messages
      .filter((m: { isUser: boolean; text: string }) => m.isUser && m.text)
      .map((m: { text: string }) => m.text);
    expect(userTexts).toEqual(["fix the urgency board", "also add tests"]);
  });

  it("builds sessions with project-prefixed titles and duration from full span", () => {
    const { messages } = parseTranscript(
      [
        line({
          type: "user",
          timestamp: iso(NOW - 2 * HOUR),
          message: { content: "start the m3 build" },
        }),
        line({
          type: "assistant",
          timestamp: iso(NOW - 2 * HOUR + 30 * 60_000),
          message: { content: [{ type: "text", text: "ok" }] },
        }),
      ].join("\n"),
    );
    const sessions = sessionsFrom("abc123", "mindboard", messages, NOW);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].ref).toBe(`abc123:${NOW - 2 * HOUR}`);
    expect(sessions[0].title).toBe("mindboard: start the m3 build");
    expect(sessions[0].durationMin).toBe(30);
  });

  it("drops sessions with no user text", () => {
    const { messages } = parseTranscript(
      line({
        type: "assistant",
        timestamp: iso(NOW - HOUR),
        message: { content: [{ type: "text", text: "solo" }] },
      }),
    );
    expect(sessionsFrom("abc", null, messages, NOW)).toHaveLength(0);
  });
});
