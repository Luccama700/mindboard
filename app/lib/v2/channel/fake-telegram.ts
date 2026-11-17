// In-memory TelegramClient for tests. Records every call, in order.

import type { OutgoingMessage } from "../types";
import type { TelegramClient } from "./telegram";

export type FakeTelegramCall =
  | { method: "sendMessage"; chatId: string; msg: OutgoingMessage; messageId: string }
  | { method: "answerCallback"; chatId: null; callbackId: string; text: string }
  | { method: "replaceButtons"; chatId: string; messageId: string; text: string };

export class FakeTelegram implements TelegramClient {
  readonly sent: FakeTelegramCall[] = [];
  private nextMessageId = 1;

  async sendMessage(chatId: string, msg: OutgoingMessage): Promise<{ messageId: string }> {
    const messageId = String(this.nextMessageId++);
    this.sent.push({ method: "sendMessage", chatId, msg, messageId });
    return { messageId };
  }

  async answerCallback(callbackId: string, text: string): Promise<void> {
    this.sent.push({ method: "answerCallback", chatId: null, callbackId, text });
  }

  async replaceButtons(chatId: string, messageId: string, text: string): Promise<void> {
    this.sent.push({ method: "replaceButtons", chatId, messageId, text });
  }
}
