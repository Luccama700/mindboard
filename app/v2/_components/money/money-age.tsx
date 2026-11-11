import { DESK_COPY } from "@/app/lib/v2/view/desk";
import { MONEY_COPY, type MoneyAge } from "@/app/lib/v2/view/money";

// What every Money pane says about itself before it says anything else.
//
// THE AGE LINE COMES FIRST. A balance is a ledger's sum, so a ledger that
// stopped weeks ago gives a weeks old balance however recently it was read. The
// view words the sentence once (`moneyAge`) and every pane draws it here, as the
// first element of its root, set apart and in the full ink, so it is the
// loudest text in the pane and nothing in the pane can be read before it.
//
// ONE SWITCH FOR THE REST. The pane's root carries `data-stale` (`staleMark`),
// and money.css quiets every `.v2-money-fig` under it: no pane has to remember
// which of its numbers to dim.

/** The sentence that says how old the pane's numbers are, or nothing when they are current. */
export function MoneyAgeLine({ age }: { age: MoneyAge }) {
  if (age.line === null) return null;
  return <p className="v2-money-age">{age.line}</p>;
}

/** The attribute a pane's root carries when its numbers are old. */
export function staleMark(age: MoneyAge): "" | undefined {
  return age.stale ? "" : undefined;
}

/**
 * The word beside a stale pane's main figure. A list of equals (what is
 * coming, the ledger) has no main figure and does not place it.
 */
export function LastKnown({ age }: { age: MoneyAge }) {
  if (!age.stale) return null;
  return <span className="v2-money-tag">{MONEY_COPY.lastKnownTag}</span>;
}

/** The desk's one sentence for a source that holds no money data. */
export function NoMoney() {
  return <p className="v2-pane-note">{DESK_COPY.noMoney}</p>;
}
