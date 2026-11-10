// Lifecycle of an ask: open it once, answer it once, remind once, expire to the
// default. Pure functions over plain values. No clock, no ids, no storage: time
// and ids always arrive as arguments.

import type { Ask, AskEffect, Instant } from "../types";

export type AskDraft = Omit<
  Ask,
  "id" | "status" | "answeredOptionId" | "answeredAt" | "assumed" | "remindedAt"
>;

export class UnknownOptionError extends Error {
  constructor(optionId: string) {
    super(`Unknown ask option: ${optionId}`);
    this.name = "UnknownOptionError";
  }
}

function effectOf(ask: Ask, optionId: string): AskEffect {
  const option = ask.options.find((o) => o.id === optionId);
  if (!option) throw new UnknownOptionError(optionId);
  return option.effect;
}

/**
 * Opens an ask. An open ask with the same dedupe key is the same ask, so it is
 * returned unchanged and `newId` is not called.
 */
export function openAsk(
  draft: AskDraft,
  open: Ask[],
  newId: () => string,
): { ask: Ask; created: boolean } {
  const existing = open.find((a) => a.status === "open" && a.dedupeKey === draft.dedupeKey);
  if (existing) return { ask: existing, created: false };
  return {
    ask: {
      ...draft,
      id: newId(),
      status: "open",
      answeredOptionId: null,
      answeredAt: null,
      assumed: false,
      remindedAt: null,
    },
    created: true,
  };
}

/**
 * Answers an ask once. An ask that is no longer open comes back as it is, with
 * `changed: false` and no effect, so a double tap or a late answer is harmless.
 * An option the ask does not have throws `UnknownOptionError`.
 */
export function answerAsk(
  ask: Ask,
  optionId: string,
  at: Instant,
): { ask: Ask; changed: boolean; effect: AskEffect } {
  if (ask.status !== "open") return { ask, changed: false, effect: { type: "none" } };
  const effect = effectOf(ask, optionId);
  return {
    ask: { ...ask, status: "answered", answeredOptionId: optionId, answeredAt: at },
    changed: true,
    effect,
  };
}

/**
 * Open asks whose one reminder is due. An ask that has been reminded, or that is
 * already past its expiry (the sweep will default it), is not due.
 */
export function dueReminders(asks: Ask[], now: Instant): Ask[] {
  const nowMs = Date.parse(now);
  return asks.filter(
    (ask) =>
      ask.status === "open" &&
      ask.remindAt !== null &&
      ask.remindedAt === null &&
      Date.parse(ask.remindAt) <= nowMs &&
      nowMs < Date.parse(ask.expiresAt),
  );
}

/** Records the reminder. A second call keeps the first reminder time. */
export function markReminded(ask: Ask, at: Instant): Ask {
  if (ask.remindedAt !== null) return ask;
  return { ...ask, remindedAt: at };
}

/**
 * Open asks whose expiry has passed, each with the effect of its default option.
 * The ask is marked `expired` and `assumed`; nobody answered, so the answer
 * fields stay empty. Never throws: an ask whose default is not one of its
 * options still expires, with effect `none`, so one bad row cannot stop an
 * unattended sweep.
 */
export function expireDue(
  asks: Ask[],
  now: Instant,
): Array<{ ask: Ask; effect: AskEffect }> {
  const nowMs = Date.parse(now);
  const result: Array<{ ask: Ask; effect: AskEffect }> = [];
  for (const ask of asks) {
    if (ask.status !== "open" || Date.parse(ask.expiresAt) > nowMs) continue;
    result.push({
      ask: { ...ask, status: "expired", assumed: true },
      effect: ask.options.find((o) => o.id === ask.defaultOptionId)?.effect ?? { type: "none" },
    });
  }
  return result;
}
