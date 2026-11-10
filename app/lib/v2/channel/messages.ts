// Exact copy for every message the channel sends. Pure functions: no I/O, no
// clock, no model call. Copy rules: plain, direct, sentence case, and no em or
// en dash anywhere in the output.

import type { Ask, FeedStatus, Instant, OutgoingMessage } from "../types";

function buttonsFor(ask: Ask | null): OutgoingMessage["buttons"] {
  if (!ask) return [];
  return ask.options.map((option) => ({ label: option.label, askId: ask.id, optionId: option.id }));
}

/** Oldest good run first. A feed that never had one counts as the oldest. */
function silentSince(status: FeedStatus): number {
  if (status.lastGoodAt === null) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(status.lastGoodAt);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

export function feedLine(
  statuses: FeedStatus[],
  labels: Record<string, string>,
  sinceLabel: (at: Instant | null) => string,
): string {
  const down = statuses.filter((s) => s.state !== "alive");
  if (down.length === 0) return "All feeds alive.";
  const worst = down.reduce((a, b) => (silentSince(b) < silentSince(a) ? b : a));
  const label = labels[worst.feed] ?? worst.feed;
  const since = sinceLabel(worst.lastGoodAt);
  if (down.length === 1) return `I can't see ${label} since ${since}.`;
  return `${down.length} feeds are down. Worst: ${label}, since ${since}.`;
}

export function morningMessage(a: {
  firstFixed: { title: string; time: string; leaveBy: string | null } | null;
  top: { title: string; time: string } | null;
  feedLine: string;
  energyAsk: Ask | null;
}): OutgoingMessage {
  const lines: string[] = [];
  if (a.firstFixed) {
    const leave = a.firstFixed.leaveBy ? `, leave by ${a.firstFixed.leaveBy}` : "";
    lines.push(`Morning. First thing: ${a.firstFixed.title} at ${a.firstFixed.time}${leave}.`);
  } else {
    lines.push("Morning. Nothing fixed today.");
  }
  if (a.top) lines.push(`Then: ${a.top.title} at ${a.top.time}.`);
  lines.push(a.energyAsk ? `${a.feedLine} Energy today?` : a.feedLine);
  return { text: lines.join("\n"), buttons: buttonsFor(a.energyAsk) };
}

export function planMessage(a: {
  energyLabel: string;
  assumed: boolean;
  lines: Array<{ time: string; title: string }>;
  startAsk: Ask | null;
}): OutgoingMessage {
  const header = a.assumed ? `${a.energyLabel} day, assumed.` : `${a.energyLabel} day.`;
  const lines = [header, ...a.lines.map((l) => `${l.time} ${l.title}`)];
  return { text: lines.join("\n"), buttons: buttonsFor(a.startAsk) };
}

export function askMessage(ask: Ask): OutgoingMessage {
  return { text: ask.text, buttons: buttonsFor(ask) };
}

export function replanMessage(a: {
  moved: number;
  removed: number;
  next: { title: string; time: string } | null;
}): OutgoingMessage {
  let text = a.next
    ? `Moved ${a.moved}. Next is ${a.next.title} at ${a.next.time}.`
    : `Moved ${a.moved}. Nothing else today.`;
  if (a.removed > 0) text += ` Dropped ${a.removed}.`;
  return { text, buttons: [] };
}

export function alertMessage(a: {
  causeLabel: string;
  affected: number;
  days: number;
  fix: string | null;
}): OutgoingMessage {
  const things = a.affected === 1 ? "1 thing" : `${a.affected} things`;
  let text = `${a.causeLabel}. ${things} affected, day ${a.days + 1}.`;
  if (a.fix) text += `\n${a.fix}`;
  return { text, buttons: [] };
}

export function answeredText(ask: Ask): string {
  const optionId = ask.assumed ? ask.defaultOptionId : ask.answeredOptionId;
  const label = ask.options.find((o) => o.id === optionId)?.label ?? optionId ?? "";
  return ask.assumed ? `No answer, so I went with ${label}.` : `Got it: ${label}.`;
}
