// What the desk is handed, whichever source built it: the sample, a local
// snapshot of an account's own data, or (later) the live stores.
// Pure types only. Every pane codes against these and never against a source.
//
// The desk shows one head, so the three parts are not three fetches of the same
// facts: Quests is handed the very planner input Today plans from, and Money's
// hours come from that input too. Two numbers for one fact on one screen is the
// defect this file exists to make impossible.

import type { DateKey, Instant, LaneKey, PlanInput } from "../types";
import type { ScreenLane, TaskTag, TodayScreenData } from "./screen-data";

// ---------------------------------------------------------------------- quests

/** Something that was finished, as the source's history has it. */
export interface QuestDone {
  /** The task's id. */
  id: string;
  title: string;
  /** The lane its group belongs to, or null for a side quest. */
  lane: LaneKey | null;
  /** The group it lived in, as a task's tag is on Today. */
  tag: TaskTag | null;
  doneAt: Instant;
}

export interface QuestsScreenData {
  /**
   * The SAME planner input the Today screen plans from: the same object, so the
   * same candidates, clock, planned day and rules. Quests ranks and counts from
   * it, which is what makes a lane's count here equal the one on Today.
   */
  input: PlanInput;
  /** The user's lanes, all of them, in their order: also the ones nothing feeds. */
  lanes: ScreenLane[];
  /** Candidate id to its group's name and colour. */
  tags: Record<string, TaskTag>;
  /** What was finished lately, newest first. Empty when the source keeps no history. */
  done: QuestDone[];
  /**
   * How many days back `done` can speak for, counted from the planned day.
   * 0 means the source has no history at all, and then no rate is shown: a rate
   * over days nobody can see would be an invented number.
   */
  historyDays: number;
}

// ----------------------------------------------------------------------- money

export interface MoneyAccount {
  id: string;
  name: string;
  /** "checking", "savings", "credit" and so on, as the source names it. */
  kind: string;
  balance: number;
  currency: string;
}

/** One day of the source's own forecast. */
export interface MoneyDay {
  date: DateKey;
  /** Firm money in: pay with a date. */
  inflow: number;
  /** Firm money out: bills with a date. */
  outflow: number;
  /** The estimate of everyday spending for the day. A guess, and shown as one. */
  everyday: number;
  /** The estimate of a grocery trip on the day. A guess too. */
  groceries: number;
  /** Everything the accounts hold at the end of the day, if the guesses hold. */
  projected: number;
}

/** A bill that repeats, with its schedule in the source's own words. */
export interface MoneyBill {
  id: string;
  name: string;
  amount: number;
  schedule: string;
}

export interface MoneyIncome {
  id: string;
  name: string;
  /** A fixed amount on a day of the month, or null for paid by the hour. */
  fixedMonthly: { amount: number; dayOfMonth: number } | null;
}

/** One line of the ledger. */
export interface MoneyRow {
  id: string;
  on: DateKey;
  direction: "in" | "out";
  amount: number;
  account: string;
  category: string | null;
  note: string;
}

export interface MoneyScreenData {
  /** The day the desk is showing: the planning date, as everywhere else. */
  today: DateKey;
  currency: string;
  /** When the source last read the accounts. */
  takenAt: Instant;
  /**
   * The newest transaction the ledger holds, or null for an empty ledger.
   *
   * EVERY number below is as old as this day. A balance is a ledger's sum, so a
   * ledger that stopped in August is an August balance however recently it was
   * read, and the screen has to say so before it says anything else.
   */
  ledgerLastOn: DateKey | null;
  accounts: MoneyAccount[];
  /** One row per day in order, the first being `today` or the day the source calls today. */
  forecast: MoneyDay[];
  /** How the everyday estimate was made. `confident: false` means a manual guess. */
  everyday: { dailyRate: number; confident: boolean; manualFallback: number | null };
  bills: MoneyBill[];
  income: MoneyIncome[];
  /** The newest ledger rows, newest first. */
  rows: MoneyRow[];
}

// ------------------------------------------------------------------------ desk

export interface DeskScreenData {
  today: TodayScreenData;
  /** Null when the source cannot speak about quests at all. */
  quests: QuestsScreenData | null;
  /** Null when the source holds no money data. The panes then say so. */
  money: MoneyScreenData | null;
  /**
   * One plain sentence per part the source could not read (a literal file name
   * and a fixed phrase, never a path or a value). Empty when everything read.
   */
  notes: string[];
}
