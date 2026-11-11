"use client";

import { useMemo } from "react";

import { MONEY_COPY, buildAccountsView } from "@/app/lib/v2/view/money";
import { useDeskData } from "../../_desk/desk-data-provider";
import { LastKnown, MoneyAgeLine, NoMoney, staleMark } from "./money-age";

/**
 * What each account holds: the total, the one large figure of the Money
 * layout, then a line per account (name left, balance right), then when the
 * accounts were read.
 *
 * A TOTAL ONLY WHEN THERE IS ONE. Accounts in more than one currency have no
 * sum, so the view gives none and says why; then each line says its own
 * currency, because there is no shared one to say once beside the total.
 *
 * The time zone is the desk's own (the day's rules), read from the desk's data:
 * this pane has nothing to do with the day's presses.
 */
export function AccountsPane() {
  const { money, today } = useDeskData();
  const timeZone = today.input.rules.timeZone;
  const view = useMemo(
    () => (money === null ? null : buildAccountsView(money, timeZone)),
    [money, timeZone],
  );
  if (view === null) return <NoMoney />;

  const mixed = view.total === null;

  return (
    <div className="v2-money v2-money-accounts" data-stale={staleMark(view.age)}>
      <MoneyAgeLine age={view.age} />
      {view.empty ? (
        <p className="v2-money-empty">{MONEY_COPY.empty.accounts}</p>
      ) : (
        <>
          <div className="v2-money-total">
            {view.total !== null ? (
              <>
                <p className="v2-money-label">{MONEY_COPY.total}</p>
                <p className="v2-money-sum">
                  <span className="v2-money-big v2-money-fig">{view.total}</span>{" "}
                  <span className="v2-money-cur">{view.currency}</span> <LastKnown age={view.age} />
                </p>
              </>
            ) : (
              <p className="v2-money-note">{view.totalNote}</p>
            )}
          </div>

          <ul className="v2-money-accts" role="list">
            {view.accounts.map((account) => (
              <li key={account.id} className="v2-money-acct">
                <span className="v2-money-name">{account.name}</span>{" "}
                <span className="v2-money-amt">
                  <span className="v2-money-fig">{account.balance}</span>
                  {mixed && (
                    <>
                      {" "}
                      <span className="v2-money-cur">{account.currency}</span>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>

          <p className="v2-money-taken">{view.takenLine}</p>
        </>
      )}
    </div>
  );
}
