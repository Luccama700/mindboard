"use client";

import { useMemo, type CSSProperties } from "react";

import { identityTokens } from "@/app/lib/v2/view/appearance";
import { DESK_COPY } from "@/app/lib/v2/view/desk";
import {
  QUESTS_COPY,
  buildQuestsView,
  type QuestItem,
  type QuestSpan,
  type QuestsView,
} from "@/app/lib/v2/view/quests";
import { useDeskData } from "../../_desk/desk-data-provider";
import { useAppearance } from "../appearance-root";
import { useDay } from "../day-provider";

// What every Quests pane shares: the view, the sentence for a source that has no
// quests, and the row a step or a side quest is drawn as.
//
// QUESTS READS EXACTLY WHAT TODAY READS. Each pane builds its part with
// `buildQuestsView` on the desk's quests (the very planner input Today plans
// from) and the day provider's `workedIds` (the very set Today's plan on screen
// gives), and prints what that returns. Nothing here counts, ranks or dates
// anything of its own.

/** The span every pane but Done lately reads the view with. */
export const QUEST_DEFAULT_SPAN: QuestSpan = 14;

/**
 * The Quests view for this desk and the plan on screen, or null when the source
 * cannot speak about quests. Built again only when the data or the set of
 * worked tasks changes, so a press on Today reaches every Quests pane in the
 * same render that moved the line.
 */
export function useQuestsView(span: QuestSpan): QuestsView | null {
  const { quests } = useDeskData();
  const { workedIds } = useDay();
  return useMemo(
    () => (quests === null ? null : buildQuestsView(quests, workedIds, span)),
    [quests, workedIds, span],
  );
}

/** The desk's one sentence for a source that cannot speak about quests. */
export function NoQuests() {
  return <p className="v2-pane-note">{DESK_COPY.noQuests}</p>;
}

/** One sentence in place of a list that has nothing in it. */
export function QuestsNote({ text }: { text: string }) {
  return <p className="v2-pane-note">{text}</p>;
}

/**
 * The identity tokens a row or a lane sets from its own colour, or nothing for
 * something with no identity: `identityTokens(null)` answers the accent, and a
 * row that belongs to nothing must not wear a colour as if it did.
 */
export function useIdentityStyle(color: string | null): CSSProperties | undefined {
  const { tokens } = useAppearance();
  return color === null ? undefined : (identityTokens(color, tokens) as CSSProperties);
}

/**
 * Where an item's date stands, as a word with its kind on it: past, today or
 * soon. A date further off, or none, says nothing. The kind is what the sheet
 * marks (a dot beside the word), so the mark is never a colour alone.
 */
export function WhenMark({ when }: { when: QuestItem["when"] }) {
  const word = QUESTS_COPY.when[when];
  if (word === "") return null;
  return (
    <span className="v2-quests-when" data-when={when}>
      {word}
    </span>
  );
}

/**
 * Beside a step with a block done today. WORKED ON, NOT FINISHED: a done block
 * served its task for the day and says nothing about whether the task is over,
 * so the step keeps its place, its brightness and its lane's count, and only
 * gains these words.
 */
export function WorkedMark() {
  return <span className="v2-quests-worked">{QUESTS_COPY.worked}</span>;
}

/**
 * One open step or side quest, read only.
 *
 * STACKED, as the side lists draw a row: the title owns the full width (two
 * lines at most, the whole of it on hover), the detail under it in the quiet
 * ink, the worked phrase when there is one, and one quiet line at the foot:
 * what it belongs to at the left, where its date stands and the date at the
 * right. Nothing in it presses.
 *
 * `named` false leaves the identity's name off the foot line: a row under a
 * heading that already names it (the steps grouped) would say it twice. The row
 * still wears its colour.
 */
export function QuestRow({ item, named = true }: { item: QuestItem; named?: boolean }) {
  const style = useIdentityStyle(item.identity?.color ?? null);
  const identity = named ? item.identity : null;
  return (
    <li
      className="v2-quests-row"
      data-when={item.when}
      data-worked={item.worked ? "" : undefined}
      style={style}
    >
      <b className="v2-quests-title" title={item.title}>
        {item.title}
      </b>
      {item.detail !== null && (
        <p className="v2-quests-detail" title={item.detail}>
          {item.detail}
        </p>
      )}
      {item.worked && <WorkedMark />}
      {(identity !== null || item.due !== null) && (
        <p className="v2-quests-meta">
          {identity !== null && <span className="v2-quests-ident">{identity.label}</span>}{" "}
          {item.due !== null && (
            <span className="v2-quests-due">
              <WhenMark when={item.when} />{" "}
              <span className="v2-quests-date">{item.due}</span>
            </span>
          )}
        </p>
      )}
    </li>
  );
}

/** Rows in the order given, as one list. */
export function QuestRows({
  items,
  named = true,
}: {
  items: readonly QuestItem[];
  /** False under a heading that already names what the rows belong to. */
  named?: boolean;
}) {
  return (
    <ol className="v2-quests-rows" role="list">
      {items.map((item) => (
        <QuestRow key={item.id} item={item} named={named} />
      ))}
    </ol>
  );
}
