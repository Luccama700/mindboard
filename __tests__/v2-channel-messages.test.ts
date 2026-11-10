import { describe, expect, it } from "vitest";
import type { Ask, FeedStatus, OutgoingMessage } from "@/app/lib/v2/types";
import {
  alertMessage,
  answeredText,
  askMessage,
  feedLine,
  morningMessage,
  planMessage,
  replanMessage,
} from "@/app/lib/v2/channel/messages";

function makeAsk(over: Partial<Ask> = {}): Ask {
  return {
    id: "ask-1",
    userId: "user-1",
    kind: "energy",
    topic: "energy:2030-01-15",
    text: "How is your energy?",
    options: [
      { id: "low", label: "Low", effect: { type: "energy.set", date: "2030-01-15", energy: "low" } },
      { id: "ok", label: "Fine", effect: { type: "energy.set", date: "2030-01-15", energy: "ok" } },
      { id: "good", label: "Good", effect: { type: "energy.set", date: "2030-01-15", energy: "good" } },
    ],
    defaultOptionId: "ok",
    timeCritical: false,
    openedAt: "2030-01-15T08:00:00Z",
    remindAt: null,
    remindedAt: null,
    expiresAt: "2030-01-15T10:00:00Z",
    status: "open",
    answeredOptionId: null,
    answeredAt: null,
    assumed: false,
    dedupeKey: "energy:2030-01-15",
    ...over,
  };
}

const labels: Record<string, string> = {
  cal: "the calendar",
  mail: "the inbox",
  tasks: "the task list",
};
const sinceLabel = (at: string | null) => (at === null ? "never" : `${at.slice(11, 16)} yesterday`);

function status(feed: string, state: FeedStatus["state"], lastGoodAt: string | null): FeedStatus {
  return { feed, state, lastGoodAt, cause: state === "alive" ? null : "no-run" };
}

describe("feedLine", () => {
  it("says all feeds are alive when none is down", () => {
    const line = feedLine(
      [status("cal", "alive", "2030-01-15T07:00:00Z"), status("mail", "alive", null)],
      labels,
      sinceLabel,
    );
    expect(line).toBe("All feeds alive.");
  });

  it("names the one feed that is not alive and how long it has been gone", () => {
    const line = feedLine(
      [status("cal", "alive", "2030-01-15T07:00:00Z"), status("mail", "failing", "2030-01-14T21:30:00Z")],
      labels,
      sinceLabel,
    );
    expect(line).toBe("I can't see the inbox since 21:30 yesterday.");
  });

  it("counts several down feeds and names the one that has been silent longest", () => {
    const line = feedLine(
      [
        status("cal", "late", "2030-01-15T05:00:00Z"),
        status("mail", "blind", "2030-01-14T21:30:00Z"),
        status("tasks", "failing", "2030-01-15T06:00:00Z"),
      ],
      labels,
      sinceLabel,
    );
    expect(line).toBe("3 feeds are down. Worst: the inbox, since 21:30 yesterday.");
  });

  it("treats a feed that never had a good run as the worst", () => {
    const line = feedLine(
      [status("cal", "late", "2030-01-15T05:00:00Z"), status("tasks", "blind", null)],
      labels,
      sinceLabel,
    );
    expect(line).toBe("2 feeds are down. Worst: the task list, since never.");
  });

  it("falls back to the feed id when there is no label", () => {
    const line = feedLine([status("unknown-feed", "failing", null)], labels, sinceLabel);
    expect(line).toBe("I can't see unknown-feed since never.");
  });
});

describe("morningMessage", () => {
  const base = {
    firstFixed: { title: "Dentist", time: "09:30", leaveBy: "09:00" as string | null },
    top: { title: "Essay draft", time: "11:00" } as { title: string; time: string } | null,
    feedLine: "All feeds alive.",
    energyAsk: null as Ask | null,
  };

  it("opens with the greeting and first thing, then the top block, then the feed line", () => {
    const msg = morningMessage(base);
    expect(msg.text).toBe(
      [
        "Morning. First thing: Dentist at 09:30, leave by 09:00.",
        "Then: Essay draft at 11:00.",
        "All feeds alive.",
      ].join("\n"),
    );
    expect(msg.buttons).toEqual([]);
  });

  it("drops the leave-by clause when there is none", () => {
    const msg = morningMessage({ ...base, firstFixed: { title: "Dentist", time: "09:30", leaveBy: null } });
    expect(msg.text.split("\n")[0]).toBe("Morning. First thing: Dentist at 09:30.");
  });

  it("says nothing is fixed when there is no fixed event", () => {
    const msg = morningMessage({ ...base, firstFixed: null });
    expect(msg.text).toBe(
      ["Morning. Nothing fixed today.", "Then: Essay draft at 11:00.", "All feeds alive."].join("\n"),
    );
  });

  it("is two lines when there is no top block", () => {
    const msg = morningMessage({ ...base, top: null });
    expect(msg.text).toBe(["Morning. First thing: Dentist at 09:30, leave by 09:00.", "All feeds alive."].join("\n"));
  });

  it("is two lines with no fixed event and no top block", () => {
    const msg = morningMessage({ ...base, firstFixed: null, top: null });
    expect(msg.text).toBe(["Morning. Nothing fixed today.", "All feeds alive."].join("\n"));
  });

  it("appends the energy question to the feed line and carries the ask's options as buttons", () => {
    const msg = morningMessage({ ...base, energyAsk: makeAsk() });
    expect(msg.text).toBe(
      [
        "Morning. First thing: Dentist at 09:30, leave by 09:00.",
        "Then: Essay draft at 11:00.",
        "All feeds alive. Energy today?",
      ].join("\n"),
    );
    expect(msg.buttons).toEqual([
      { label: "Low", askId: "ask-1", optionId: "low" },
      { label: "Fine", askId: "ask-1", optionId: "ok" },
      { label: "Good", askId: "ask-1", optionId: "good" },
    ]);
  });

  it("puts the energy question after a feed warning, with no top block", () => {
    const msg = morningMessage({
      ...base,
      top: null,
      feedLine: "I can't see the inbox since 21:30 yesterday.",
      energyAsk: makeAsk(),
    });
    expect(msg.text).toBe(
      [
        "Morning. First thing: Dentist at 09:30, leave by 09:00.",
        "I can't see the inbox since 21:30 yesterday. Energy today?",
      ].join("\n"),
    );
  });

  it("never exceeds three lines for any combination", () => {
    for (const firstFixed of [base.firstFixed, { ...base.firstFixed, leaveBy: null }, null]) {
      for (const top of [base.top, null]) {
        for (const energyAsk of [makeAsk(), null]) {
          const text = morningMessage({ ...base, firstFixed, top, energyAsk }).text;
          expect(text.split("\n").length).toBeLessThanOrEqual(3);
        }
      }
    }
  });
});

describe("planMessage", () => {
  const lines = [
    { time: "09:00", title: "Read chapter" },
    { time: "13:00", title: "Problem set" },
  ];

  it("opens with the energy label and lists one line per entry", () => {
    const msg = planMessage({ energyLabel: "Good", assumed: false, lines, startAsk: null });
    expect(msg.text).toBe(["Good day.", "09:00 Read chapter", "13:00 Problem set"].join("\n"));
    expect(msg.buttons).toEqual([]);
  });

  it("says when the energy level was assumed", () => {
    const msg = planMessage({ energyLabel: "Ok", assumed: true, lines, startAsk: null });
    expect(msg.text.split("\n")[0]).toBe("Ok day, assumed.");
  });

  it("uses the start ask's options as buttons", () => {
    const ask = makeAsk({
      id: "ask-9",
      options: [
        { id: "go", label: "Starting", effect: { type: "none" } },
        { id: "later", label: "Later", effect: { type: "block.reschedule", blockId: "b1", to: "later-today" } },
      ],
    });
    const msg = planMessage({ energyLabel: "Low", assumed: false, lines, startAsk: ask });
    expect(msg.buttons).toEqual([
      { label: "Starting", askId: "ask-9", optionId: "go" },
      { label: "Later", askId: "ask-9", optionId: "later" },
    ]);
  });
});

describe("replanMessage", () => {
  it("reports moves and the next block", () => {
    const msg = replanMessage({ moved: 3, removed: 0, next: { title: "Lab report", time: "14:00" } });
    expect(msg).toEqual({ text: "Moved 3. Next is Lab report at 14:00.", buttons: [] });
  });

  it("appends the dropped count when something was removed", () => {
    const msg = replanMessage({ moved: 2, removed: 1, next: { title: "Lab report", time: "14:00" } });
    expect(msg.text).toBe("Moved 2. Next is Lab report at 14:00. Dropped 1.");
  });

  it("says nothing else is left today when there is no next block", () => {
    expect(replanMessage({ moved: 1, removed: 0, next: null }).text).toBe("Moved 1. Nothing else today.");
    expect(replanMessage({ moved: 1, removed: 2, next: null }).text).toBe("Moved 1. Nothing else today. Dropped 2.");
  });
});

describe("alertMessage", () => {
  it("states the cause, the count and the day, then the fix on its own line", () => {
    const msg = alertMessage({
      causeLabel: "Calendar sign-in expired",
      affected: 4,
      days: 1,
      fix: "Sign in again from settings.",
    });
    expect(msg).toEqual({
      text: "Calendar sign-in expired. 4 things affected, day 2.\nSign in again from settings.",
      buttons: [],
    });
  });

  it("omits the fix line when there is none", () => {
    const msg = alertMessage({ causeLabel: "Calendar sign-in expired", affected: 4, days: 0, fix: null });
    expect(msg.text).toBe("Calendar sign-in expired. 4 things affected, day 1.");
  });

  it("reads 1 thing affected for a single item", () => {
    const msg = alertMessage({ causeLabel: "Mail is down", affected: 1, days: 2, fix: null });
    expect(msg.text).toBe("Mail is down. 1 thing affected, day 3.");
  });
});

describe("askMessage", () => {
  it("uses the ask text and its options in order", () => {
    const msg = askMessage(makeAsk({ text: "Did you finish the reading block?" }));
    expect(msg.text).toBe("Did you finish the reading block?");
    expect(msg.buttons.map((b) => b.optionId)).toEqual(["low", "ok", "good"]);
    expect(msg.buttons.map((b) => b.label)).toEqual(["Low", "Fine", "Good"]);
    expect(msg.buttons.every((b) => b.askId === "ask-1")).toBe(true);
  });
});

describe("answeredText", () => {
  it("confirms the chosen option for an answered ask", () => {
    const ask = makeAsk({ status: "answered", answeredOptionId: "good", assumed: false });
    expect(answeredText(ask)).toBe("Got it: Good.");
  });

  it("names the default option for an assumed ask", () => {
    const ask = makeAsk({ status: "expired", answeredOptionId: "ok", defaultOptionId: "ok", assumed: true });
    expect(answeredText(ask)).toBe("No answer, so I went with Fine.");
  });

  it("uses the default option's label even when answeredOptionId is empty", () => {
    const ask = makeAsk({ status: "expired", answeredOptionId: null, defaultOptionId: "low", assumed: true });
    expect(answeredText(ask)).toBe("No answer, so I went with Low.");
  });
});

describe("no dashes in user-facing copy", () => {
  it("never emits an em dash or en dash for any fixture", () => {
    const ask = makeAsk();
    const outputs: Array<string | OutgoingMessage> = [
      feedLine([], labels, sinceLabel),
      feedLine([status("cal", "alive", null)], labels, sinceLabel),
      feedLine([status("mail", "failing", "2030-01-14T21:30:00Z")], labels, sinceLabel),
      feedLine([status("mail", "failing", null), status("cal", "late", null)], labels, sinceLabel),
      morningMessage({
        firstFixed: { title: "Dentist", time: "09:30", leaveBy: "09:00" },
        top: { title: "Essay", time: "11:00" },
        feedLine: "All feeds alive.",
        energyAsk: ask,
      }),
      morningMessage({ firstFixed: null, top: null, feedLine: "All feeds alive.", energyAsk: null }),
      planMessage({ energyLabel: "Ok", assumed: true, lines: [{ time: "09:00", title: "Read" }], startAsk: ask }),
      planMessage({ energyLabel: "Good", assumed: false, lines: [], startAsk: null }),
      askMessage(ask),
      replanMessage({ moved: 2, removed: 1, next: { title: "Lab", time: "14:00" } }),
      replanMessage({ moved: 0, removed: 0, next: null }),
      alertMessage({ causeLabel: "Calendar sign-in expired", affected: 1, days: 0, fix: "Sign in again." }),
      alertMessage({ causeLabel: "Calendar sign-in expired", affected: 5, days: 3, fix: null }),
      answeredText(makeAsk({ status: "answered", answeredOptionId: "ok" })),
      answeredText(makeAsk({ status: "expired", assumed: true })),
    ];
    for (const out of outputs) {
      const text = typeof out === "string" ? out : out.text;
      expect(text).not.toMatch(/[—–]/);
    }
  });
});
