"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  setPersonGroup,
  unsnoozePerson,
  updatePersonAliases,
  updatePersonName,
} from "@/app/actions/people";
import { Button, INPUT_CLASS } from "@/app/_components/ui";
import type { PersonGroup } from "@/app/_components/people-types";

// Name + aliases editing (the §10 M1 write matrix's "edit name / aliases")
// and the snooze release. Aliases feed the mention matcher, so the hint
// explains what they're for instead of presenting a bare field.
export function IdentityControl({
  personId,
  name,
  aliases,
  snoozedUntil,
  today,
  groups,
  groupId,
}: {
  personId: string;
  name: string;
  aliases: string[];
  snoozedUntil: string | null;
  today: string;
  groups: PersonGroup[];
  groupId: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const [draftAliases, setDraftAliases] = useState(aliases.join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const snoozed = snoozedUntil !== null && snoozedUntil > today;

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== name) {
      const result = await updatePersonName(personId, trimmed);
      if (result?.error) {
        setError(result.error);
        setBusy(false);
        return;
      }
    }
    const nextAliases = draftAliases
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    if (nextAliases.join("|") !== aliases.join("|")) {
      const result = await updatePersonAliases(personId, nextAliases);
      if (result?.error) {
        setError(result.error);
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    setOpen(false);
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {groups.length > 0 && (
          <select
            value={groupId ?? ""}
            disabled={busy}
            onChange={(e) => {
              setBusy(true);
              setError(null);
              void setPersonGroup(personId, e.target.value || null).then(
                (result) => {
                  setBusy(false);
                  if (result?.error) setError(result.error);
                  else router.refresh();
                },
              );
            }}
            aria-label="group"
            className="min-h-11 bg-glass-well rounded-field border border-line-strong text-muted text-[10px] tracking-widest uppercase px-2 focus:border-accent focus:outline-none transition-colors"
          >
            <option value="">no group</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name.toLowerCase()}
              </option>
            ))}
          </select>
        )}
        <Button variant="quiet" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "× close" : "edit name & aliases"}
        </Button>
        {snoozed && (
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void unsnoozePerson(personId).then((result) => {
                setBusy(false);
                if (result?.error) setError(result.error);
                else router.refresh();
              });
            }}
          >
            nudges paused — resume
          </Button>
        )}
      </div>
      {open && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            aria-label="person name"
            maxLength={80}
            className={INPUT_CLASS}
          />
          <input
            value={draftAliases}
            onChange={(e) => setDraftAliases(e.target.value)}
            placeholder="aliases, comma-separated…"
            aria-label="aliases, comma separated"
            maxLength={400}
            className={INPUT_CLASS}
          />
          <p className="text-meta text-muted">
            aliases are the other names i watch for in your chats — nicknames,
            short forms. three letters minimum each.
          </p>
          <Button type="submit" variant="outline" disabled={busy}>
            save
          </Button>
          {error && <p className="text-meta text-danger">{error}</p>}
        </form>
      )}
    </div>
  );
}
