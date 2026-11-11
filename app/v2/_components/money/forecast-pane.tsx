"use client";

import { Fragment, useMemo, type ReactNode } from "react";

import type { DateKey } from "@/app/lib/v2/types";
import { dayLabel } from "@/app/lib/v2/view/format";
import {
  MONEY_COPY,
  buildForecastView,
  forecastSpan,
  type MoneyCell,
} from "@/app/lib/v2/view/money";
import { useDeskData } from "../../_desk/desk-data-provider";
import type { PaneBodyProps } from "../../_desk/pane-body";
import { LastKnown, MoneyAgeLine, NoMoney, staleMark } from "./money-age";

/**
 * A balance as the grid prints it: the same characters, with a place to break
 * after each thousands comma. A seven figure balance does not fit a cell at
 * 480px of pane, and broken there it still reads as groups of a number rather
 * than as a number cut in the middle of a group. With no comma it adds nothing.
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
 * key is the view's `lowest.dateKey`, and it alone says "Lowest".
 */
function flagsOf(cell: MoneyCell, lowestKey: DateKey | null): string[] {
  const words: string[] = [];
  if (cell.date === lowestKey) words.push(MONEY_COPY.lowest);
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
 * One day of the grid. Its number (and the month, where the view names one)
 * is drawn for the eye and its full name is read; a day the source has no row
 * for keeps its place with no figure. Not a control.
 */
function GridCell({ cell, lowestKey }: { cell: MoneyCell; lowestKey: DateKey | null }) {
  if (!cell.inRange) return <li className="v2-money-cell" data-pad="" aria-hidden="true" />;
  const flags = flagsOf(cell, lowestKey);
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
        {cell.month !== null && <span className="v2-money-month">{cell.month}</span>}
      </span>
      {cell.balance !== null && <span className="v2-money-fig">{breakable(cell.balance)}</span>}{" "}
      <Flags words={flags} />
      <Marks cell={cell} />
    </li>
  );
}

/** One day of the list: the date and the balance on a line, its words and marks under it. */
function ListDay({ cell, lowestKey }: { cell: MoneyCell; lowestKey: DateKey | null }) {
  const flags = flagsOf(cell, lowestKey);
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
 * IT DRAWS WHAT IT IS HANDED. The view decides which weeks and days there are
 * (up to the source's last row, never a tail of empty weeks), where the
 * forecast ends, which day is the lowest and where a month is named; the pane
 * lays those out and words the dates.
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

  const lowestKey = view.lowest?.dateKey ?? null;

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
              {view.weeks.flat().map((cell) => (
                <GridCell key={cell.date} cell={cell} lowestKey={lowestKey} />
              ))}
            </ol>
          </div>

          <ol className="v2-money-days" role="list">
            {view.list.map((cell) => (
              <ListDay key={cell.date} cell={cell} lowestKey={lowestKey} />
            ))}
          </ol>

          {view.endsOn !== null && (
            <p className="v2-money-ends">
              {MONEY_COPY.endsOn.replace("{date}", dayLabel(view.endsOn))}
            </p>
          )}
        </>
      )}
      <p className="v2-money-estimate">{view.estimate}</p>
    </div>
  );
}
