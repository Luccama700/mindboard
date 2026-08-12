"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  createPeopleGroup,
  deletePeopleGroup,
  updatePeopleGroup,
} from "@/app/actions/people";
import { ColorPicker, PALETTE } from "./color-picker";
import { Button, INPUT_CLASS } from "./ui";
import type { PersonGroup } from "./people-types";

// Shared manager for people groups — rendered both in the dock's groups
// sheet (people tab) and under /people's "not tracking" section. Groups are
// contexts (family / school / brazil), never closeness tiers.
export function PeopleGroupsManager({
  initial,
  onMutated,
}: {
  initial: PersonGroup[];
  // The dock sheet holds its list in client state from a lazy action, so
  // router.refresh() alone can't update it — it re-fetches through this.
  onMutated?: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(PALETTE[0]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftColor, setDraftColor] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolves true only on success, so callers can keep a draft alive when
  // the write failed instead of blanking the form under the error message.
  async function run(
    fn: () => Promise<{ error?: string | null } | void>,
  ): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    const result = await fn();
    setBusy(false);
    if (result && "error" in result && result.error) {
      setError(result.error);
      return false;
    }
    onMutated?.();
    router.refresh();
    return true;
  }

  return (
    <div className="space-y-4">
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (!trimmed) return;
          void run(() => createPeopleGroup(trimmed, color)).then((ok) => {
            if (ok) setName("");
          });
        }}
      >
        <div className="flex items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="new group — family, school…"
            aria-label="new people group name"
            maxLength={40}
            className={INPUT_CLASS}
          />
          <Button type="submit" variant="accent" disabled={busy || !name.trim()}>
            add
          </Button>
        </div>
        <ColorPicker value={color} onChange={setColor} />
      </form>

      {initial.length === 0 ? (
        <p className="text-meta text-muted">
          no groups yet — they&apos;re optional contexts, not rankings.
        </p>
      ) : (
        <ul>
          {initial.map((group) => (
            <li key={group.id} className="border-b border-line">
              {editing === group.id ? (
                <form
                  className="space-y-2 py-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(() =>
                      updatePeopleGroup(group.id, {
                        name: draftName.trim() || group.name,
                        color: draftColor,
                      }),
                    ).then((ok) => {
                      if (ok) setEditing(null);
                    });
                  }}
                >
                  <input
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    aria-label="group name"
                    maxLength={40}
                    autoFocus
                    className={INPUT_CLASS}
                  />
                  <ColorPicker value={draftColor} onChange={setDraftColor} />
                  <div className="flex items-center gap-2">
                    <Button type="submit" variant="outline" disabled={busy}>
                      save
                    </Button>
                    <Button variant="quiet" onClick={() => setEditing(null)}>
                      cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="flex min-h-11 items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-3 w-3 shrink-0"
                      style={{ backgroundColor: group.color }}
                      aria-hidden
                    />
                    <span className="text-body text-fg lowercase truncate">
                      {group.name}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(group.id);
                        setDraftName(group.name);
                        setDraftColor(group.color);
                        setConfirmingDelete(null);
                      }}
                      className="text-label uppercase text-muted hover:text-fg transition-colors min-h-11"
                    >
                      edit
                    </button>
                    {confirmingDelete === group.id ? (
                      <button
                        type="button"
                        onClick={() =>
                          void run(() => deletePeopleGroup(group.id)).then(
                            (ok) => {
                              if (ok) setConfirmingDelete(null);
                            },
                          )
                        }
                        className="text-label uppercase text-danger hover:opacity-80 transition-opacity min-h-11"
                      >
                        confirm — people stay, ungrouped
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmingDelete(group.id)}
                        className="text-label uppercase text-muted hover:text-danger transition-colors min-h-11"
                      >
                        delete
                      </button>
                    )}
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-meta text-danger">{error}</p>}
    </div>
  );
}
