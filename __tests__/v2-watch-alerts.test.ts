import { describe, expect, test } from "vitest";

import { planAlerts } from "@/app/lib/v2/watch/alerts";
import type { Alert, AlertAction, FeedStatus } from "@/app/lib/v2/types";

const NOW = "2026-07-08T12:00:00Z";
const NOW_MS = Date.parse(NOW);
const HOUR = 3_600_000;

function ago(hours: number): string {
  return new Date(NOW_MS - hours * HOUR).toISOString();
}

function failing(feed: string, cause = "auth-expired"): FeedStatus {
  return { feed, state: "failing", lastGoodAt: null, cause };
}

function status(feed: string, state: FeedStatus["state"], cause: string | null = null): FeedStatus {
  return { feed, state, lastGoodAt: null, cause };
}

function openAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: "alert-old",
    cause: "auth-expired",
    feeds: ["feed-a"],
    since: ago(1),
    step: 0,
    lastSentAt: ago(1),
    status: "open",
    ...overrides,
  };
}

function counter(prefix = "alert"): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function plan(statuses: FeedStatus[], open: Alert[] = [], newId = counter()): AlertAction[] {
  return planAlerts(statuses, open, NOW, newId);
}

describe("planAlerts: opening", () => {
  test("a new cause opens an alert at step 0 with nothing sent yet", () => {
    const actions = plan([failing("feed-a")]);
    expect(actions).toEqual([
      {
        type: "open",
        alert: {
          id: "alert-1",
          cause: "auth-expired",
          feeds: ["feed-a"],
          since: NOW,
          step: 0,
          lastSentAt: null,
          status: "open",
        },
      },
    ]);
  });

  test("eight feeds with the same error class make one alert", () => {
    const feeds = Array.from({ length: 8 }, (_, i) => `feed-${i + 1}`);
    const actions = plan(feeds.map((f) => failing(f, "auth-expired")));
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("open");
    expect(actions[0].alert.feeds).toEqual(feeds);
  });

  test("different causes open separate alerts, one id each, in order of appearance", () => {
    const actions = plan([
      failing("feed-a", "auth-expired"),
      failing("feed-b", "rate-limited"),
      failing("feed-c", "auth-expired"),
    ]);
    expect(actions.map((a) => a.type)).toEqual(["open", "open"]);
    expect(actions.map((a) => a.alert.id)).toEqual(["alert-1", "alert-2"]);
    expect(actions.map((a) => a.alert.cause)).toEqual(["auth-expired", "rate-limited"]);
    expect(actions[0].alert.feeds).toEqual(["feed-a", "feed-c"]);
    expect(actions[1].alert.feeds).toEqual(["feed-b"]);
  });

  test("alive and late feeds do not open anything", () => {
    expect(plan([status("feed-a", "alive"), status("feed-b", "late", "no-run")])).toEqual([]);
  });

  test("a blind feed opens an alert under its cause", () => {
    const actions = plan([status("feed-a", "blind", "no-run")]);
    expect(actions).toHaveLength(1);
    expect(actions[0].alert.cause).toBe("no-run");
    expect(actions[0].alert.feeds).toEqual(["feed-a"]);
  });

  test("a failing feed with no cause still gets an alert", () => {
    const actions = plan([{ feed: "feed-a", state: "failing", lastGoodAt: null, cause: null }]);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("open");
  });

  test("a closed alert for the same cause does not count as open", () => {
    const actions = plan([failing("feed-a")], [openAlert({ status: "closed" })]);
    expect(actions.map((a) => a.type)).toEqual(["open"]);
  });

  test("ids come from newId only when an alert opens", () => {
    const newId = counter("x");
    plan([failing("feed-a")], [openAlert()], newId);
    expect(newId()).toBe("x-1");
  });
});

describe("planAlerts: one open alert per cause", () => {
  test("a cause that already has an open alert does nothing new", () => {
    expect(plan([failing("feed-a")], [openAlert()])).toEqual([]);
  });

  test("planning twice from the result of the first plan changes nothing", () => {
    const first = plan([failing("feed-a")]);
    const opened = first.map((a) => a.alert);
    expect(plan([failing("feed-a")], opened)).toEqual([]);
  });

  test("a feed joining an open alert is a silent update with the new feed list", () => {
    const alert = openAlert();
    const actions = plan([failing("feed-a"), failing("feed-b")], [alert]);
    expect(actions).toEqual([
      { type: "update", alert: { ...alert, feeds: ["feed-a", "feed-b"] } },
    ]);
  });

  test("a feed leaving an open alert is a silent update", () => {
    const alert = openAlert({ feeds: ["feed-a", "feed-b"] });
    const actions = plan([failing("feed-a")], [alert]);
    expect(actions).toEqual([{ type: "update", alert: { ...alert, feeds: ["feed-a"] } }]);
  });

  test("an update changes nothing but the feed list", () => {
    const alert = openAlert({ step: 1, since: ago(5), lastSentAt: ago(3) });
    const [action] = plan([failing("feed-a"), failing("feed-b")], [alert]);
    expect(action.type).toBe("update");
    expect(action.alert).toEqual({ ...alert, feeds: ["feed-a", "feed-b"] });
  });

  test("the same feeds in a different order are not a change", () => {
    const alert = openAlert({ feeds: ["feed-a", "feed-b"] });
    expect(plan([failing("feed-b"), failing("feed-a")], [alert])).toEqual([]);
  });

  test("planning again from an updated alert changes nothing", () => {
    const first = plan([failing("feed-a"), failing("feed-b")], [openAlert()]);
    expect(plan([failing("feed-a"), failing("feed-b")], [first[0].alert])).toEqual([]);
  });

  test("an escalating alert gets the escalate only, with the new feed list", () => {
    const alert = openAlert({ since: ago(3), feeds: ["feed-a"] });
    const actions = plan([failing("feed-a"), failing("feed-b")], [alert]);
    expect(actions.map((a) => a.type)).toEqual(["escalate"]);
    expect(actions[0].alert.feeds).toEqual(["feed-a", "feed-b"]);
  });

  test("a closing alert gets the close only, never an update", () => {
    const alert = openAlert({ feeds: ["feed-a", "feed-b"] });
    expect(plan([], [alert]).map((a) => a.type)).toEqual(["close"]);
  });

  test("a new cause opens next to an existing one", () => {
    const actions = plan([failing("feed-a"), failing("feed-b", "rate-limited")], [openAlert()]);
    expect(actions.map((a) => [a.type, a.alert.cause])).toEqual([["open", "rate-limited"]]);
  });
});

describe("planAlerts: escalation", () => {
  test("step 0 stays put before 2 hours", () => {
    const alert = openAlert({ since: new Date(NOW_MS - 2 * HOUR + 1000).toISOString() });
    expect(plan([failing("feed-a")], [alert])).toEqual([]);
  });

  test("step 0 goes to 1 after 2 hours open, as one escalate action", () => {
    const alert = openAlert({ since: ago(2), step: 0 });
    const actions = plan([failing("feed-a")], [alert]);
    expect(actions).toEqual([
      { type: "escalate", alert: { ...alert, step: 1, lastSentAt: NOW } },
    ]);
  });

  test("step 1 stays put before 12 hours", () => {
    const alert = openAlert({ since: ago(11.9), step: 1 });
    expect(plan([failing("feed-a")], [alert])).toEqual([]);
  });

  test("step 1 goes to 2 after 12 hours open", () => {
    const alert = openAlert({ since: ago(12), step: 1 });
    const actions = plan([failing("feed-a")], [alert]);
    expect(actions).toEqual([
      { type: "escalate", alert: { ...alert, step: 2, lastSentAt: NOW } },
    ]);
  });

  test("an alert at step 0 open 30 hours goes straight to step 2 in one action", () => {
    const alert = openAlert({ since: ago(30), step: 0 });
    const actions = plan([failing("feed-a")], [alert]);
    expect(actions).toEqual([
      { type: "escalate", alert: { ...alert, step: 2, lastSentAt: NOW } },
    ]);
  });

  test("an alert at step 1 open 30 hours goes to step 2", () => {
    const alert = openAlert({ since: ago(30), step: 1 });
    const actions = plan([failing("feed-a")], [alert]);
    expect(actions.map((a) => [a.type, a.alert.step])).toEqual([["escalate", 2]]);
  });

  test("an alert at step 0 open 5 hours goes to step 1, not further", () => {
    const alert = openAlert({ since: ago(5), step: 0 });
    const actions = plan([failing("feed-a")], [alert]);
    expect(actions.map((a) => [a.type, a.alert.step])).toEqual([["escalate", 1]]);
  });

  test("the step never goes down: a step 1 alert open 1 hour is left alone", () => {
    const alert = openAlert({ since: ago(1), step: 1 });
    expect(plan([failing("feed-a")], [alert])).toEqual([]);
  });

  test("step 2 is the top: nothing more happens", () => {
    const alert = openAlert({ since: ago(100), step: 2 });
    expect(plan([failing("feed-a")], [alert])).toEqual([]);
  });

  test("an escalation carries the current feed list", () => {
    const alert = openAlert({ since: ago(3), feeds: ["feed-a"] });
    const actions = plan([failing("feed-a"), failing("feed-b")], [alert]);
    expect(actions).toHaveLength(1);
    expect(actions[0].alert.feeds).toEqual(["feed-a", "feed-b"]);
    expect(actions[0].alert.since).toBe(alert.since);
    expect(actions[0].alert.id).toBe("alert-old");
  });

  test("a fresh alert is not escalated in the plan that opens it", () => {
    const actions = plan([failing("feed-a")]);
    expect(actions.map((a) => a.type)).toEqual(["open"]);
  });

  test("escalation does not mutate the alert it was given", () => {
    const alert = openAlert({ since: ago(3) });
    plan([failing("feed-a")], [alert]);
    expect(alert.step).toBe(0);
  });
});

describe("planAlerts: closing", () => {
  test("a cause with no failing feed left produces close", () => {
    const alert = openAlert();
    const actions = plan([status("feed-a", "alive")], [alert]);
    expect(actions).toEqual([{ type: "close", alert: { ...alert, status: "closed" } }]);
  });

  test("closing happens when there are no statuses at all", () => {
    const actions = plan([], [openAlert()]);
    expect(actions.map((a) => a.type)).toEqual(["close"]);
  });

  test("a late feed no longer holds an alert open", () => {
    const actions = plan([status("feed-a", "late", "no-run")], [openAlert()]);
    expect(actions.map((a) => a.type)).toEqual(["close"]);
  });

  test("a cause that moved to another cause closes the old alert and opens the new one", () => {
    const actions = plan([failing("feed-a", "rate-limited")], [openAlert()]);
    expect(actions.map((a) => [a.type, a.alert.cause])).toEqual([
      ["open", "rate-limited"],
      ["close", "auth-expired"],
    ]);
  });

  test("only the cause that cleared is closed", () => {
    const keep = openAlert({ id: "alert-keep", cause: "auth-expired" });
    const gone = openAlert({ id: "alert-gone", cause: "rate-limited", feeds: ["feed-b"] });
    const actions = plan([failing("feed-a", "auth-expired")], [keep, gone]);
    expect(actions.map((a) => [a.type, a.alert.id])).toEqual([["close", "alert-gone"]]);
  });

  test("an alert that is already closed is not closed again", () => {
    expect(plan([], [openAlert({ status: "closed" })])).toEqual([]);
  });

  test("close keeps the feed list and history of the alert", () => {
    const alert = openAlert({ step: 2, feeds: ["feed-a", "feed-b"], lastSentAt: ago(1) });
    const [action] = plan([], [alert]);
    expect(action.alert).toEqual({ ...alert, status: "closed" });
  });
});
