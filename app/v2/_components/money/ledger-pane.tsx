"use client";

import { useMemo } from "react";

import { MONEY_COPY, buildLedgerView, ledgerRows } from "@/app/lib/v2/view/money";
import { useDeskData } from "../../_desk/desk-data-provider";
import type { PaneBodyProps } from "../../_desk/pane-body";
import { MoneyAgeLine, NoMoney, staleMark } from "./money-age";

/**
 * The newest lines of the ledger, newest first: the date, the note, the
 * account, the category and the amount with its sign word, then how many more
 * there are. One line each from 420px of pane, two under it (money.css), from
 * the same five parts in the same order, so a screen reader hears one sentence
 * per line at any width.
 *
 * THE WHOLE NOTE IS IN THE DOCUMENT. The view hands it over uncut, and the
 * stylesheet's line clamp cuts it where the eye needs it: a screen reader has
 * every word, and nothing hides in a title, which a finger cannot reach. Not a
 * control.
 */
export function LedgerPane({ options }: PaneBodyProps) {
  const { money } = useDeskData();
  const rows = ledgerRows(options.rows);
  const view = useMemo(() => (money === null ? null : buildLedgerView(money, rows)), [money, rows]);
  if (view === null) return <NoMoney />;

  return (
    <div className="v2-money v2-money-ledger" data-stale={staleMark(view.age)}>
      <MoneyAgeLine age={view.age} />
      {view.empty ? (
        <p className="v2-money-empty">{MONEY_COPY.empty.ledger}</p>
      ) : (
        <>
          <ol className="v2-money-txs" role="list">
            {view.rows.map((line) => (
              <li key={line.id} className="v2-money-tx" data-kind={line.kind}>
                <span className="v2-money-tx-date">{line.date}</span>{" "}
                <span className="v2-money-tx-note">{line.note}</span>{" "}
                <span className="v2-money-tx-acct">{line.account}</span>{" "}
                <span className="v2-money-tx-cat">{line.category ?? ""}</span>{" "}
                <span className="v2-money-amt">
                  <span className="v2-money-fig">{line.amount}</span>{" "}
                  <span className="v2-money-sign">{MONEY_COPY.sign[line.kind]}</span>
                </span>
              </li>
            ))}
          </ol>
          {view.more > 0 && (
            <p className="v2-money-more">{MONEY_COPY.more.replace("{count}", String(view.more))}</p>
          )}
        </>
      )}
    </div>
  );
}
