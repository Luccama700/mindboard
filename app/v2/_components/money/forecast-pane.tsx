"use client";

import { Fragment, useMemo, type ReactNode } from "react";

import { dayLabel } from "@/app/lib/v2/view/format";
import {
  MONEY_COPY,
  buildForecastView,
  type MoneyCell,
  type MoneyForecastView,
  type MoneySpan,
} from "@/app/lib/v2/view/money";
import { useDeskData } from "../../_desk/desk-data-provider";
import type { PaneBodyProps } from "../../_desk/pane-body";
import { LastKnown, MoneyAgeLine, NoMoney, staleMark } from "./money-age";

/**
 * The `span` option: "14", "30" or "60" days, and 30 for anything else. Each
 * choice is compared as a whole string, because the value comes from a URL or
 * a saved layout and a lookup keyed by it could answer from a prototype.
 */
export function forecastSpan(value: string | undefined): MoneySpan {
  if (value === "14") return 14;
  if (value === "60") return 60;
  return 30;
}

/** The days of the window that are drawn, and the day the forecast ends when it stops short. */
interface Drawn {
  /** The grid's cells, week after week, padding included. */
  cells: MoneyCell[];
  list: MoneyCell[];
  /** The last day with a balance, worded, when the span runs past it; else null. */
  endsOn: string | null;
}

/**
 * A source's forecast can stop before the span does, and the days after its
 * last row have no balance. A tail of weeks with nothing in them would read as
 * empty weeks rather than as weeks nobody can see, so the trailing run of weeks
 * whose days all have no balance is not drawn, the list stops at the last day
 * that has one, and one line says where the forecast ends. Only the tail: a
 * hole in the middle is drawn, day by day, as the days it is.
 *
 * Presentation only. It reads the cells the view made and computes nothing new.
 */
function drawnOf(view: MoneyForecastView): Drawn {
  let lastDay = -1;
  view.list.forEach((cell, index) => {
    if (cell.balance !== null) lastDay = index;
  });
  let lastWeek = -1;
  view.weeks.forEach((week, index) => {
    if (week.some((cell) => cell.inRange && cell.balance !== null)) lastWeek = index;
  });
  if (lastDay < 0) return { cells: view.weeks.flat(), list: view.list, endsOn: null };
  return {
    cells: view.weeks.slice(0, lastWeek + 1).flat(),
    list: view.list.slice(0, lastDay + 1),
    endsOn: lastDay < view.list.length - 1 ? dayLabel(view.list[lastDay].date) : null,
  };
}

/**
 * "Apr", read off the view layer's own day label so the names live in one
 * place, and cut to three letters as the view cuts the weekdays: beside the
 * day's number in a cell 50px wide, a whole month name is cut to its first
 * letter.
 */
function monthOf(date: string): string {
  return (dayLabel(date).split(" ")[2] ?? "").slice(0, 3);
}

/**
 * A balance as the grid prints it: the same characters, with a place to break
 * after each thousands comma. A seven figure balance does not fit a cell at
 * 480px of pane, and broken there it still reads as groups of a number rather
 * than as a number cut in the middle of a group.
 */
function breakable(figure: string): ReactNode {
  const groups = figure.split(",");
  return groups.map((group, index) => (
    <Fragment key={index}>
      {group}
      {index < groups.length - 1 && (
        <>
          ,<wbr />
        </>
      )}
    </Fragment>
  ));
}

/**
 * The words a day carries besides its figure. Every day under zero is `low` in
 * the view, so `low` cannot pick out the one lowest day: that is the day whose
 * label is the view's `lowest.date`, and it alone says "Lowest".
 */
function flagsOf(cell: MoneyCell, lowestDate: string | null): string[] {
  const words: string[] = [];
  if (cell.balance !== null && lowestDate !== null && dayLabel(cell.date) === lowestDate) {
    words.push(MONEY_COPY.lowest);
  }
  if (cell.negative) words.push(MONEY_COPY.underZero);
  return words;
}

const yes = (value: boolean): "" | undefined => (value ? "" : undefined);

/** "Lowest", "Under zero": the words that say what the danger mark says. */
function Flags({ words }: { words: string[] }) {
  if (words.length === 0) return null;
  return (
    <span className="v2-money-flags">
      {words.map((word) => (
        <span key={word} className="v2-money-flag">
          {word}
        </span>
      ))}
    </span>
  );
}

/** What is firm on the day: a short quiet line each, the amount then its sign word. */
function Marks({ cell }: { cell: MoneyCell }) {
  if (cell.marks.length === 0) return null;
  return (
    <ul className="v2-money-marks" role="list">
      {cell.marks.map((mark) => (
        // A day holds at most one mark of each kind: money in, then money out.
        <li key={mark.kind} className="v2-money-mark" data-kind={mark.kind}>
          {mark.label} {MONEY_COPY.sign[mark.kind]}
        </li>
      ))}
    </ul>
  );
}

/**
 * One day of the grid. Its number (and the month, on the first day and on
 * each 1st) is drawn for the eye and its full name is read; a day the source
 * has no row for keeps its place with no figure. Not a control.
 */
function GridCell({
  cell,
  first,
  lowestDate,
}: {
  cell: MoneyCell;
  first: boolean;
  lowestDate: string | null;
}) {
  if (!cell.inRange) return <li className="v2-money-cell" data-pad="" aria-hidden="true" />;
  const flags = flagsOf(cell, lowestDate);
  const month = first || cell.dayOfMonth === 1 ? monthOf(cell.date) : null;
  return (
    <li
      className="v2-money-cell"
      data-blank={yes(cell.balance === null)}
      data-today={yes(cell.isToday)}
      data-lowest={yes(flags.includes(MONEY_COPY.lowest))}
      data-negative={yes(cell.negative)}
      aria-current={cell.isToday ? "date" : undefined}
    >
      <span className="v2-hidden">{dayLabel(cell.date)}</span>{" "}
      <span className="v2-money-dhead" aria-hidden="true">
        <span className="v2-money-dnum">{cell.dayOfMonth}</span>
        {month !== null && <span className="v2-money-month">{month}</span>}
      </span>
      {cell.balance !== null && <span className="v2-money-fig">{breakable(cell.balance)}</span>}{" "}
      <Flags words={flags} />
      <Marks cell={cell} />
    </li>
  );
}

/** One day of the list: the date and the balance on a line, its words and marks under it. */
function ListDay({ cell, lowestDate }: { cell: MoneyCell; lowestDate: string | null }) {
  const flags = flagsOf(cell, lowestDate);
  return (
    <li
      className="v2-money-day"
      data-today={yes(cell.isToday)}
      data-lowest={yes(flags.includes(MONEY_COPY.lowest))}
      data-negative={yes(cell.negative)}
      aria-current={cell.isToday ? "date" : undefined}
    >
      <span className="v2-money-date">{dayLabel(cell.date)}</span>{" "}
      {cell.balance !== null && <span className="v2-money-fig">{cell.balance}</span>}{" "}
      <Flags words={flags} />
      <Marks cell={cell} />
    </li>
  );
}

/**
 * The balance day by day, as the source forecast it.
 *
 * BOTH LAYOUTS ARE IN THE DOCUMENT and the pane's own width picks one
 * (money.css): the days as a list under 480px of pane, a month grid from there.
 * The other is `display: none`, so it is out of the tab order and out of the
 * accessibility tree, and no script measures anything.
 *
 * WHAT THE EYE SHOULD FIND: today, marked as the calendar marks it, and the
 * lowest day, which the line at the top names and the days mark with a word.
 * Every day under zero says so in words too, never by colour alone. The
 * sentence about the estimate is the last thing in the pane, always: the
 * balances are guesses and the pane says so under them.
 */
export function ForecastPane({ options }: PaneBodyProps) {
  const { money } = useDeskData();
  const span = forecastSpan(options.span);
  const view = useMemo(
    () => (money === null ? null : buildForecastView(money, span)),
    [money, span],
  );
  if (view === null) return <NoMoney />;

  const drawn = drawnOf(view);
  const lowestDate = view.lowest?.date ?? null;
  const firstDay = drawn.cells.findIndex((cell) => cell.inRange);

  return (
    <div className="v2-money v2-money-forecast" data-stale={staleMark(view.age)}>
      <MoneyAgeLine age={view.age} />
      {view.empty ? (
        <p className="v2-money-empty">{MONEY_COPY.empty.forecast}</p>
      ) : (
        <>
          {view.lowest !== null && (
            <p className="v2-money-lowest">
              <span className="v2-money-label">{MONEY_COPY.lowest}</span>{" "}
              <span className="v2-money-fig">{view.lowest.balance}</span>{" "}
              <span className="v2-money-when">{view.lowest.date}</span> <LastKnown age={view.age} />
            </p>
          )}

          <div className="v2-money-grid">
            <p className="v2-money-wkdays" aria-hidden="true">
              {view.weekdays.map((weekday) => (
                <span key={weekday}>{weekday}</span>
              ))}
            </p>
            <ol className="v2-money-cells" role="list">
              {drawn.cells.map((cell, index) => (
                <GridCell
                  key={cell.date}
                  cell={cell}
                  first={index === firstDay}
                  lowestDate={lowestDate}
                />
              ))}
            </ol>
          </div>

          <ol className="v2-money-days" role="list">
            {drawn.list.map((cell) => (
              <ListDay key={cell.date} cell={cell} lowestDate={lowestDate} />
            ))}
          </ol>

          {drawn.endsOn !== null && (
            <p className="v2-money-ends">{MONEY_COPY.endsOn.replace("{date}", drawn.endsOn)}</p>
          )}
        </>
      )}
      <p className="v2-money-estimate">{view.estimate}</p>
    </div>
  );
}
