import { describe, expect, it } from "vitest";
import type { OutgoingMessage } from "@/app/lib/v2/types";
import { FakeTelegram } from "@/app/lib/v2/channel/fake-telegram";
import {
  createTelegramClient,
  parseUpdate,
  toSendMessagePayload,
  verifySecret,
} from "@/app/lib/v2/channel/telegram";

describe("toSendMessagePayload", () => {
  it("returns just chat_id and text when there are no buttons", () => {
    expect(toSendMessagePayload("42", { text: "Morning.", buttons: [] })).toEqual({
      chat_id: "42",
      text: "Morning.",
    });
  });

  it("puts the buttons in one inline keyboard row with a:askId:optionId data", () => {
    const msg: OutgoingMessage = {
      text: "Energy today?",
      buttons: [
        { label: "Low", askId: "ask-1", optionId: "low" },
        { label: "Good", askId: "ask-1", optionId: "good" },
      ],
    };
    expect(toSendMessagePayload("42", msg)).toEqual({
      chat_id: "42",
      text: "Energy today?",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Low", callback_data: "a:ask-1:low" },
            { text: "Good", callback_data: "a:ask-1:good" },
          ],
        ],
      },
    });
  });

  it("accepts callback data of exactly 64 bytes", () => {
    const optionId = "x".repeat(64 - "a:".length - "ask:".length);
    const msg: OutgoingMessage = { text: "t", buttons: [{ label: "B", askId: "ask", optionId }] };
    const payload = toSendMessagePayload("1", msg) as {
      reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> };
    };
    expect(Buffer.byteLength(payload.reply_markup.inline_keyboard[0][0].callback_data)).toBe(64);
  });

  it("throws when callback data exceeds 64 bytes", () => {
    const optionId = "x".repeat(64 - "a:".length - "ask:".length + 1);
    const msg: OutgoingMessage = { text: "t", buttons: [{ label: "B", askId: "ask", optionId }] };
    expect(() => toSendMessagePayload("1", msg)).toThrow();
  });

  it("counts bytes, not characters, for the 64 byte limit", () => {
    // 30 two-byte characters are only 30 characters but 60 bytes, so the total passes 64 bytes.
    const msg: OutgoingMessage = {
      text: "t",
      buttons: [{ label: "B", askId: "ask", optionId: "é".repeat(30) }],
    };
    expect(() => toSendMessagePayload("1", msg)).toThrow();
  });
});

describe("parseUpdate", () => {
  it("turns a callback_query with matching data into an answer", () => {
    const update = {
      update_id: 1,
      callback_query: {
        id: "cb-77",
        from: { id: 5 },
        data: "a:ask-1:good",
        message: { message_id: 9, chat: { id: 4242 } },
      },
    };
    expect(parseUpdate(update)).toEqual({
      type: "answer",
      chatId: "4242",
      askId: "ask-1",
      optionId: "good",
      callbackId: "cb-77",
    });
  });

  it("returns null for a callback with unknown data", () => {
    const update = {
      update_id: 1,
      callback_query: { id: "cb-1", data: "z:something", message: { message_id: 9, chat: { id: 4242 } } },
    };
    expect(parseUpdate(update)).toBeNull();
  });

  it("returns null for a callback with no data or no message", () => {
    expect(parseUpdate({ callback_query: { id: "cb-1", message: { message_id: 1, chat: { id: 1 } } } })).toBeNull();
    expect(parseUpdate({ callback_query: { id: "cb-1", data: "a:ask-1:ok" } })).toBeNull();
  });

  it("turns /start into a start with no pairing code", () => {
    expect(parseUpdate({ update_id: 2, message: { message_id: 1, chat: { id: 7 }, text: "/start" } })).toEqual({
      type: "start",
      chatId: "7",
      pairingCode: null,
    });
  });

  it("turns /start <code> into a start with the code", () => {
    expect(
      parseUpdate({ update_id: 2, message: { message_id: 1, chat: { id: 7 }, text: "/start ABC123" } }),
    ).toEqual({ type: "start", chatId: "7", pairingCode: "ABC123" });
  });

  it("does not treat text that merely begins with /start as a start", () => {
    expect(parseUpdate({ message: { message_id: 1, chat: { id: 7 }, text: "/starting soon" } })).toEqual({
      type: "text",
      chatId: "7",
      text: "/starting soon",
    });
  });

  it("turns any other text message into text", () => {
    expect(parseUpdate({ message: { message_id: 1, chat: { id: 7 }, text: "moved the gym to friday" } })).toEqual({
      type: "text",
      chatId: "7",
      text: "moved the gym to friday",
    });
  });

  it("always gives chatId as a string, including negative group ids", () => {
    const out = parseUpdate({ message: { message_id: 1, chat: { id: -1001234567890 }, text: "hi" } });
    expect(out).toEqual({ type: "text", chatId: "-1001234567890", text: "hi" });
  });

  it("returns null for everything else without throwing", () => {
    const bad: unknown[] = [
      null,
      undefined,
      42,
      "text",
      [],
      {},
      { update_id: 1 },
      { message: null },
      { message: { chat: { id: 1 } } },
      { message: { text: "hi" } },
      { message: { chat: { id: {} }, text: "hi" } },
      { message: { chat: { id: 1 }, photo: [] } },
      { edited_message: { chat: { id: 1 }, text: "hi" } },
      { callback_query: "nope" },
      { callback_query: { data: "a:x:y", message: { chat: { id: 1 } } } },
    ];
    for (const input of bad) {
      expect(() => parseUpdate(input)).not.toThrow();
      expect(parseUpdate(input)).toBeNull();
    }
  });
});

describe("verifySecret", () => {
  it("accepts an equal value", () => {
    expect(verifySecret("s3cret-value", "s3cret-value")).toBe(true);
  });

  it("rejects a different value of the same length", () => {
    expect(verifySecret("s3cret-valuf", "s3cret-value")).toBe(false);
  });

  it("rejects a different length", () => {
    expect(verifySecret("s3cret", "s3cret-value")).toBe(false);
    expect(verifySecret("s3cret-value-and-more", "s3cret-value")).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifySecret(null, "s3cret-value")).toBe(false);
    expect(verifySecret("", "s3cret-value")).toBe(false);
  });

  it("rejects everything when the expected value is empty", () => {
    expect(verifySecret("", "")).toBe(false);
    expect(verifySecret(null, "")).toBe(false);
    expect(verifySecret("anything", "")).toBe(false);
  });
});

describe("createTelegramClient", () => {
  const TOKEN = "123456:SECRET-TOKEN-VALUE";

  function recorder(response: { status?: number; body: unknown }) {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(response.body), {
        status: response.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("sendMessage posts the payload as JSON and returns the message id as a string", async () => {
    const { calls, fetchImpl } = recorder({ body: { ok: true, result: { message_id: 321 } } });
    const client = createTelegramClient(TOKEN, fetchImpl);
    const msg: OutgoingMessage = {
      text: "Energy today?",
      buttons: [{ label: "Low", askId: "a1", optionId: "low" }],
    };
    const out = await client.sendMessage("42", msg);
    expect(out).toEqual({ messageId: "321" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(calls[0].init?.method).toBe("POST");
    expect(new Headers(calls[0].init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(toSendMessagePayload("42", msg));
  });

  it("answerCallback calls answerCallbackQuery with the id and text", async () => {
    const { calls, fetchImpl } = recorder({ body: { ok: true, result: true } });
    const client = createTelegramClient(TOKEN, fetchImpl);
    await client.answerCallback("cb-1", "Got it: Good.");
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ callback_query_id: "cb-1", text: "Got it: Good." });
  });

  it("replaceButtons edits the message text and sends no reply markup", async () => {
    const { calls, fetchImpl } = recorder({ body: { ok: true, result: { message_id: 321 } } });
    const client = createTelegramClient(TOKEN, fetchImpl);
    await client.replaceButtons("42", "321", "Got it: Good.");
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/editMessageText`);
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(body).toEqual({ chat_id: "42", message_id: 321, text: "Got it: Good." });
    expect(body).not.toHaveProperty("reply_markup");
  });

  it("throws on a non-ok HTTP response, naming the method and status but not the token", async () => {
    const { fetchImpl } = recorder({ status: 401, body: { ok: false, description: "Unauthorized" } });
    const client = createTelegramClient(TOKEN, fetchImpl);
    const err = await client.sendMessage("42", { text: "x", buttons: [] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("sendMessage");
    expect(message).toContain("401");
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain("SECRET-TOKEN-VALUE");
  });

  it("throws when the body says ok: false even on HTTP 200", async () => {
    const { fetchImpl } = recorder({ status: 200, body: { ok: false, error_code: 400, description: "bad" } });
    const client = createTelegramClient(TOKEN, fetchImpl);
    const err = await client.answerCallback("cb-1", "hi").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("answerCallbackQuery");
    expect((err as Error).message).toContain("200");
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("keeps the token out of the error when the network call itself fails", async () => {
    const fetchImpl = (async (input: unknown) => {
      throw new TypeError(`fetch failed for ${String(input)}`);
    }) as unknown as typeof fetch;
    const client = createTelegramClient(TOKEN, fetchImpl);
    const err = await client.replaceButtons("42", "321", "x").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("editMessageText");
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).not.toContain("SECRET-TOKEN-VALUE");
  });
});

describe("FakeTelegram", () => {
  it("records every call in order and hands out incrementing message ids as strings", async () => {
    const fake = new FakeTelegram();
    const msg: OutgoingMessage = { text: "hello", buttons: [{ label: "Yes", askId: "a1", optionId: "yes" }] };
    const first = await fake.sendMessage("42", msg);
    const second = await fake.sendMessage("43", { text: "again", buttons: [] });
    await fake.answerCallback("cb-1", "Got it: Yes.");
    await fake.replaceButtons("42", first.messageId, "Got it: Yes.");

    expect(typeof first.messageId).toBe("string");
    expect(typeof second.messageId).toBe("string");
    expect(Number(second.messageId)).toBe(Number(first.messageId) + 1);

    expect(fake.sent.map((s) => s.method)).toEqual([
      "sendMessage",
      "sendMessage",
      "answerCallback",
      "replaceButtons",
    ]);
    expect(fake.sent[0]).toMatchObject({ method: "sendMessage", chatId: "42", msg });
    expect(fake.sent[1]).toMatchObject({ method: "sendMessage", chatId: "43" });
    expect(fake.sent[2]).toMatchObject({ method: "answerCallback", callbackId: "cb-1", text: "Got it: Yes." });
    expect(fake.sent[3]).toMatchObject({
      method: "replaceButtons",
      chatId: "42",
      messageId: first.messageId,
      text: "Got it: Yes.",
    });
  });
});
