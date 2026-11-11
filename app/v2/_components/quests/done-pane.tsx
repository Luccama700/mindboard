"use client";

import {
  QUESTS_COPY,
  questDoneTotalLabel,
  questPerWeekLabel,
  questSpanLabel,
  questThroughLabel,
  type QuestDoneItem,
  type QuestSpan,
} from "@/app/lib/v2/view/quests";
import { useDeskData } from "../../_desk/desk-data-provider";
import type { PaneBodyProps } from "../../_desk/pane-body";
import { NoQuests, QuestsNote, useIdentityStyle, useQuestsView } from "./quest-row";

/**
 * The `span` option: "7", "14" or "28" days, and 14 for anything else. Each
 * choice is compared as a whole string, never looked up by it.
 */
export function doneSpan(value: string | undefined): QuestSpan {
  if (value === "7") return 7;
  if (value === "28") return 28;
  return 14;
}

/**
 * What was finished lately: the source's own history, and nothing a press on
 * Today did (a done block is work on a task, not its end).
 *
 * In this order, each part only when the view says it:
 *   - the day lately ends on, first, when the history stops before the planned
 *     day (a copy taken days ago cannot speak for the days since);
 *   - a source with no history at all: one sentence, and no number;
 *   - the span, then the total, then the rate as one quiet line of its own,
 *     only when the view gives one. The rate is null when the history does not
 *     cover the span or nothing was finished in it: zero is never a rate, and
 *     a history too short for the span says so instead of a number;
 *   - the days with something in them, newest first, as small headings, with
 *     what was finished under each.
 *
 * No streak, no score, nothing that celebrates: a count and a rate, quietly.
 */
export function DonePane({ options }: PaneBodyProps) {
  const span = doneSpan(options.span);
  const view = useQuestsView(span);
  const { quests } = useDeskData();
  if (view === null || quests === null) return <NoQuests />;

  const { done } = view;
  const through = done.through === null ? null : questThroughLabel(done.through);
  // The view says the span is not known; which of the two sentences is the
  // source's: it keeps no history at all, or one too short for this span.
  if (!done.known && quests.historyThrough === null) {
    return (
      <div className="v2-quests v2-quests-done">
        {through !== null && <p className="v2-quests-through">{through}</p>}
        <QuestsNote text={QUESTS_COPY.noHistory} />
      </div>
    );
  }

  return (
    <div className="v2-quests v2-quests-done">
      {through !== null && <p className="v2-quests-through">{through}</p>}
      <div className="v2-quests-sum">
        <p className="v2-quests-sum-line">
          <span className="v2-quests-span">{questSpanLabel(span)}</span>{" "}
          {done.known && done.total > 0 && (
            <span className="v2-quests-total">{questDoneTotalLabel(done.total)}</span>
          )}
        </p>
        {done.known && done.perWeek !== null && (
          <p className="v2-quests-rate">{questPerWeekLabel(done.perWeek)}</p>
        )}
      </div>
      {!done.known && <QuestsNote text={QUESTS_COPY.shortHistory} />}
      {done.known && done.total === 0 && <QuestsNote text={QUESTS_COPY.doneNone} />}
      {done.days.length > 0 && (
        <div className="v2-quests-days">
          {done.days.map((day) => (
            <div key={day.date} className="v2-quests-day">
              <h3 className="v2-quests-day-head">{day.label}</h3>
              <ul className="v2-quests-done-list" role="list">
                {day.items.map((item) => (
                  <DoneItem key={item.id} item={item} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DoneItem({ item }: { item: QuestDoneItem }) {
  const style = useIdentityStyle(item.identity?.color ?? null);
  return (
    <li className="v2-quests-done-item" style={style}>
      <span className="v2-quests-done-title" title={item.title}>
        {item.title}
      </span>{" "}
      {item.identity !== null && <span className="v2-quests-ident">{item.identity.label}</span>}
    </li>
  );
}
