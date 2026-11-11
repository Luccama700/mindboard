// PLAN-DESK Task 7: the five Money panes.
//
// THE RULE ABOVE EVERY OTHER ON THIS SCREEN: it admits when it is guessing. A
// pane whose ledger stopped weeks ago leads with how old its numbers are, before
// any number, and draws every number under that line in the quieter ink. Most
// of what is pinned here is that hierarchy, in the markup and in the sheet.
//
// WHAT IS NOT PINNED HERE. How a pane LOOKS at 240, 464 and 1300 px: jsdom lays
// nothing out. The container thresholds are read off money.css as text, and
// what they draw is the controller's capture.
//
// EVERYTHING HERE IS INVENTED: the sample desk's money, and the hand made
// variants below (a forecast under zero, one that stops short, a long ledger,
// accounts in two currencies). No figure describes anybody.
//
// JSX would need a .tsx file, hence createElement, as in the other v2 tests.

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createElement,
  type Attributes,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";

import postcss, { type AtRule, type Rule } from "postcss";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { sampleDesk } from "@/app/lib/v2/fixtures/sample-desk";
import { sampleMoneyStale } from "@/app/lib/v2/fixtures/sample-money";
import { shiftDateKey } from "@/app/lib/v2/plan/day";
import { planDay } from "@/app/lib/v2/plan/planner";
import type { PlanInput } from "@/app/lib/v2/types";
import { DESK_COPY } from "@/app/lib/v2/view/desk";
import type { DeskScreenData, MoneyRow, MoneyScreenData } from "@/app/lib/v2/view/desk-data";
import { dayLabel } from "@/app/lib/v2/view/format";
import {
  MONEY_COPY,
  buildAccountsView,
  buildComingView,
  buildForecastView,
  buildHoursView,
  buildLedgerView,
  inDaysLabel,
  moneyAge,
} from "@/app/lib/v2/view/money";
import { DayProvider } from "@/app/v2/_components/day-provider";
import { MONEY_PANE_BODIES } from "@/app/v2/_components/money/money-panes";
import { DeskDataProvider } from "@/app/v2/_desk/desk-data-provider";
import { PaneBox } from "@/app/v2/_desk/pane-box";
import { paneBody } from "@/app/v2/_desk/pane-registry";

const ROOT = path.resolve(__dirname, "..");

const MONEY_IDS = ["forecast", "accounts", "coming-up", "hours", "ledger"];
/** The four that are drawn from money data, and so can be stale or missing. */
const FROM_MONEY = ["forecast", "accounts", "coming-up", "ledger"];

afterEach(() => {
  cleanup();
});

/**
 * createElement for a component whose `children` prop is required: the
 * children go after the props, where react/no-children-prop wants them.
 */
function wrap<P extends { children: ReactNode }>(
  type: ComponentType<P>,
  props: Omit<P, "children"> & Attributes,
  ...children: ReactNode[]
): ReactElement {
  return createElement(type as ComponentType<Omit<P, "children">>, props, ...children);
}

/**
 * One money pane in a box, the way the desk draws it: the desk's data, the day
 * keyed on the planned day, the box. Answers the body's own root element.
 */
function drawPane(
  id: string,
  data: DeskScreenData = sampleDesk(null),
  options: Record<string, string> = {},
): HTMLElement {
  const { container } = render(
    wrap(
      DeskDataProvider,
      { data },
      wrap(
        DayProvider,
        { key: data.today.input.date, data: data.today },
        wrap(
          PaneBox,
          { paneId: id, style: { width: 464, height: 600 } },
          createElement(paneBody(id), { options }),
        ),
      ),
    ),
  );
  const scroller = container.querySelector(`.v2-pane[data-pane="${id}"] .v2-pane-body`);
  return scroller?.firstElementChild as HTMLElement;
}

// ---------------------------------------------------------------- the desks

const fresh = (): DeskScreenData => sampleDesk(null);

const stale = (): DeskScreenData => {
  const desk = sampleDesk(null);
  return { ...desk, money: sampleMoneyStale(desk.today) };
};

const noMoney = (): DeskScreenData => ({ ...sampleDesk(null), money: null });

/** The sample desk with its money patched. */
function withMoney(patch: (money: MoneyScreenData) => Partial<MoneyScreenData>): DeskScreenData {
  const desk = sampleDesk(null);
  const money = desk.money as MoneyScreenData;
  return { ...desk, money: { ...money, ...patch(money) } };
}

/** The sample desk with the planner's input patched (for Hours). */
function withInput(patch: (input: PlanInput) => Partial<PlanInput>): DeskScreenData {
  const desk = sampleDesk(null);
  const input = { ...desk.today.input, ...patch(desk.today.input) };
  return { ...desk, today: { ...desk.today, input } };
}

const moneyOf = (desk: DeskScreenData) => desk.money as MoneyScreenData;
const timeZoneOf = (desk: DeskScreenData) => desk.today.input.rules.timeZone;

/** The view a pane must have been drawn from, for each money pane. */
function ageOf(id: string, desk: DeskScreenData) {
  const money = moneyOf(desk);
  if (id === "forecast") return buildForecastView(money, 30).age;
  if (id === "accounts") return buildAccountsView(money, timeZoneOf(desk)).age;
  if (id === "coming-up") return buildComingView(money, 30).age;
  return buildLedgerView(money, 25).age;
}

const texts = (root: ParentNode, selector: string) =>
  Array.from(root.querySelectorAll(selector)).map((node) => node.textContent ?? "");

/** True when `b` comes after `a` in document order. */
const follows = (a: Node, b: Node) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

/** The text of every visible cell's own figure, in order. */
const figuresIn = (root: ParentNode) => texts(root, ".v2-money-fig");

// ---------------------------------------------------------------- behaviour 1

describe("the five bodies", () => {
  test("fill the money map, and the registry answers them", () => {
    expect(Object.keys(MONEY_PANE_BODIES).sort()).toEqual([...MONEY_IDS].sort());
    for (const id of MONEY_IDS) {
      expect(paneBody(id), id).toBe(MONEY_PANE_BODIES[id]);
    }
  });

  test("say the desk's one sentence when the source holds no money, the four that need it", () => {
    for (const id of FROM_MONEY) {
      const root = drawPane(id, noMoney());
      expect(root.textContent, id).toBe(DESK_COPY.noMoney);
      expect(root.querySelector(".v2-money-fig"), id).toBeNull();
    }
  });

  test("hours needs no money data at all", () => {
    const root = drawPane("hours", noMoney());
    expect(root.querySelectorAll('[role="meter"]')).toHaveLength(2);
    expect(root.textContent).not.toContain(DESK_COPY.noMoney);
  });
});

// ---------------------------------------------------------------- behaviour 2

describe("a stale pane leads with how old it is", () => {
  test.each(FROM_MONEY)("%s: the age line is the first thing, before any number", (id) => {
    const desk = stale();
    const age = ageOf(id, desk);
    expect(age.stale).toBe(true);
    const root = drawPane(id, desk);

    expect(root.hasAttribute("data-stale")).toBe(true);
    const line = root.firstElementChild as HTMLElement;
    expect(line.className).toBe("v2-money-age");
    expect(line.textContent).toBe(age.line);
    // Nothing is said before it: the pane's text starts with the sentence.
    expect((root.textContent ?? "").startsWith(age.line ?? "")).toBe(true);

    const figures = Array.from(root.querySelectorAll(".v2-money-fig"));
    expect(figures.length).toBeGreaterThan(0);
    for (const figure of figures) expect(follows(line, figure)).toBe(true);
  });

  test.each(FROM_MONEY)("%s: a fresh pane has no age line and is not marked stale", (id) => {
    const root = drawPane(id, fresh());
    expect(root.hasAttribute("data-stale")).toBe(false);
    expect(root.querySelector(".v2-money-age")).toBeNull();
    expect(root.querySelector(".v2-money-tag")).toBeNull();
  });

  test("an empty ledger says it cannot tell how current anything is, first", () => {
    const desk = withMoney(() => ({ ledgerLastOn: null, rows: [] }));
    for (const id of FROM_MONEY) {
      const root = drawPane(id, desk);
      expect(root.firstElementChild?.textContent, id).toBe(MONEY_COPY.age.none);
      cleanup();
    }
  });

  // The pane's main figure carries the word. Coming up and the ledger are
  // lists of equals: they have no main figure, so the word is not placed.
  test("puts the last known word beside the main figure, where a pane has one", () => {
    const accounts = drawPane("accounts", stale());
    const total = accounts.querySelector(".v2-money-total") as HTMLElement;
    expect(texts(total, ".v2-money-tag")).toEqual([MONEY_COPY.lastKnownTag]);
    expect(total.querySelector(".v2-money-big")).not.toBeNull();
    cleanup();

    const forecast = drawPane("forecast", stale());
    const lowest = forecast.querySelector(".v2-money-lowest") as HTMLElement;
    expect(texts(lowest, ".v2-money-tag")).toEqual([MONEY_COPY.lastKnownTag]);
    expect(forecast.querySelectorAll(".v2-money-tag")).toHaveLength(1);
    cleanup();

    for (const id of ["coming-up", "ledger"]) {
      expect(drawPane(id, stale()).querySelector(".v2-money-tag"), id).toBeNull();
      cleanup();
    }
  });

  // Fix round 1: a stale source with nothing of a pane's kind still leads with
  // its age, then says it has nothing, and draws no figure.
  const STALE_EMPTY: Array<
    [string, (money: MoneyScreenData) => Partial<MoneyScreenData>, string]
  > = [
    ["forecast", () => ({ forecast: [] }), MONEY_COPY.empty.forecast],
    ["accounts", () => ({ accounts: [] }), MONEY_COPY.empty.accounts],
    [
      "coming-up",
      (money) => ({ forecast: money.forecast.map((day) => ({ ...day, inflow: 0, outflow: 0 })) }),
      MONEY_COPY.empty.coming,
    ],
    ["ledger", () => ({ rows: [] }), MONEY_COPY.empty.ledger],
  ];

  test.each(STALE_EMPTY)("%s: stale and empty, the age line first and then the empty sentence", (id, patch, empty) => {
    const base = stale();
    const money = { ...moneyOf(base), ...patch(moneyOf(base)) };
    const desk = { ...base, money };
    const age = moneyAge(money);
    expect(age.stale).toBe(true);
    const root = drawPane(id, desk);
    expect(root.hasAttribute("data-stale")).toBe(true);
    const [line, sentence] = Array.from(root.children);
    expect(line.className).toBe("v2-money-age");
    expect(line.textContent).toBe(age.line);
    expect(sentence.className).toBe("v2-money-empty");
    expect(sentence.textContent).toBe(empty);
    expect(root.querySelector(".v2-money-fig")).toBeNull();
    expect(root.querySelector(".v2-money-tag")).toBeNull();
  });

  test("hours has no age: it is not drawn from money data", () => {
    const root = drawPane("hours", stale());
    expect(root.querySelector(".v2-money-age")).toBeNull();
    expect(root.hasAttribute("data-stale")).toBe(false);
  });
});

// ---------------------------------------------------------------- behaviour 3

describe("the forecast", () => {
  const cellsOf = (root: HTMLElement) =>
    Array.from(root.querySelectorAll<HTMLElement>(".v2-money-grid .v2-money-cell"));
  const inRange = (root: HTMLElement) => cellsOf(root).filter((cell) => !cell.hasAttribute("data-pad"));
  const daysOf = (root: HTMLElement) =>
    Array.from(root.querySelectorAll<HTMLElement>(".v2-money-days > li"));
  /** A cell's own name for its day, read, not seen. */
  const labelOf = (cell: HTMLElement) => cell.querySelector(".v2-hidden")?.textContent ?? "";

  test.each([
    ["14", 14],
    ["30", 30],
    ["60", 60],
    [undefined, 30],
    ["", 30],
    ["90", 30],
    ["constructor", 30],
    [" 14", 30],
  ] as const)("takes span %s as %d days", (span, days) => {
    const root = drawPane("forecast", fresh(), span === undefined ? {} : { span });
    const view = buildForecastView(moneyOf(fresh()), days);
    expect(daysOf(root)).toHaveLength(days);
    expect(inRange(root)).toHaveLength(days);
    expect(cellsOf(root)).toHaveLength(view.weeks.length * 7);
    expect(texts(root, ".v2-money-days .v2-money-date")).toEqual(
      view.list.map((cell) => dayLabel(cell.date)),
    );
  });

  test("draws a weekday header, Monday first, that a screen reader skips", () => {
    const root = drawPane("forecast");
    const header = root.querySelector(".v2-money-wkdays") as HTMLElement;
    expect(header.getAttribute("aria-hidden")).toBe("true");
    expect(texts(header, "span")).toEqual(buildForecastView(moneyOf(fresh()), 30).weekdays);
  });

  test("gives each day its number, its balance and its marks, in both layouts", () => {
    const view = buildForecastView(moneyOf(fresh()), 30);
    const root = drawPane("forecast");
    const cells = inRange(root);
    const days = daysOf(root);
    view.list.forEach((cell, index) => {
      expect(labelOf(cells[index])).toBe(dayLabel(cell.date));
      expect(cells[index].querySelector(".v2-money-dnum")?.textContent).toBe(String(cell.dayOfMonth));
      for (const holder of [cells[index], days[index]]) {
        expect(holder.querySelector(".v2-money-fig")?.textContent).toBe(cell.balance);
        expect(texts(holder, ".v2-money-mark")).toEqual(
          cell.marks.map((mark) => `${mark.label} ${MONEY_COPY.sign[mark.kind]}`),
        );
      }
    });
    // A cell's balance may break only after a thousands comma, never inside a
    // group; the list's has the room and no break.
    view.list.forEach((cell, index) => {
      const commas = (cell.balance ?? "").split(",").length - 1;
      expect(cells[index].querySelectorAll(".v2-money-fig wbr")).toHaveLength(commas);
      expect(days[index].querySelectorAll(".v2-money-fig wbr")).toHaveLength(0);
    });
    // The month word is the view's: drawn exactly where a cell carries one.
    expect(cells.map((cell) => cell.querySelector(".v2-money-month")?.textContent ?? null)).toEqual(
      view.list.map((cell) => cell.month),
    );
    expect(view.list.filter((cell) => cell.month !== null).length).toBeGreaterThanOrEqual(2);
    // The sample's marks really are drawn: a bill and the pay.
    expect(texts(root, ".v2-money-grid .v2-money-mark")).toContain(
      `Phone 50 ${MONEY_COPY.sign.out}`,
    );
    expect(texts(root, ".v2-money-grid .v2-money-mark")).toContain(
      `Shop pay 2,000 ${MONEY_COPY.sign.in}`,
    );
  });

  test("marks today as the current date, in both layouts", () => {
    const desk = fresh();
    const root = drawPane("forecast", desk);
    const today = dayLabel(moneyOf(desk).today);
    for (const scope of [".v2-money-grid", ".v2-money-days"]) {
      const current = Array.from(root.querySelectorAll<HTMLElement>(`${scope} [aria-current="date"]`));
      expect(current, scope).toHaveLength(1);
      expect(current[0].hasAttribute("data-today")).toBe(true);
      const name =
        scope === ".v2-money-grid"
          ? labelOf(current[0])
          : current[0].querySelector(".v2-money-date")?.textContent;
      expect(name).toBe(today);
    }
  });

  test("names the one lowest day with a word, in the summary and in both layouts", () => {
    const view = buildForecastView(moneyOf(fresh()), 30);
    expect(view.lowest).not.toBeNull();
    const root = drawPane("forecast");

    const summary = root.querySelector(".v2-money-lowest") as HTMLElement;
    expect(summary.querySelector(".v2-money-label")?.textContent).toBe(MONEY_COPY.lowest);
    expect(summary.querySelector(".v2-money-fig")?.textContent).toBe(view.lowest?.balance);
    expect(summary.textContent).toContain(view.lowest?.date);

    const lowCells = inRange(root).filter((cell) => cell.hasAttribute("data-lowest"));
    expect(lowCells).toHaveLength(1);
    expect(labelOf(lowCells[0])).toBe(view.lowest?.date);
    expect(texts(lowCells[0], ".v2-money-flag")).toEqual([MONEY_COPY.lowest]);

    const lowDays = daysOf(root).filter((day) => day.hasAttribute("data-lowest"));
    expect(lowDays).toHaveLength(1);
    expect(texts(lowDays[0], ".v2-money-flag")).toEqual([MONEY_COPY.lowest]);
    // No other day carries a flag: the sample never goes under zero.
    expect(root.querySelectorAll(".v2-money-flag")).toHaveLength(2);
  });

  test("says under zero in words on every day under zero, never by colour alone", () => {
    const desk = withMoney((money) => ({
      forecast: money.forecast.map((day) => ({ ...day, projected: day.projected - 5600 })),
    }));
    const view = buildForecastView(moneyOf(desk), 30);
    const negatives = view.list.filter((cell) => cell.negative);
    expect(negatives.length).toBeGreaterThan(1);
    const root = drawPane("forecast", desk);

    for (const [scope, holders] of [
      ["grid", inRange(root)],
      ["list", daysOf(root)],
    ] as const) {
      const under = holders.filter((holder) => holder.hasAttribute("data-negative"));
      expect(under, scope).toHaveLength(negatives.length);
      for (const holder of under) {
        expect(texts(holder, ".v2-money-flag"), scope).toContain(MONEY_COPY.underZero);
      }
      // Still exactly one lowest, and it says both.
      const lowest = holders.filter((holder) => holder.hasAttribute("data-lowest"));
      expect(lowest, scope).toHaveLength(1);
      expect(texts(lowest[0], ".v2-money-flag"), scope).toEqual([
        MONEY_COPY.lowest,
        MONEY_COPY.underZero,
      ]);
    }
  });

  test("says the estimate under both layouts, always, and after every figure", () => {
    const view = buildForecastView(moneyOf(fresh()), 30);
    const root = drawPane("forecast");
    const estimate = root.querySelector(".v2-money-estimate") as HTMLElement;
    expect(estimate.textContent).toBe(view.estimate);
    expect(root.lastElementChild).toBe(estimate);
    for (const part of root.querySelectorAll(".v2-money-grid, .v2-money-days, .v2-money-fig")) {
      expect(follows(part, estimate)).toBe(true);
    }
  });

  test("says when there is no forecast, and still says the estimate", () => {
    const root = drawPane("forecast", withMoney(() => ({ forecast: [] })));
    expect(root.querySelector(".v2-money-empty")?.textContent).toBe(MONEY_COPY.empty.forecast);
    expect(root.querySelector(".v2-money-estimate")?.textContent).toBeTruthy();
    expect(root.querySelector(".v2-money-grid")).toBeNull();
    expect(root.querySelector(".v2-money-fig")).toBeNull();
  });

  // The source's forecast can stop before the span does. The view trims the
  // tail and names the end (v2-view-money.test.ts); the pane draws exactly the
  // weeks and the days it is handed, and words the end in one line.
  test("draws what the view hands over when the source stops short, and says where", () => {
    const desk = withMoney((money) => ({ forecast: money.forecast.slice(0, 20) }));
    const view = buildForecastView(moneyOf(desk), 30);
    expect(view.endsOn).not.toBeNull();
    expect(view.list).toHaveLength(20);

    const root = drawPane("forecast", desk);
    expect(cellsOf(root).map((cell) => labelOf(cell) || null)).toEqual(
      view.weeks.flat().map((cell) => (cell.inRange ? dayLabel(cell.date) : null)),
    );
    expect(texts(root, ".v2-money-days .v2-money-date")).toEqual(
      view.list.map((cell) => dayLabel(cell.date)),
    );
    // Days of a drawn week the source has no row for: there, with no figure.
    const blank = inRange(root).filter((cell) => cell.querySelector(".v2-money-fig") === null);
    expect(blank.length).toBeGreaterThan(0);
    for (const cell of blank) {
      expect(cell.hasAttribute("data-blank")).toBe(true);
      expect(cell.querySelector(".v2-money-flag")).toBeNull();
      expect(cell.querySelector(".v2-money-mark")).toBeNull();
    }
    expect(inRange(root).filter((cell) => cell.hasAttribute("data-blank"))).toHaveLength(blank.length);

    const ends = root.querySelector(".v2-money-ends") as HTMLElement;
    expect(ends.textContent).toBe(MONEY_COPY.endsOn.replace("{date}", dayLabel(view.endsOn ?? "")));
    expect(follows(root.querySelector(".v2-money-days") as Node, ends)).toBe(true);
    expect(follows(ends, root.querySelector(".v2-money-estimate") as Node)).toBe(true);
  });

  test("says nothing about an end when the source covers the whole span", () => {
    expect(drawPane("forecast").querySelector(".v2-money-ends")).toBeNull();
  });

  test("draws nothing in a cell that only pads a week", () => {
    const root = drawPane("forecast");
    const pads = cellsOf(root).filter((cell) => cell.hasAttribute("data-pad"));
    expect(pads.length).toBeGreaterThan(0);
    for (const pad of pads) {
      expect(pad.getAttribute("aria-hidden")).toBe("true");
      expect(pad.textContent).toBe("");
    }
  });
});

// ---------------------------------------------------------------- behaviour 4

describe("the accounts", () => {
  test("the total first, then a line per account, then when they were read", () => {
    const desk = fresh();
    const view = buildAccountsView(moneyOf(desk), timeZoneOf(desk));
    const root = drawPane("accounts", desk);

    const total = root.querySelector(".v2-money-total") as HTMLElement;
    const big = total.querySelector(".v2-money-big") as HTMLElement;
    expect(big.textContent).toBe(view.total);
    expect(big.classList.contains("v2-money-fig")).toBe(true);
    expect(total.textContent).toContain(MONEY_COPY.total);
    expect(total.textContent).toContain(view.currency);

    const lines = Array.from(root.querySelectorAll<HTMLElement>(".v2-money-accts > li"));
    expect(lines.map((line) => line.querySelector(".v2-money-name")?.textContent)).toEqual(
      view.accounts.map((account) => account.name),
    );
    expect(lines.map((line) => line.querySelector(".v2-money-fig")?.textContent)).toEqual(
      view.accounts.map((account) => account.balance),
    );

    const taken = root.querySelector(".v2-money-taken") as HTMLElement;
    expect(taken.textContent).toBe(view.takenLine);
    expect(follows(big, lines[0])).toBe(true);
    expect(follows(lines[lines.length - 1], taken)).toBe(true);
  });

  test("says why there is no total when the accounts are in two currencies", () => {
    const desk = withMoney((money) => ({
      accounts: [
        ...money.accounts,
        { id: "sample-abroad", name: "Abroad", kind: "checking", balance: 300, currency: "EUR" },
      ],
    }));
    const view = buildAccountsView(moneyOf(desk), timeZoneOf(desk));
    expect(view.total).toBeNull();
    const root = drawPane("accounts", desk);
    expect(root.querySelector(".v2-money-big")).toBeNull();
    expect(root.querySelector(".v2-money-total")?.textContent).toContain(view.totalNote);
    // With no shared currency, each line says its own.
    const lines = Array.from(root.querySelectorAll<HTMLElement>(".v2-money-accts > li"));
    expect(lines.map((line) => line.querySelector(".v2-money-cur")?.textContent)).toEqual(
      view.accounts.map((account) => account.currency),
    );
  });

  test("says when there are no accounts", () => {
    const root = drawPane("accounts", withMoney(() => ({ accounts: [] })));
    expect(root.querySelector(".v2-money-empty")?.textContent).toBe(MONEY_COPY.empty.accounts);
    expect(root.querySelector(".v2-money-fig")).toBeNull();
  });
});

// ---------------------------------------------------------------- behaviour 5

describe("coming up", () => {
  test("a list in date order: the date, how far off, the name, the amount and its sign word", () => {
    const view = buildComingView(moneyOf(fresh()), 30);
    expect(view.items.length).toBeGreaterThanOrEqual(3);
    const root = drawPane("coming-up");
    const items = Array.from(root.querySelectorAll<HTMLElement>(".v2-money-coming > li"));
    expect(items).toHaveLength(view.items.length);
    view.items.forEach((item, index) => {
      const row = items[index];
      expect(row.querySelector(".v2-money-name")?.textContent).toBe(item.name);
      expect(row.querySelector(".v2-money-fig")?.textContent).toBe(item.amount);
      expect(row.querySelector(".v2-money-sign")?.textContent).toBe(MONEY_COPY.sign[item.kind]);
      expect(row.querySelector(".v2-money-date")?.textContent).toBe(item.date);
      expect(row.querySelector(".v2-money-when")?.textContent).toBe(inDaysLabel(item.inDays));
      expect(row.dataset.kind).toBe(item.kind);
    });
  });

  test("says when nothing with a date is coming", () => {
    const root = drawPane(
      "coming-up",
      withMoney((money) => ({
        forecast: money.forecast.map((day) => ({ ...day, inflow: 0, outflow: 0 })),
      })),
    );
    expect(root.querySelector(".v2-money-empty")?.textContent).toBe(MONEY_COPY.empty.coming);
  });
});

// ---------------------------------------------------------------- behaviour 6

describe("hours", () => {
  const metersOf = (root: HTMLElement) =>
    Array.from(root.querySelectorAll<HTMLElement>('[role="meter"]'));
  const expected = (desk: DeskScreenData) =>
    buildHoursView(desk.today.input, planDay(desk.today.input).blocks);
  /**
   * A meter's accessible name, as a screen reader takes it: from the element
   * its `aria-labelledby` names. It has no `aria-label` of its own, so the name
   * is said once, not once as the heading and again as the label.
   */
  const nameOf = (meter: HTMLElement) => {
    expect(meter.hasAttribute("aria-label")).toBe(false);
    const ids = (meter.getAttribute("aria-labelledby") ?? "").split(" ").filter(Boolean);
    expect(ids.length).toBeGreaterThan(0);
    return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
  };
  const shareOf = (meter: HTMLElement) =>
    (meter.querySelector(".v2-money-bar-fill") as HTMLElement).style.getPropertyValue("--v2-money-at");

  test("two plain bars, the target and the cap, each with its three values", () => {
    const desk = fresh();
    const view = expected(desk);
    expect(view.target).not.toBeNull();
    expect(view.cap).not.toBeNull();
    const root = drawPane("hours", desk);
    const [target, cap] = metersOf(root);

    expect(nameOf(target)).toBe(MONEY_COPY.hours.target);
    expect(target.getAttribute("aria-valuemin")).toBe("0");
    expect(target.getAttribute("aria-valuemax")).toBe(String(view.target?.hours));
    expect(target.getAttribute("aria-valuenow")).toBe(String(view.target?.valueNow));
    expect(target.getAttribute("aria-valuetext")).toBe(view.target?.label);
    expect(shareOf(target)).toBe(String(view.target?.share));

    expect(nameOf(cap)).toBe(MONEY_COPY.hours.cap);
    expect(cap.getAttribute("aria-valuemax")).toBe(String(view.cap?.hours));
    expect(cap.getAttribute("aria-valuenow")).toBe(String(view.cap?.valueNow));
    expect(shareOf(cap)).toBe(String(view.cap?.share));

    expect(texts(root, ".v2-money-meter-value")).toEqual([view.target?.label, view.cap?.label]);
    expect(texts(root, ".v2-money-meter-name")).toEqual([
      MONEY_COPY.hours.target,
      MONEY_COPY.hours.cap,
    ]);
    expect(root.querySelector("[data-over]")).toBeNull();
    // No percentage anywhere: a bar and its sentence, nothing that reads as a score.
    expect(root.textContent).not.toContain("%");
  });

  test("draws no bar for what the rules do not set", () => {
    const noTarget = withInput((input) => ({ rules: { ...input.rules, incomeTarget: null } }));
    let root = drawPane("hours", noTarget);
    expect(metersOf(root).map(nameOf)).toEqual([MONEY_COPY.hours.cap]);
    cleanup();

    const noCap = withInput((input) => ({ rules: { ...input.rules, weeklyHourCap: null } }));
    root = drawPane("hours", noCap);
    expect(metersOf(root).map(nameOf)).toEqual([MONEY_COPY.hours.target]);
  });

  test("one sentence and no bar when neither is set", () => {
    const neither = withInput((input) => ({
      rules: { ...input.rules, incomeTarget: null, weeklyHourCap: null },
    }));
    const root = drawPane("hours", neither);
    expect(metersOf(root)).toHaveLength(0);
    expect(root.textContent).toBe(MONEY_COPY.empty.hours);
  });

  test("over the cap: the bar is marked, the word is said, the value stays in range", () => {
    const tight = withInput((input) => ({ rules: { ...input.rules, weeklyHourCap: 5 } }));
    const view = expected(tight);
    expect(view.cap?.over).toBe(true);
    const root = drawPane("hours", tight);
    const cap = metersOf(root).find((meter) => nameOf(meter) === MONEY_COPY.hours.cap) as HTMLElement;
    const item = cap.closest(".v2-money-meter") as HTMLElement;
    expect(item.hasAttribute("data-over")).toBe(true);
    expect(item.querySelector(".v2-money-over")?.textContent).toBe(MONEY_COPY.hours.over);
    expect(cap.getAttribute("aria-valuenow")).toBe(String(view.cap?.valueNow));
    expect(view.cap?.valueNow).toBe(5);
    expect(shareOf(cap)).toBe("1");
    expect(cap.getAttribute("aria-valuetext")).toBe(view.cap?.label);
    // The target's bar is never the danger one, whatever its value.
    expect(root.querySelectorAll("[data-over]")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- behaviour 7

describe("the ledger", () => {
  /** Sixty invented lines, newest first, so every choice of rows cuts. */
  const longLedger = () =>
    withMoney((money) => ({
      rows: Array.from(
        { length: 60 },
        (_, index): MoneyRow => ({
          id: `long-${index + 1}`,
          on: shiftDateKey(money.today, -(index + 1)),
          direction: index % 5 === 0 ? "in" : "out",
          amount: 10 + index,
          account: "Everyday",
          category: index % 3 === 0 ? null : "Food",
          note: `Line ${index + 1}`,
        }),
      ),
    }));
  const rowsOf = (root: HTMLElement) =>
    Array.from(root.querySelectorAll<HTMLElement>(".v2-money-txs > li"));

  test.each([
    ["10", 10],
    ["25", 25],
    ["50", 50],
    [undefined, 25],
    ["100", 25],
    ["toString", 25],
  ] as const)("takes rows %s as %d lines, and counts the rest", (rows, shown) => {
    const root = drawPane("ledger", longLedger(), rows === undefined ? {} : { rows });
    expect(rowsOf(root)).toHaveLength(shown);
    expect(root.querySelector(".v2-money-more")?.textContent).toBe(
      MONEY_COPY.more.replace("{count}", String(60 - shown)),
    );
  });

  test("each line: the date, the note, the account, the category and the amount", () => {
    const view = buildLedgerView(moneyOf(fresh()), 10);
    const root = drawPane("ledger", fresh(), { rows: "10" });
    const rows = rowsOf(root);
    expect(rows).toHaveLength(10);
    view.rows.forEach((line, index) => {
      const row = rows[index];
      const parts = Array.from(row.children).map((child) => child.className);
      expect(parts).toEqual([
        "v2-money-tx-date",
        "v2-money-tx-note",
        "v2-money-tx-acct",
        "v2-money-tx-cat",
        "v2-money-amt",
      ]);
      expect(row.querySelector(".v2-money-tx-date")?.textContent).toBe(line.date);
      expect(row.querySelector(".v2-money-tx-note")?.textContent).toBe(line.note);
      expect(row.querySelector(".v2-money-tx-acct")?.textContent).toBe(line.account);
      expect(row.querySelector(".v2-money-tx-cat")?.textContent).toBe(line.category ?? "");
      expect(row.querySelector(".v2-money-fig")?.textContent).toBe(line.amount);
      expect(row.querySelector(".v2-money-sign")?.textContent).toBe(MONEY_COPY.sign[line.kind]);
    });
    expect(root.querySelector(".v2-money-more")?.textContent).toBe(
      MONEY_COPY.more.replace("{count}", String(view.more)),
    );
  });

  // Fix round 1. The whole note is in the document, for a screen reader and
  // for a line clamp to cut where the eye needs it; nothing hides behind a
  // title, which a finger cannot reach.
  test("puts every character of a long note in the document, and no title", () => {
    const note = Array.from({ length: 60 }, (_, index) => `part${index}`).join(" ").slice(0, 300);
    expect(note).toHaveLength(300);
    const root = drawPane(
      "ledger",
      withMoney((money) => ({ rows: [{ ...money.rows[0], note }, ...money.rows.slice(1)] })),
    );
    const first = rowsOf(root)[0];
    expect(first.querySelector(".v2-money-tx-note")?.textContent).toBe(note);
    expect(root.querySelectorAll("[title]")).toHaveLength(0);
  });

  test("counts nothing when every line is shown", () => {
    const root = drawPane("ledger");
    expect(rowsOf(root)).toHaveLength(moneyOf(fresh()).rows.length);
    expect(root.querySelector(".v2-money-more")).toBeNull();
  });

  test("says when there are no transactions", () => {
    const root = drawPane("ledger", withMoney(() => ({ rows: [], ledgerLastOn: null })));
    expect(root.querySelector(".v2-money-empty")?.textContent).toBe(MONEY_COPY.empty.ledger);
    expect(rowsOf(root)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- behaviour 8

describe("read only, and one shape for every list", () => {
  const desks = [
    ["fresh", fresh],
    ["stale", stale],
  ] as const;

  test.each(desks)("%s: nothing in any money pane can be pressed or typed in", (_name, desk) => {
    for (const id of MONEY_IDS) {
      const root = drawPane(id, desk());
      expect(root.querySelectorAll("a, button, input, select, textarea, [tabindex]"), id).toHaveLength(0);
      expect(root.querySelectorAll('[role="status"], [aria-live]'), id).toHaveLength(0);
      cleanup();
    }
  });

  test.each(desks)("%s: every list says it is a list", (_name, desk) => {
    let lists = 0;
    for (const id of MONEY_IDS) {
      const root = drawPane(id, desk());
      for (const list of root.querySelectorAll("ul, ol")) {
        expect(list.getAttribute("role"), `${id} ${list.className}`).toBe("list");
        lists += 1;
      }
      cleanup();
    }
    expect(lists).toBeGreaterThanOrEqual(5);
  });

  test("draws every amount the views hold as a figure", () => {
    const desk = fresh();
    const money = moneyOf(desk);
    const accounts = buildAccountsView(money, timeZoneOf(desk));
    const coming = buildComingView(money, 30);
    const ledger = buildLedgerView(money, 25);

    expect(figuresIn(drawPane("accounts", desk))).toEqual([
      accounts.total,
      ...accounts.accounts.map((account) => account.balance),
    ]);
    cleanup();
    expect(figuresIn(drawPane("coming-up", desk))).toEqual(coming.items.map((item) => item.amount));
    cleanup();
    expect(figuresIn(drawPane("ledger", desk))).toEqual(ledger.rows.map((line) => line.amount));
  });

  test("the words the panes add to the money copy are plain", () => {
    const added = [
      MONEY_COPY.sign.in,
      MONEY_COPY.sign.out,
      MONEY_COPY.lastKnownTag,
      MONEY_COPY.endsOn,
    ];
    for (const text of added) {
      expect(typeof text).toBe("string");
      expect(text).not.toContain(String.fromCodePoint(0x2014));
      expect(text).not.toContain(String.fromCodePoint(0x2013));
    }
    expect(MONEY_COPY.endsOn).toContain("{date}");
  });
});

// ------------------------------------------------------- behaviour 3, 7 and 8: the sheet

describe("money.css", () => {
  const CSS = readFileSync(path.join(ROOT, "app/v2/money.css"), "utf8");
  const sheet = postcss.parse(CSS, { from: "app/v2/money.css" });

  /** Every rule with where it sits: the at-rule around it, or "". */
  const rulesOf = () => {
    const out: Array<{ rule: Rule; where: string }> = [];
    sheet.walkRules((rule) => {
      const parent = rule.parent as AtRule | undefined;
      const where = parent?.type === "atrule" ? `@${parent.name} ${parent.params.trim()}` : "";
      out.push({ rule, where });
    });
    return out;
  };

  /** The last value one selector is given for one property, in one place. */
  const valueOf = (where: string, selector: string, prop: string) => {
    let found: string | null = null;
    for (const entry of rulesOf()) {
      if (entry.where !== where) continue;
      if (!entry.rule.selectors.map((one) => one.trim()).includes(`[data-v2-root] ${selector}`)) {
        continue;
      }
      entry.rule.walkDecls(prop, (decl) => {
        found = decl.value;
      });
    }
    return found;
  };

  const WIDE_FORECAST = "@container v2-pane (width >= 480px)";
  const WIDE_LEDGER = "@container v2-pane (width >= 420px)";

  test("is loaded after the desk's sheet", () => {
    const layout = readFileSync(path.join(ROOT, "app/v2/layout.tsx"), "utf8");
    const at = (name: string) => layout.indexOf(`import "./${name}";`);
    expect(at("desk.css")).toBeGreaterThan(-1);
    expect(at("money.css")).toBeGreaterThan(at("desk.css"));
  });

  // Behaviour 3. Both layouts are in the document and the pane's own width
  // picks one, so the other is out of the tab order and the accessibility tree.
  test("draws the forecast as a list under 480px of pane and as a grid from there", () => {
    expect(valueOf("", ".v2-money-grid", "display")).toBe("none");
    expect(valueOf("", ".v2-money-days", "display")).toBe("flex");
    expect(valueOf(WIDE_FORECAST, ".v2-money-grid", "display")).toBe("block");
    expect(valueOf(WIDE_FORECAST, ".v2-money-days", "display")).toBe("none");
    // Seven tracks that a long word cannot widen, for the header and the days.
    for (const selector of [".v2-money-wkdays", ".v2-money-cells"]) {
      expect(valueOf("", selector, "grid-template-columns")).toBe("repeat(7, minmax(0, 1fr))");
    }
  });

  // Behaviour 7. Under 420px a line is two lines; from 420px it is one, on
  // columns every line shares.
  test("lays a ledger line on one line from 420px of pane, two under it", () => {
    expect(valueOf("", ".v2-money-tx", "grid-template-columns")).toBeTruthy();
    expect(valueOf("", ".v2-money-tx-note", "grid-row")).toBe("1");
    expect(valueOf("", ".v2-money-tx-date", "grid-row")).toBe("2");
    expect(valueOf(WIDE_LEDGER, ".v2-money-txs", "display")).toBe("grid");
    expect(valueOf(WIDE_LEDGER, ".v2-money-tx", "grid-template-columns")).toBe("subgrid");
    expect(valueOf(WIDE_LEDGER, ".v2-money-tx > *", "grid-row")).toBe("auto");
  });

  // Behaviour 2. One switch: the pane root is marked stale, and every figure
  // under it goes to the quieter ink, while the age line is in the full ink.
  test("quiets every figure of a stale pane, and the age line is the loudest text", () => {
    expect(valueOf("", ".v2-money-fig", "color")).toBe("var(--v2-ink)");
    expect(valueOf("", ".v2-money[data-stale] .v2-money-fig", "color")).toBe("var(--v2-ink-2)");
    expect(valueOf("", ".v2-money-age", "color")).toBe("var(--v2-ink)");
    expect(valueOf("", ".v2-money-age", "border")).toMatch(/1px solid var\(--v2-edge\)/);
    // The big total and the lowest day's figure step down too, so neither out
    // shouts the age line by size.
    expect(valueOf("", ".v2-money[data-stale] .v2-money-big", "font-size")).toBeTruthy();
    expect(
      valueOf("", ".v2-money[data-stale] .v2-money-lowest .v2-money-fig", "font-size"),
    ).toBeTruthy();
  });

  test("draws a day the source cannot see as plainly not a day of zero", () => {
    expect(valueOf("", ".v2-money-cell[data-blank]", "outline")).toBe("1px dashed var(--v2-edge)");
    expect(valueOf("", ".v2-money-cell[data-blank]", "background")).toBe("none");
  });

  // There is no danger token in v2.css. The panes read one alias, set once on
  // their root, so a real token later is a one line change; it is a mark, so it
  // is never the colour of a word.
  test("marks danger through one alias, as a mark and never as text", () => {
    expect(valueOf("", ".v2-money", "--v2-money-danger")).toBe("var(--v2-warn)");
    // Under a stale ledger the word stays and the alarm colour goes.
    expect(valueOf("", ".v2-money[data-stale]", "--v2-money-danger")).toBe("var(--v2-ink-3)");
    const asText: string[] = [];
    sheet.walkDecls((decl) => {
      if (decl.prop === "color" && decl.value.includes("--v2-money-danger")) asText.push(decl.toString());
    });
    expect(asText).toEqual([]);
    const used: string[] = [];
    sheet.walkDecls((decl) => {
      if (decl.value.includes("var(--v2-money-danger)")) used.push(decl.prop);
    });
    expect(used.length).toBeGreaterThanOrEqual(3);
    expect(valueOf("", ".v2-money-meter[data-over] .v2-money-bar-fill", "background")).toBe(
      "var(--v2-money-danger)",
    );
  });

  test("marks today as the calendar does: the day's number on the accent", () => {
    expect(valueOf("", ".v2-money-cell[data-today] .v2-money-dnum", "background")).toBe(
      "var(--v2-accent)",
    );
    expect(valueOf("", ".v2-money-cell[data-today] .v2-money-dnum", "color")).toBe(
      "var(--v2-on-accent)",
    );
    expect(valueOf("", ".v2-money-day[data-today] .v2-money-date", "color")).toBe(
      "var(--v2-signal)",
    );
  });

  test("says the estimate in the quiet ink", () => {
    expect(valueOf("", ".v2-money-estimate", "color")).toBe("var(--v2-ink-3)");
  });

  test("writes every figure in figures that do not shift", () => {
    expect(valueOf("", ".v2-money-fig", "font-variant-numeric")).toBe("tabular-nums");
    expect(valueOf("", ".v2-money-meter-value", "font-variant-numeric")).toBe("tabular-nums");
  });

  test("lets a long word break instead of widening the pane", () => {
    for (const selector of [
      ".v2-money-age",
      ".v2-money-name",
      ".v2-money-tx-note",
      ".v2-money-mark",
      ".v2-money-estimate",
      ".v2-money-big",
    ]) {
      expect(valueOf("", selector, "overflow-wrap"), selector).toBe("anywhere");
    }
    for (const selector of [".v2-money-name", ".v2-money-tx-note", ".v2-money-cell"]) {
      expect(valueOf("", selector, "min-width"), selector).toBe("0");
    }
  });

  test("scopes every rule to the root, and leaves reduced motion to v2.css", () => {
    sheet.walkRules((rule) => {
      for (const selector of rule.selectors) {
        expect(selector.trim().startsWith("[data-v2-root] "), selector).toBe(true);
      }
    });
    const own: string[] = [];
    sheet.walkAtRules("media", (media) => {
      own.push(media.params);
    });
    expect(own).toEqual([]);
  });

  test("moves nothing on load", () => {
    const animations: string[] = [];
    sheet.walkDecls(/^animation/, (decl) => {
      animations.push(decl.value);
    });
    sheet.walkAtRules("keyframes", (at) => {
      animations.push(at.params);
    });
    expect(animations).toEqual([]);
  });

  // Fix round 1. The plan's motion rule: motion moves only transform and
  // opacity. A transition on anything else (a hover's background colour, say)
  // is refused here; today the sheet has no transition at all.
  test("transitions nothing but transform and opacity, at the screen's own speeds", () => {
    /** The comma separated parts of a value, a comma inside parentheses kept. */
    const parts = (value: string) => {
      const out: string[] = [];
      let depth = 0;
      let current = "";
      for (const char of value) {
        if (char === "(") depth += 1;
        if (char === ")") depth -= 1;
        if (char === "," && depth === 0) {
          out.push(current.trim());
          current = "";
        } else {
          current += char;
        }
      }
      out.push(current.trim());
      return out;
    };
    const ALLOWED = new Set(["transform", "opacity", "none"]);
    const offenders: string[] = [];
    sheet.walkDecls(/^transition(-property)?$/, (decl) => {
      for (const part of parts(decl.value)) {
        const property = part.split(/\s+/)[0];
        if (!ALLOWED.has(property)) offenders.push(`${decl.parent?.toString().split("{")[0].trim()}: ${decl}`);
      }
    });
    expect(offenders).toEqual([]);
    sheet.walkDecls(/^transition(-duration|-timing-function)?$/, (decl) => {
      if (decl.prop !== "transition-timing-function" && decl.value !== "none") {
        expect(decl.value).toMatch(/var\(--v2-(quick|std|slow)\)/);
      }
      if (decl.prop !== "transition-duration" && decl.value !== "none") {
        expect(decl.value).toMatch(/var\(--v2-ease(-in)?\)/);
      }
    });
  });

  test("brings no font of its own and no colour of its own", () => {
    expect(CSS).not.toMatch(/@font-face|@import/);
    sheet.walkDecls(/^font(-family)?$/, (decl) => {
      expect(decl.value, decl.toString()).toMatch(/var\(--v2-(display|text)\)/);
    });
    sheet.walkDecls((decl) => {
      expect(decl.value, decl.toString()).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
    });
  });

  // The pane box is the one scroller (desk.css): a body that scrolled itself
  // would trap the wheel, and a fixed height would not fit a 150px box.
  test("adds no scroller and no fixed height to a body", () => {
    sheet.walkDecls(/^(overflow-y|height)$/, (decl) => {
      expect(decl.value, decl.toString()).not.toMatch(/auto|scroll|vh|dvh/);
    });
  });

  // The side column's leaves tie their base rules at two classes, and this
  // sheet loads after v2.css, so a bare rule on one of them here would win on
  // Today's own page. Nothing here touches them at all.
  test("leaves the shared leaves alone", () => {
    const shared = /\.v2-(feeds|allday|energy|said|sub|row|more|empty|side|list-rows)\b/;
    sheet.walkRules((rule) => {
      for (const selector of rule.selectors) expect(selector, selector).not.toMatch(shared);
    });
  });
});

// The age line of the stale sample, as the view words it, so a reader of this
// file can see what the panes lead with.
test("the stale sample's age line is the one the panes lead with", () => {
  const desk = stale();
  expect(moneyAge(moneyOf(desk)).line).toMatch(/^No transaction since \d{1,2} [A-Z][a-z]+, 80 days ago\./);
});
