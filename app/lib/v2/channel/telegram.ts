// Thin Telegram adapter: builds Bot API payloads from OutgoingMessage, turns
// webhook updates into typed Incoming events, and checks the webhook secret.
// No database, no model call. The bot token never appears in an error message.

import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Incoming, OutgoingMessage } from "../types";

export interface TelegramClient {
  sendMessage(chatId: string, msg: OutgoingMessage): Promise<{ messageId: string }>;
  answerCallback(callbackId: string, text: string): Promise<void>;
  replaceButtons(chatId: string, messageId: string, text: string): Promise<void>;
}

const CALLBACK_DATA_MAX_BYTES = 64;

/** A request that has not answered by then is given up on. */
export const TELEGRAM_TIMEOUT_MS = 10_000;

/**
 * What a Bot API call failed with, in the two fields the engine classifies on:
 * the method and the HTTP status (null when the request never got a response).
 * The token is not a field and never appears in the message.
 */
export class TelegramError extends Error {
  readonly method: string;
  readonly status: number | null;

  constructor(method: string, status: number | null) {
    super(
      status === null
        ? `Telegram ${method} request failed before a response`
        : `Telegram ${method} failed with HTTP ${status}`,
    );
    this.name = "TelegramError";
    this.method = method;
    this.status = status;
  }
}

export function toSendMessagePayload(chatId: string, msg: OutgoingMessage): Record<string, unknown> {
  const payload: Record<string, unknown> = { chat_id: chatId, text: msg.text };
  if (msg.buttons.length > 0) {
    const row = msg.buttons.map((button) => {
      // CALLBACK_DATA splits on the LAST colon, so an option id carrying one
      // would come back as part of the ask id and answer nothing. Refused here,
      // where it is a programming error, rather than silently at the tap.
      if (button.optionId.includes(":")) {
        throw new Error(`Option id must not contain a colon: ${button.optionId}`);
      }
      const callbackData = `a:${button.askId}:${button.optionId}`;
      if (Buffer.byteLength(callbackData, "utf8") > CALLBACK_DATA_MAX_BYTES) {
        throw new Error(`Callback data is over ${CALLBACK_DATA_MAX_BYTES} bytes for ask ${button.askId}`);
      }
      return { text: button.label, callback_data: callbackData };
    });
    payload.reply_markup = { inline_keyboard: [row] };
  }
  return payload;
}

// ---------------------------------------------------------------- incoming

const chatIdSchema = z.union([z.number(), z.string().min(1)]).transform((id) => String(id));

const updateSchema = z.object({
  message: z
    .object({
      chat: z.object({ id: chatIdSchema }),
      text: z.string().optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string().min(1),
      data: z.string().optional(),
      message: z.object({ chat: z.object({ id: chatIdSchema }) }).optional(),
    })
    .optional(),
});

const CALLBACK_DATA = /^a:(.+):([^:]+)$/;
const START_COMMAND = /^\/start(?:@\S+)?(?:\s+(\S.*))?$/;

export function parseUpdate(update: unknown): Incoming | null {
  const parsed = updateSchema.safeParse(update);
  if (!parsed.success) return null;
  const { message, callback_query: callback } = parsed.data;

  if (callback) {
    const match = callback.data !== undefined ? CALLBACK_DATA.exec(callback.data) : null;
    if (!match || !callback.message) return null;
    return {
      type: "answer",
      chatId: callback.message.chat.id,
      askId: match[1],
      optionId: match[2],
      callbackId: callback.id,
    };
  }

  if (message && message.text !== undefined) {
    const chatId = message.chat.id;
    const start = START_COMMAND.exec(message.text);
    if (start) return { type: "start", chatId, pairingCode: start[1]?.trim() || null };
    return { type: "text", chatId, text: message.text };
  }

  return null;
}

// ---------------------------------------------------------------- secret

export function verifySecret(headerValue: string | null, expected: string): boolean {
  if (!headerValue || !expected) return false;
  const given = Buffer.from(headerValue, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (given.length !== wanted.length) return false;
  return timingSafeEqual(given, wanted);
}

// ---------------------------------------------------------------- client

export function createTelegramClient(token: string, fetchImpl: typeof fetch = fetch): TelegramClient {
  async function call(method: string, body: Record<string, unknown>): Promise<unknown> {
    // An explicit controller rather than AbortSignal.timeout: the tick runs
    // inside a 60 second function, so a channel that never answers must not be
    // what spends it, and a plain timer is the one shape a test can advance.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      // The underlying error can echo the request URL, which contains the token.
      throw new TelegramError(method, null);
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    const ok = typeof parsed === "object" && parsed !== null && (parsed as { ok?: unknown }).ok === true;
    if (!response.ok || !ok) {
      throw new TelegramError(method, response.status);
    }
    return (parsed as { result?: unknown }).result;
  }

  return {
    async sendMessage(chatId, msg) {
      const result = await call("sendMessage", toSendMessagePayload(chatId, msg));
      const messageId = (result as { message_id?: unknown } | null | undefined)?.message_id;
      if (typeof messageId !== "number" && typeof messageId !== "string") {
        throw new Error("Telegram sendMessage returned no message id");
      }
      return { messageId: String(messageId) };
    },
    async answerCallback(callbackId, text) {
      await call("answerCallbackQuery", { callback_query_id: callbackId, text });
    },
    async replaceButtons(chatId, messageId, text) {
      const numeric = Number(messageId);
      await call("editMessageText", {
        chat_id: chatId,
        message_id: Number.isSafeInteger(numeric) ? numeric : messageId,
        text,
      });
    },
  };
}
