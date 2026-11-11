"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";

import {
  BUILT_IN_LAYOUTS,
  MAX_LAYOUTS,
  isChanged,
  removeLayout,
  setHidden,
  type LayoutId,
  type LayoutMeta,
  type ScreenClass,
  type TileSet,
} from "@/app/lib/v2/tiles";
import { DESK_COPY, deskLine } from "@/app/lib/v2/view/desk";
import type { LayoutAction } from "./use-tiles";

// The layouts, and the way to manage them, in one calm column: on the rail
// from 1024px, and in the phone's sheet under the top bar.
//
// AT REST it is the list of anchors it always was (LayoutLinks, desk-rail.tsx),
// with a quiet mark on a layout that differs from its default on the screen
// size shown, and one small control: Edit. EDITING, the same column lists every
// layout (the hidden built in ones too, marked), each a disclosure whose
// actions open under it: Move up and Move down; Rename and Delete for one of
// the user's own; Hide or Show for a built in one; and Reset when it is changed
// on this screen size. Delete and Reset ask once, in place, never in a browser
// dialog. "New layout from this one" sits at the foot, or, when the desk holds
// twelve, the sentence that says so.
//
// THE ENGINE DECIDES. Every action is one engine call through the reducer
// (`onLayout`). Whether an action is offered is the engine's answer too: Reset
// when `isChanged`, Hide when `setHidden` would change the desk, Delete when
// `removeLayout` would. A name goes to the engine as it was typed; the engine
// cleans it (an emoji is kept), and nothing here cuts it.

/** What the desk does with a layout action, and where the focus goes when the pressed control is gone. */
export type OnLayout = (
  action: LayoutAction,
  pressed: HTMLElement,
  fallback: (after: TileSet) => HTMLElement | null,
) => TileSet | null;

type Mode =
  | { kind: "rename"; id: LayoutId }
  | { kind: "remove"; id: LayoutId }
  | { kind: "reset"; id: LayoutId }
  | { kind: "new" }
  | null;

function isBuiltIn(id: LayoutId): boolean {
  return BUILT_IN_LAYOUTS.some((meta) => meta.id === id);
}

/** A field's keys: Enter saves, Escape cancels and goes no further (the sheet would close on it). */
function fieldKey(
  event: KeyboardEvent<HTMLInputElement>,
  onSave: (field: HTMLElement) => void,
  onCancel: () => void,
): void {
  if (event.key === "Enter") {
    event.preventDefault();
    onSave(event.currentTarget);
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  }
}

/**
 * The list to manage the layouts, and its foot. `target` is the class an
 * action falls on (Reset, and what a new layout copies): the class on screen.
 */
function EditList({
  set,
  target,
  idBase,
  onLayout,
  toggle,
}: {
  set: TileSet;
  target: ScreenClass;
  idBase: string;
  onLayout: OnLayout;
  toggle: () => HTMLElement | null;
}) {
  const [open, setOpen] = useState<LayoutId | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [draft, setDraft] = useState("");
  const list = useRef<HTMLUListElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const answer = useRef<HTMLButtonElement>(null);

  // A field or a question takes the focus as it opens: the press that opened
  // it is answered there.
  useEffect(() => {
    if (mode === null) return;
    if (mode.kind === "rename" || mode.kind === "new") {
      field.current?.focus();
      field.current?.select();
    }
    else answer.current?.focus();
  }, [mode]);

  const row = (id: LayoutId, part: string): HTMLElement | null =>
    // `:scope >` because an ancestor in a selector may match outside the
    // element searched, and the desk's own root carries a `data-layout` too.
    list.current?.querySelector<HTMLElement>(`:scope > li[data-layout="${id}"] [data-part="${part}"]`) ?? null;
  const nameOf = (id: LayoutId) => row(id, "name");

  /** Close what is open in a row first, so a control that goes with it is gone before the focus is placed. */
  const settle = (next: Mode) => flushSync(() => setMode(next));

  const act = (action: LayoutAction, pressed: HTMLElement, fallback: (after: TileSet) => HTMLElement | null) =>
    onLayout(action, pressed, fallback);

  const actionsId = (id: LayoutId) => `${idBase}-${id}`;

  const actionsOf = (meta: LayoutMeta, index: number) => {
    const builtIn = isBuiltIn(meta.id);
    const hidden = set.hidden.includes(meta.id);
    const first = index === 0;
    const last = index === set.layouts.length - 1;
    const canToggle = setHidden(set, meta.id, !hidden) !== set;
    const canRemove = !builtIn && removeLayout(set, meta.id) !== set;
    const changed = isChanged(set, meta.id, target);
    const here = mode !== null && mode.kind !== "new" && mode.id === meta.id ? mode.kind : null;

    if (here === "rename") {
      const save = (pressed: HTMLElement) => {
        const title = draft;
        settle(null);
        act({ type: "renameLayout", id: meta.id, title }, pressed, () => row(meta.id, "rename"));
      };
      const cancel = () => {
        settle(null);
        row(meta.id, "rename")?.focus();
      };
      return (
        <div key="rename" className="v2-desk-edit-field">
          <input
            ref={field}
            type="text"
            aria-label={deskLine(DESK_COPY.renameField, { layout: meta.title })}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => fieldKey(event, save, cancel)}
          />
          <button type="button" onClick={(event) => save(event.currentTarget)}>
            {DESK_COPY.save}
          </button>
          <button type="button" onClick={cancel}>
            {DESK_COPY.cancel}
          </button>
        </div>
      );
    }

    if (here === "remove" || here === "reset") {
      const removing = here === "remove";
      const confirm = (pressed: HTMLElement) => {
        settle(null);
        if (removing) {
          const at = set.layouts.findIndex((other) => other.id === meta.id);
          const neighbour = set.layouts[at + 1] ?? set.layouts[at - 1];
          act({ type: "removeLayout", id: meta.id }, pressed, () =>
            neighbour === undefined ? toggle() : nameOf(neighbour.id),
          );
        } else {
          act({ type: "resetLayout", id: meta.id, cls: target }, pressed, () => nameOf(meta.id));
        }
      };
      const keep = () => {
        settle(null);
        row(meta.id, here)?.focus();
      };
      return (
        <div key={here} className="v2-desk-edit-ask" role="group" aria-label={meta.title}>
          <p>
            {deskLine(removing ? DESK_COPY.confirmRemove : DESK_COPY.confirmReset, { layout: meta.title })}
          </p>
          <button type="button" data-part="confirm" onClick={(event) => confirm(event.currentTarget)}>
            {removing ? DESK_COPY.remove : DESK_COPY.resetConfirm}
          </button>
          <button type="button" ref={answer} onClick={keep}>
            {DESK_COPY.keep}
          </button>
        </div>
      );
    }

    const move = (pressed: HTMLElement, to: number, allowed: boolean) => {
      if (!allowed) return;
      act({ type: "moveLayout", id: meta.id, to }, pressed, () => nameOf(meta.id));
    };

    return (
      // Each state of a row has its own key: without them React would reuse the
      // pressed button of one state as a different button of the next, and the
      // focus would stay on something that was never pressed.
      <div key="actions" className="v2-desk-edit-actions" role="group" aria-label={meta.title}>
        <button
          type="button"
          data-part="up"
          aria-disabled={first}
          onClick={(event) => move(event.currentTarget, index - 1, !first)}
        >
          {DESK_COPY.moveUp}
        </button>
        <button
          type="button"
          data-part="down"
          aria-disabled={last}
          onClick={(event) => move(event.currentTarget, index + 1, !last)}
        >
          {DESK_COPY.moveDown}
        </button>
        {builtIn ? (
          <button
            type="button"
            data-part="hide"
            aria-disabled={!canToggle}
            onClick={(event) => {
              if (!canToggle) return;
              act({ type: "hideLayout", id: meta.id, hidden: !hidden }, event.currentTarget, () =>
                nameOf(meta.id),
              );
            }}
          >
            {hidden ? DESK_COPY.show : DESK_COPY.hide}
          </button>
        ) : (
          <>
            <button
              type="button"
              data-part="rename"
              onClick={() => {
                setDraft(meta.title);
                setMode({ kind: "rename", id: meta.id });
              }}
            >
              {DESK_COPY.rename}
            </button>
            {canRemove && (
              <button type="button" data-part="remove" onClick={() => setMode({ kind: "remove", id: meta.id })}>
                {DESK_COPY.remove}
              </button>
            )}
          </>
        )}
        {changed && (
          <button type="button" data-part="reset" onClick={() => setMode({ kind: "reset", id: meta.id })}>
            {DESK_COPY.reset}
          </button>
        )}
      </div>
    );
  };

  const full = set.layouts.length >= MAX_LAYOUTS;
  const making = mode !== null && mode.kind === "new";
  const make = (pressed: HTMLElement) => {
    const title = draft;
    settle(null);
    act({ type: "addLayout", title, from: set.current, cls: target }, pressed, (after) => nameOf(after.current));
  };
  const stopMaking = () => {
    settle(null);
    list.current?.parentElement?.querySelector<HTMLElement>('[data-part="new"]')?.focus();
  };

  return (
    <>
      <ul ref={list} className="v2-desk-edit">
        {set.layouts.map((meta, index) => {
          const expanded = open === meta.id;
          const hidden = set.hidden.includes(meta.id);
          return (
            <li key={meta.id} data-layout={meta.id} aria-current={meta.id === set.current ? "true" : undefined}>
              <button
                type="button"
                className="v2-desk-edit-name"
                data-part="name"
                aria-expanded={expanded}
                aria-controls={actionsId(meta.id)}
                onClick={() => {
                  setOpen(expanded ? null : meta.id);
                  setMode(null);
                }}
              >
                <span className="v2-desk-edit-title">{meta.title}</span>
                {hidden && <span className="v2-desk-edit-note">{DESK_COPY.hidden}</span>}
                {isChanged(set, meta.id, target) && (
                  <span className="v2-desk-edit-note">{DESK_COPY.changed}</span>
                )}
              </button>
              <div id={actionsId(meta.id)} hidden={!expanded}>
                {expanded && actionsOf(meta, index)}
              </div>
            </li>
          );
        })}
      </ul>
      {full ? (
        <p className="v2-desk-edit-limit">{DESK_COPY.layoutLimit}</p>
      ) : making ? (
        <div className="v2-desk-edit-field v2-desk-edit-new">
          <input
            ref={field}
            type="text"
            aria-label={DESK_COPY.newField}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => fieldKey(event, make, stopMaking)}
          />
          <button type="button" onClick={(event) => make(event.currentTarget)}>
            {DESK_COPY.save}
          </button>
          <button type="button" onClick={stopMaking}>
            {DESK_COPY.cancel}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="v2-desk-edit-make"
          data-part="new"
          onClick={() => {
            setDraft("");
            setMode({ kind: "new" });
          }}
        >
          {DESK_COPY.newLayout}
        </button>
      )}
    </>
  );
}

/**
 * The control that turns the list into the list to manage it, and back. Its
 * name says what it does in the words it shows.
 */
export function EditToggle({
  editing,
  controls,
  onToggle,
}: {
  editing: boolean;
  controls: string;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      className="v2-desk-edit-toggle"
      aria-expanded={editing}
      aria-controls={controls}
      aria-label={editing ? DESK_COPY.doneEditingName : DESK_COPY.editLayoutsName}
      onClick={onToggle}
    >
      {editing ? DESK_COPY.doneEditing : DESK_COPY.editLayouts}
    </button>
  );
}

/**
 * The layouts in one column, at rest or being managed. `links` is the list at
 * rest (the anchors); `heading` is drawn above it on the rail, where the toggle
 * sits beside it; in the phone's sheet the toggle is at the foot.
 */
export function LayoutMenu({
  set,
  cls,
  where,
  links,
  onLayout,
}: {
  set: TileSet;
  cls: ScreenClass | null;
  where: "rail" | "sheet";
  links: ReactNode;
  onLayout: OnLayout;
}) {
  const [editing, setEditing] = useState(false);
  const idBase = useId();
  const region = `${idBase}-layouts`;
  const toggleRef = useRef<HTMLDivElement>(null);
  const target: ScreenClass = cls ?? (where === "sheet" ? "compact" : "regular");
  const toggle = (
    <div ref={toggleRef} className="v2-desk-edit-toggle-row">
      <EditToggle editing={editing} controls={region} onToggle={() => setEditing((was) => !was)} />
    </div>
  );
  const findToggle = () => toggleRef.current?.querySelector<HTMLElement>("button") ?? null;

  return (
    <>
      {where === "rail" && (
        <div className="v2-desk-rail-headrow">
          <h2 className="v2-desk-rail-head">{DESK_COPY.layouts}</h2>
          {toggle}
        </div>
      )}
      <div id={region} className="v2-desk-layout-region" data-editing={editing ? "" : undefined}>
        {editing ? (
          <EditList set={set} target={target} idBase={idBase} onLayout={onLayout} toggle={findToggle} />
        ) : (
          links
        )}
      </div>
      {where === "sheet" && toggle}
    </>
  );
}
