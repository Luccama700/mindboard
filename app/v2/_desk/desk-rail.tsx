"use client";

import type { MouseEvent } from "react";

import {
  isChanged,
  type LayoutId,
  type PaneGroup,
  type PaneId,
  type ScreenClass,
  type TileSet,
} from "@/app/lib/v2/tiles";
import { DESK_COPY } from "@/app/lib/v2/view/desk";
import { AppearanceTrigger } from "../_components/appearance-root";
import { useDeskData } from "./desk-data-provider";
import { LayoutMenu, type OnLayout } from "./layout-menu";
import { deskHref } from "./use-tiles";
import { SCREEN_CLASSES, type DeskStage } from "./workspace";

/** The pane list's groups, in the order the rail shows them, with their names. */
const GROUPS: ReadonlyArray<{ group: PaneGroup; name: string }> = [
  { group: "day", name: DESK_COPY.groupDay },
  { group: "quests", name: DESK_COPY.groupQuests },
  { group: "money", name: DESK_COPY.groupMoney },
];

/**
 * A press on a layout's anchor, kept in the browser: an unmodified primary
 * click opens the layout without a request, so the day's presses are kept.
 * Anything else (a middle click, a click with a modifier, a page without
 * script) is the anchor's own, and loads the address from the server.
 */
function pressed(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/** The classes a layout differs from its default on: the engine's `isChanged`, class by class. */
export function changedIn(set: TileSet, layout: LayoutId): ScreenClass[] {
  return SCREEN_CLASSES.filter((cls) => isChanged(set, layout, cls));
}

/**
 * The layouts the desk shows, in the rail's order, as anchors to their own
 * addresses. The one on screen says so with `aria-current`. A layout that
 * differs from its default carries a quiet mark, written for every class it
 * differs on (`data-changed`) and drawn by desk.css for the class shown, and
 * read as part of its name there.
 */
export function LayoutLinks({
  set,
  date,
  week = null,
  onOpen,
  id,
  className,
  hidden,
}: {
  set: TileSet;
  date: string | null;
  /** The week on screen, when the request asked for one the calendar used. */
  week?: string | null;
  onOpen(layout: LayoutId): void;
  id?: string;
  className: string;
  hidden?: boolean;
}) {
  const visible = set.layouts.filter((meta) => !set.hidden.includes(meta.id));
  return (
    <ul id={id} className={className} hidden={hidden}>
      {visible.map((meta) => {
        const changed = changedIn(set, meta.id).join(" ");
        return (
          <li key={meta.id}>
            <a
              href={deskHref(meta.id, date, week)}
              aria-current={meta.id === set.current ? "page" : undefined}
              data-changed={changed === "" ? undefined : changed}
              onClick={(event) => {
                if (!pressed(event)) return;
                event.preventDefault();
                onOpen(meta.id);
              }}
            >
              {meta.title}
              {changed !== "" && (
                <span className="v2-desk-changed">
                  <span className="v2-hidden">, {DESK_COPY.changed}</span>
                </span>
              )}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The day's notice and the notes of the parts the source could not read: once,
 * on the rail on a big screen and under the top bar on a phone, never per pane.
 */
export function DeskNotes({ where }: { where: "rail" | "compact" }) {
  const { today, notes } = useDeskData();
  const lines = today.notice === null ? notes : [today.notice, ...notes];
  if (lines.length === 0) return null;
  return (
    <div className={`v2-desk-notes v2-desk-notes-${where}`}>
      {lines.map((line, index) => (
        <p key={`${index}-${line}`}>{line}</p>
      ))}
    </div>
  );
}

/**
 * The longest title the rail's pane list shows whole. Past it, a title wraps at
 * the rail's 128px ("Past their date", "Did not fit today"), so the list shows
 * the catalog's short label and keeps the title as what is read.
 */
export const RAIL_TITLE_MAX = 12;

/** A pane's name on the rail: its title, or its short label when the title would wrap. */
function railName(title: string, short: string) {
  if (title.length <= RAIL_TITLE_MAX) return <span className="v2-desk-pane-name">{title}</span>;
  return (
    <>
      <span className="v2-desk-pane-name" aria-hidden="true">
        {short}
      </span>
      <span className="v2-hidden">{title}</span>
    </>
  );
}

/**
 * The rail, from 1024px: the layouts, the panes by group with a mark on the
 * ones open in the layout on screen, the notes, and the appearance panel at its
 * foot.
 *
 * The marks are written for both tiled classes (`data-open`) and desk.css shows
 * the class that applies, because the server cannot know which it is. Each pane
 * is a control: a closed one opens where it was, an open one is brought to the
 * front and takes the focus.
 */
export function DeskRail({
  set,
  stage,
  cls = null,
  date,
  week = null,
  onOpen,
  onPane,
  onLayout,
}: {
  set: TileSet;
  stage: DeskStage;
  cls?: ScreenClass | null;
  date: string | null;
  week?: string | null;
  onOpen(layout: LayoutId): void;
  onPane?(pane: PaneId, pressed: HTMLElement): void;
  onLayout?: OnLayout;
}) {
  return (
    <nav className="v2-desk-rail" aria-label={DESK_COPY.rail}>
      <LayoutMenu
        set={set}
        cls={cls}
        where="rail"
        onLayout={onLayout ?? NO_LAYOUT}
        links={<LayoutLinks set={set} date={date} week={week} onOpen={onOpen} className="v2-desk-layouts" />}
      />
      <h2 className="v2-desk-rail-head v2-desk-panes-head">{DESK_COPY.panes}</h2>
      {GROUPS.map(({ group, name }) => (
        <div key={group} className="v2-desk-group">
          <h3>{name}</h3>
          <ul>
            {stage.frames
              .filter((frame) => frame.pane.group === group)
              .map((frame) => (
                <li
                  key={frame.pane.id}
                  className="v2-desk-pane"
                  data-pane={frame.pane.id}
                  data-open={frame.open.join(" ")}
                >
                  <button
                    type="button"
                    className="v2-desk-pane-button"
                    onClick={(event) => onPane?.(frame.pane.id, event.currentTarget)}
                  >
                    {railName(frame.pane.title, frame.pane.short)}
                    <span className="v2-desk-open">
                      <span className="v2-desk-open-dot" aria-hidden="true" />
                      <span className="v2-hidden"> {DESK_COPY.open}</span>
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ))}
      <DeskNotes where="rail" />
      <AppearanceTrigger variant="rail" />
    </nav>
  );
}

/** A rail drawn with nothing to answer its layout actions (a test) changes nothing. */
const NO_LAYOUT: OnLayout = () => null;
