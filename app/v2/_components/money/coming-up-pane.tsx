"use client";

import { useMemo } from "react";

import { MONEY_COPY, buildComingView, inDaysLabel, type MoneySpan } from "@/app/lib/v2/view/money";
import { useDeskData } from "../../_desk/desk-data-provider";
import { MoneyAgeLine, NoMoney, staleMark } from "./money-age";

/**
 * How far ahead this pane looks. It takes no option of its own, so it looks as
 * far as the forecast does by default, and a bill named here is the same bill
 * on the same day as in the forecast (the view resolves both from one place).
 */
const COMING_SPAN: MoneySpan = 30;

/**
 * Bills and pay with a date, in date order, each a row as the side lists draw
 * one: the name and the amount on top, its sign word after it ("50 out"), and
 * under them the date and how far off it is. Not a control.
 */
export function ComingUpPane() {
  const { money } = useDeskData();
  const view = useMemo(() => (money === null ? null : buildComingView(money, COMING_SPAN)), [money]);
  if (view === null) return <NoMoney />;

  return (
    <div className="v2-money v2-money-coming-up" data-stale={staleMark(view.age)}>
      <MoneyAgeLine age={view.age} />
      {view.empty ? (
        <p className="v2-money-empty">{MONEY_COPY.empty.coming}</p>
      ) : (
        <ol className="v2-money-coming" role="list">
          {view.items.map((item) => (
            <li key={item.id} className="v2-money-due" data-kind={item.kind}>
              <span className="v2-money-name">{item.name}</span>{" "}
              <span className="v2-money-amt">
                <span className="v2-money-fig">{item.amount}</span>{" "}
                <span className="v2-money-sign">{MONEY_COPY.sign[item.kind]}</span>
              </span>{" "}
              <span className="v2-money-date">{item.date}</span>{" "}
              <span className="v2-money-when">{inDaysLabel(item.inDays)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
