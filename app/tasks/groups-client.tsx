"use client";

import Link from "next/link";
import { useOptimistic, useRef, useState, useTransition } from "react";
import {
  archiveGroup,
  createGroup,
  updateGroup,
} from "@/app/actions/groups";
import type { CalendarListEntry } from "@/utils/google/calendar";
import { ColorPicker, PALETTE } from "@/app/_components/color-picker";
import type { Group } from "./groups-types";

const TYPES: Group["type"][] = ["course", "project", "work", "personal"];

type OptimisticAction =
  | { kind: "archive"; id: string }
  | { kind: "update"; id: string; patch: Partial<Group> };

export function GroupsClient({
  initial,
  calendars,
}: {
  initial: Group[];
  calendars: CalendarListEntry[];
}) {
  const [groups, dispatch] = useOptimistic<Group[], OptimisticAction>(
    initial,
    (state, action) => {
      switch (action.kind) {
        case "archive":
          return state.filter((g) => g.id !== action.id);
        case "update":
          return state.map((g) =>
            g.id === action.id ? { ...g, ...action.patch } : g,
          );
      }
    },
  );

  const [formOpen, setFormOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [pickedType, setPickedType] = useState<Group["type"]>("project");
  const [pickedColor, setPickedColor] = useState<string>(PALETTE[0]);

  function openForm() {
    setFormOpen(true);
    setFormError(null);
    setTimeout(() => nameRef.current?.focus(), 50);
  }

  function closeForm() {
    setFormOpen(false);
    setFormError(null);
    formRef.current?.reset();
    setPickedType("project");
    setPickedColor(PALETTE[0]);
  }

  async function onSubmit(formData: FormData) {
    formData.set("type", pickedType);
    formData.set("color", pickedColor);

    const result = await createGroup(formData);
    if (result.error) {
      setFormError(result.error);
      return;
    }
    closeForm();
  }

  function onArchive(id: string) {
    startTransition(async () => {
      dispatch({ kind: "archive", id });
      await archiveGroup(id);
    });
  }

  function onUpdate(id: string, patch: Partial<Group>) {
    startTransition(async () => {
      dispatch({ kind: "update", id, patch });
      await updateGroup({
        id,
        name: patch.name,
        type: patch.type,
        color: patch.color,
        googleCalendarId:
          patch.google_calendar_id === undefined
            ? undefined
            : patch.google_calendar_id,
      });
    });
  }

  return (
    <div className="space-y-6">
      <Link
        href="/tasks?group=inbox"
        className="block border border-line bg-card hover:bg-card-hover transition-colors"
      >
        <div className="flex items-center gap-3 px-4 py-4">
          <span
            className="w-2 h-10 flex-shrink-0 border-2 border-dashed border-line-subtle"
            aria-hidden
          />
          <div className="flex-1 min-w-0">
            <p className="text-fg text-base font-bold">inbox</p>
            <p className="text-muted text-xs tracking-widest uppercase mt-0.5">
              unsorted
            </p>
          </div>
          <span className="text-muted text-xs">›</span>
        </div>
      </Link>

      {!formOpen ? (
        <button
          onClick={openForm}
          className="w-full text-left bg-transparent border border-dashed border-line-strong hover:border-accent hover:text-accent text-muted text-sm font-bold py-5 px-4 transition-colors"
        >
          + new group
        </button>
      ) : (
        <form
          ref={formRef}
          action={onSubmit}
          className="border border-line bg-card p-4 space-y-5"
        >
          <input
            ref={nameRef}
            name="name"
            type="text"
            placeholder="group name"
            required
            maxLength={64}
            autoComplete="off"
            className="w-full bg-transparent text-fg placeholder-muted text-base font-bold focus:outline-none border-b border-line-strong focus:border-accent pb-2 transition-colors"
          />

          <TypePicker value={pickedType} onChange={setPickedType} />
          <ColorPicker value={pickedColor} onChange={setPickedColor} />

          {formError && <p className="text-danger text-xs">{formError}</p>}

          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              disabled={isPending}
              className="flex-1 bg-accent text-accent-fg text-sm font-bold py-3 hover:opacity-90 transition-colors disabled:opacity-50"
            >
              create
            </button>
            <button
              type="button"
              onClick={closeForm}
              className="px-4 text-muted text-sm hover:text-fg transition-colors"
            >
              cancel
            </button>
          </div>
        </form>
      )}

      <ul className="space-y-2">
        {groups.map((g) => (
          <GroupRow
            key={g.id}
            group={g}
            calendars={calendars}
            onArchive={onArchive}
            onUpdate={onUpdate}
          />
        ))}
      </ul>
    </div>
  );
}

function GroupRow({
  group,
  calendars,
  onArchive,
  onUpdate,
}: {
  group: Group;
  calendars: CalendarListEntry[];
  onArchive: (id: string) => void;
  onUpdate: (id: string, patch: Partial<Group>) => void;
}) {
  const [editOpen, setEditOpen] = useState(false);

  return (
    <li className="border border-line bg-card">
      <div className="flex items-stretch">
        <Link
          href={`/tasks?group=${group.id}`}
          className="flex-1 flex items-center gap-3 px-4 py-4 hover:bg-card-hover transition-colors min-w-0"
        >
          <span
            className="w-2 h-10 flex-shrink-0"
            style={{ backgroundColor: group.color }}
            aria-hidden
          />
          <div className="flex-1 min-w-0">
            <p className="text-fg text-base font-bold truncate">
              {group.name}
            </p>
            <p className="text-muted text-xs tracking-widest uppercase mt-0.5">
              {group.type}
            </p>
          </div>
          <span className="text-muted text-xs">›</span>
        </Link>

        <button
          onClick={() => setEditOpen((v) => !v)}
          aria-label="group actions"
          className="px-4 border-l border-line text-muted hover:text-fg hover:bg-card-hover transition-colors text-lg"
        >
          ···
        </button>
      </div>

      {editOpen && (
        <GroupEditPanel
          group={group}
          calendars={calendars}
          onUpdate={onUpdate}
          onArchive={(id) => {
            setEditOpen(false);
            onArchive(id);
          }}
        />
      )}
    </li>
  );
}

function GroupEditPanel({
  group,
  calendars,
  onUpdate,
  onArchive,
}: {
  group: Group;
  calendars: CalendarListEntry[];
  onUpdate: (id: string, patch: Partial<Group>) => void;
  onArchive: (id: string) => void;
}) {
  const [nameDraft, setNameDraft] = useState(group.name);

  function commitName() {
    const next = nameDraft.trim();
    if (!next || next === group.name) {
      setNameDraft(group.name);
      return;
    }
    onUpdate(group.id, { name: next });
  }

  return (
    <div className="border-t border-line p-4 space-y-5">
      <input
        type="text"
        value={nameDraft}
        onChange={(e) => setNameDraft(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            setNameDraft(group.name);
            e.currentTarget.blur();
          }
        }}
        maxLength={64}
        aria-label="group name"
        className="w-full bg-transparent text-fg text-base font-bold focus:outline-none border-b border-line-strong focus:border-accent pb-2 transition-colors"
      />

      <TypePicker
        value={group.type}
        onChange={(t) => onUpdate(group.id, { type: t })}
      />

      <ColorPicker
        value={group.color}
        onChange={(c) => onUpdate(group.id, { color: c })}
      />

      <CalendarLinkPicker
        value={group.google_calendar_id}
        calendars={calendars}
        onChange={(id) => onUpdate(group.id, { google_calendar_id: id })}
      />

      <div className="flex justify-end pt-2">
        <button
          onClick={() => onArchive(group.id)}
          className="text-danger text-xs tracking-widest uppercase hover:text-danger-hover transition-colors py-2 px-3"
        >
          archive
        </button>
      </div>
    </div>
  );
}

function TypePicker({
  value,
  onChange,
}: {
  value: Group["type"];
  onChange: (t: Group["type"]) => void;
}) {
  return (
    <div>
      <p className="text-[10px] tracking-widest uppercase text-muted mb-2">
        type
      </p>
      <div className="flex flex-wrap gap-2">
        {TYPES.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onChange(t)}
            className={`text-xs px-3 py-2 border transition-colors ${
              value === t
                ? "bg-fg text-accent-fg border-fg"
                : "border-line-strong text-muted hover:border-fg hover:text-fg"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

function CalendarLinkPicker({
  value,
  calendars,
  onChange,
}: {
  value: string | null;
  calendars: CalendarListEntry[];
  onChange: (id: string | null) => void;
}) {
  const linked = value
    ? (calendars.find((c) => c.id === value) ?? null)
    : null;
  const linkedMissing = value !== null && !linked;

  return (
    <div>
      <p className="text-[10px] tracking-widest uppercase text-muted mb-2">
        google calendar
      </p>
      {calendars.length === 0 ? (
        <p className="text-muted text-xs">
          {value
            ? "linked, but calendar list is not available right now."
            : "sign in with calendar access to link a calendar."}
        </p>
      ) : (
        <div className="flex items-center gap-2">
          {(linked || linkedMissing) && (
            <span
              className="w-3 h-3 flex-shrink-0"
              style={{ backgroundColor: linked?.color ?? "var(--muted)" }}
              aria-hidden
            />
          )}
          <select
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value || null)}
            aria-label="link google calendar"
            className="flex-1 min-w-0 bg-card border border-line-strong focus:border-accent text-fg text-xs uppercase tracking-widest px-2 py-1.5 focus:outline-none transition-colors"
          >
            <option value="">none</option>
            {linkedMissing && value && (
              <option value={value}>linked (not visible)</option>
            )}
            {calendars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.summary}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

