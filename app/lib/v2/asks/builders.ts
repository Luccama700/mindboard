// Drafts for the two asks the app opens itself. They return an `AskDraft`; the
// caller hands it to `openAsk`, which adds the id and the starting status.

import { zonedIso, zonedWallTimeToUtcMs } from "../../snapshots/zoned-time";
import type { Block, DateKey, Instant, PlannerRules } from "../types";
import type { AskDraft } from "./lifecycle";

/** A block ended and nobody said what happened. */
export function slipAsk(
  block: Block,
  userId: string,
  rules: PlannerRules,
  now: Instant,
): AskDraft {
  const expiresMs = Date.parse(now) + rules.slipDefaultAfterMinutes * 60_000;
  return {
    userId,
    kind: "slip",
    // Shared across blocks of the same task (or kind), so backoff can see repeats.
    topic: block.taskId !== null ? `task:${block.taskId}` : `kind:${block.kind}`,
    text: `Still doing ${block.title}?`,
    options: [
      { id: "did", label: "Did it", effect: { type: "block.done", blockId: block.id, fraction: 1 } },
      {
        id: "later",
        label: "Later today",
        effect: { type: "block.reschedule", blockId: block.id, to: "later-today" },
      },
      {
        id: "tomorrow",
        label: "Tomorrow",
        effect: { type: "block.reschedule", blockId: block.id, to: "tomorrow" },
      },
      { id: "drop", label: "Drop", effect: { type: "block.drop", blockId: block.id } },
    ],
    defaultOptionId: "later",
    timeCritical: true,
    openedAt: now,
    remindAt: null,
    expiresAt: zonedIso(expiresMs, rules.timeZone),
    dedupeKey: `slip:${block.id}`,
  };
}

/** The morning energy question. No answer by noon means "ok". */
export function energyAsk(
  date: DateKey,
  userId: string,
  rules: PlannerRules,
  now: Instant,
): AskDraft {
  const noon = zonedWallTimeToUtcMs(date, 12, 0, rules.timeZone);
  return {
    userId,
    kind: "energy",
    // One topic for every day, so unanswered energy asks add up across the week.
    topic: "energy",
    text: "Energy today?",
    options: [
      { id: "low", label: "Low", effect: { type: "energy.set", date, energy: "low" } },
      { id: "ok", label: "OK", effect: { type: "energy.set", date, energy: "ok" } },
      { id: "good", label: "Good", effect: { type: "energy.set", date, energy: "good" } },
    ],
    defaultOptionId: "ok",
    timeCritical: true,
    openedAt: now,
    remindAt: null,
    expiresAt: zonedIso(noon, rules.timeZone),
    dedupeKey: `energy:${date}`,
  };
}
