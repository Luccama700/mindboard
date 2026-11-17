import { describe, expect, test } from "vitest";

import {
  UnknownOptionError,
  answerAsk,
  dueReminders,
  expireDue,
  markReminded,
  openAsk,
  type AskDraft,
} from "@/app/lib/v2/asks/lifecycle";
import type { Ask } from "@/app/lib/v2/types";

function draft(overrides: Partial<AskDraft> = {}): AskDraft {
  return {
    userId: "user-1",
    kind: "slip",
    topic: "block:b1",
    text: "Still doing the thing?",
    options: [
      { id: "did", label: "Did it", effect: { type: "block.done", blockId: "b1", fraction: 1 } },
      {
        id: "later",
        label: "Later today",
        effect: { type: "block.reschedule", blockId: "b1", to: "later-today" },
      },
      { id: "drop", label: "Drop", effect: { type: "block.drop", blockId: "b1" } },
    ],
    defaultOptionId: "later",
    timeCritical: true,
    openedAt: "2026-07-08T10:00:00Z",
    remindAt: null,
    expiresAt: "2026-07-08T10:30:00Z",
    dedupeKey: "slip:b1",
    ...overrides,
  };
}

function ask(overrides: Partial<Ask> = {}): Ask {
  return {
    ...draft(),
    id: "ask-1",
    status: "open",
    answeredOptionId: null,
    answeredAt: null,
    assumed: false,
    remindedAt: null,
    ...overrides,
  };
}

function counter(prefix = "id"): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

describe("openAsk", () => {
  test("opens a fresh ask with the id from newId and the starting fields", () => {
    const { ask: opened, created } = openAsk(draft(), [], counter("ask"));
    expect(created).toBe(true);
    expect(opened).toEqual({
      ...draft(),
      id: "ask-1",
      status: "open",
      answeredOptionId: null,
      answeredAt: null,
      assumed: false,
      remindedAt: null,
    });
  });

  test("an open ask with the same dedupe key is returned unchanged", () => {
    const existing = ask({ id: "ask-old", text: "older wording" });
    const newId = counter("ask");
    const result = openAsk(draft(), [existing], newId);
    expect(result.created).toBe(false);
    expect(result.ask).toBe(existing);
    // A duplicate must not burn an id.
    expect(newId()).toBe("ask-1");
  });

  test("an answered ask with the same dedupe key does not block a new one", () => {
    const answered = ask({ id: "ask-old", status: "answered", answeredOptionId: "did" });
    const result = openAsk(draft(), [answered], counter("ask"));
    expect(result.created).toBe(true);
    expect(result.ask.id).toBe("ask-1");
  });

  test("a different dedupe key opens a separate ask", () => {
    const other = ask({ id: "ask-old", dedupeKey: "slip:b2" });
    const result = openAsk(draft(), [other], counter("ask"));
    expect(result.created).toBe(true);
  });
});

describe("answerAsk", () => {
  test("answering an open ask records the option and time and returns its effect", () => {
    const result = answerAsk(ask(), "did", "2026-07-08T10:05:00Z");
    expect(result.changed).toBe(true);
    expect(result.effect).toEqual({ type: "block.done", blockId: "b1", fraction: 1 });
    expect(result.ask.status).toBe("answered");
    expect(result.ask.answeredOptionId).toBe("did");
    expect(result.ask.answeredAt).toBe("2026-07-08T10:05:00Z");
    expect(result.ask.assumed).toBe(false);
  });

  test("answering twice changes nothing the second time", () => {
    const first = answerAsk(ask(), "did", "2026-07-08T10:05:00Z");
    const second = answerAsk(first.ask, "drop", "2026-07-08T10:09:00Z");
    expect(second.changed).toBe(false);
    expect(second.effect).toEqual({ type: "none" });
    expect(second.ask).toBe(first.ask);
    expect(second.ask.answeredOptionId).toBe("did");
    expect(second.ask.answeredAt).toBe("2026-07-08T10:05:00Z");
  });

  test("an ask that expired is not changed by a late answer", () => {
    const expired = ask({ status: "expired", assumed: true });
    const result = answerAsk(expired, "did", "2026-07-08T11:00:00Z");
    expect(result.changed).toBe(false);
    expect(result.effect).toEqual({ type: "none" });
    expect(result.ask).toBe(expired);
  });

  test("an unknown option throws", () => {
    expect(() => answerAsk(ask(), "nope", "2026-07-08T10:05:00Z")).toThrow(UnknownOptionError);
  });

  test("an unknown option does not touch the original ask", () => {
    const original = ask();
    expect(() => answerAsk(original, "nope", "2026-07-08T10:05:00Z")).toThrow();
    expect(original.status).toBe("open");
  });

  test("UnknownOptionError is an Error with a useful name", () => {
    const error = new UnknownOptionError("nope");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("UnknownOptionError");
    expect(error.message).toContain("nope");
  });
});

describe("reminders", () => {
  const withReminder = ask({ remindAt: "2026-07-08T10:15:00Z" });

  test("a reminder is not due before its time", () => {
    expect(dueReminders([withReminder], "2026-07-08T10:14:59Z")).toEqual([]);
  });

  test("a reminder is due once and never again", () => {
    const now = "2026-07-08T10:16:00Z";
    const due = dueReminders([withReminder], now);
    expect(due).toEqual([withReminder]);

    const reminded = markReminded(due[0], now);
    expect(reminded.remindedAt).toBe(now);
    expect(dueReminders([reminded], "2026-07-08T10:20:00Z")).toEqual([]);
    expect(dueReminders([reminded], "2026-07-08T23:00:00Z")).toEqual([]);
  });

  test("markReminded keeps the first reminder time if called again", () => {
    const once = markReminded(withReminder, "2026-07-08T10:16:00Z");
    const twice = markReminded(once, "2026-07-08T10:25:00Z");
    expect(twice.remindedAt).toBe("2026-07-08T10:16:00Z");
  });

  test("an ask with no reminder is never due", () => {
    expect(dueReminders([ask({ remindAt: null })], "2026-07-09T00:00:00Z")).toEqual([]);
  });

  test("answered, expired and cancelled asks are not reminded", () => {
    const now = "2026-07-08T10:20:00Z";
    const rest = (status: Ask["status"]) => ask({ id: status, status, remindAt: "2026-07-08T10:15:00Z" });
    expect(dueReminders([rest("answered"), rest("expired"), rest("cancelled")], now)).toEqual([]);
  });

  test("an ask already past its expiry is not reminded", () => {
    const late = ask({ remindAt: "2026-07-08T10:15:00Z", expiresAt: "2026-07-08T10:30:00Z" });
    expect(dueReminders([late], "2026-07-08T10:31:00Z")).toEqual([]);
  });

  test("markReminded does not mutate its input", () => {
    markReminded(withReminder, "2026-07-08T10:16:00Z");
    expect(withReminder.remindedAt).toBeNull();
  });
});

describe("expireDue", () => {
  test("an expired ask applies its default and is marked assumed", () => {
    const result = expireDue([ask()], "2026-07-08T10:30:00Z");
    expect(result).toHaveLength(1);
    expect(result[0].ask.status).toBe("expired");
    expect(result[0].ask.assumed).toBe(true);
    expect(result[0].effect).toEqual({
      type: "block.reschedule",
      blockId: "b1",
      to: "later-today",
    });
  });

  test("an ask that is not due yet is left alone", () => {
    expect(expireDue([ask()], "2026-07-08T10:29:59Z")).toEqual([]);
  });

  test("only open asks expire", () => {
    const rest = (status: Ask["status"]) => ask({ id: status, status });
    expect(
      expireDue([rest("answered"), rest("expired"), rest("cancelled")], "2026-07-09T00:00:00Z"),
    ).toEqual([]);
  });

  test("each ask uses its own default, in input order", () => {
    const a = ask({ id: "a" });
    const b = ask({ id: "b", defaultOptionId: "drop" });
    const result = expireDue([a, b], "2026-07-08T11:00:00Z");
    expect(result.map((r) => r.ask.id)).toEqual(["a", "b"]);
    expect(result[1].effect).toEqual({ type: "block.drop", blockId: "b1" });
  });

  test("a missing default option still expires, as assumed, with effect none", () => {
    const broken = ask({ defaultOptionId: "ghost" });
    const result = expireDue([broken], "2026-07-08T11:00:00Z");
    expect(result).toHaveLength(1);
    expect(result[0].ask.status).toBe("expired");
    expect(result[0].ask.assumed).toBe(true);
    expect(result[0].effect).toEqual({ type: "none" });
  });

  test("one bad row does not stop the rest of the sweep", () => {
    const broken = ask({ id: "bad", defaultOptionId: "ghost" });
    const fine = ask({ id: "fine" });
    expect(() => expireDue([broken, fine], "2026-07-08T11:00:00Z")).not.toThrow();
    const result = expireDue([broken, fine], "2026-07-08T11:00:00Z");
    expect(result.map((r) => r.ask.id)).toEqual(["bad", "fine"]);
    expect(result[1].effect).toEqual({
      type: "block.reschedule",
      blockId: "b1",
      to: "later-today",
    });
  });

  test("an ask with no options at all still expires", () => {
    const empty = ask({ options: [] });
    expect(expireDue([empty], "2026-07-08T11:00:00Z")[0].effect).toEqual({ type: "none" });
  });

  test("expiring does not mutate its input", () => {
    const original = ask();
    expireDue([original], "2026-07-08T11:00:00Z");
    expect(original.status).toBe("open");
    expect(original.assumed).toBe(false);
  });
});
