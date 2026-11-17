// The Money panes, by pane id.
//
// Five bodies over the desk's money and the day's own plan. Four read
// `useDeskData().money` and say so in one sentence when the source holds none;
// Hours reads the planner's input and the plan on screen, and needs no money
// data at all. Each leads with how old its numbers are when they are old (see
// money-age.tsx), and none of them holds a control or a live region.

import type { PaneBody } from "@/app/v2/_desk/pane-body";
import { AccountsPane } from "./accounts-pane";
import { ComingUpPane } from "./coming-up-pane";
import { ForecastPane } from "./forecast-pane";
import { HoursPane } from "./hours-pane";
import { LedgerPane } from "./ledger-pane";

export const MONEY_PANE_BODIES: Readonly<Record<string, PaneBody>> = {
  forecast: ForecastPane,
  accounts: AccountsPane,
  "coming-up": ComingUpPane,
  hours: HoursPane,
  ledger: LedgerPane,
};
