// The whole sample desk: the sample day, and the quests and the money that go
// with that same day. Invented, deterministic, the same on the server and in
// the browser.

import type { DeskScreenData } from "@/app/lib/v2/view/desk-data";

import { sampleDay } from "./sample-day";
import { sampleMoney } from "./sample-money";
import { sampleQuests } from "./sample-quests";
import { sampleWeek } from "./sample-week";

/** `weekParam` is the `?week=` a calendar link asked for, or null. */
export function sampleDesk(weekParam: string | null): DeskScreenData {
  const day = sampleDay();
  const today = weekParam === null ? day : { ...day, calendar: sampleWeek(weekParam) };
  return {
    today,
    quests: sampleQuests(today),
    money: sampleMoney(today),
    notes: [],
  };
}
