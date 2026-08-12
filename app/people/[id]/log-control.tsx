"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  deleteInteraction,
  logInteraction,
  updateInteraction,
} from "@/app/actions/people";
import { Button, SectionRuler, INPUT_CLASS } from "@/app/_components/ui";
import type { PersonInteraction } from "@/app/_components/people-types";
import { formatOccurred } from "@/app/_components/people-recency";

// One tap means ONE tap (docs/people-plan.md §10 M1): "talked" writes
// { summary: null, precision: 'exact' } on the page's resolved today.
// Prose and a different day are optional second gestures, never a gate.
export function LogControl({
  personId,
  interactions,
  today,
}: {
  personId: string;
  interactions: PersonInteraction[];
  today: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [date, setDate] = useState(today);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSummary, setEditSummary] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function log(input: { summary: string | null; occurredAt: string }) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await logInteraction({
      personId,
      summary: input.summary,
      occurredAt: input.occurredAt,
      precision: "exact",
    });
    setBusy(false);
    if (result?.error) {
      setError(result.error);
      return;
    }
    setSummary("");
    setDate(today);
    setDetailOpen(false);
    router.refresh();
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <SectionRuler label="recent" count={interactions.length || undefined} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="accent"
          disabled={busy}
          onClick={() => void log({ summary: null, occurredAt: today })}
        >
          talked today
        </Button>
        <Button
          variant="quiet"
          aria-expanded={detailOpen}
          onClick={() => setDetailOpen((v) => !v)}
        >
          {detailOpen ? "× nevermind" : "+ with details"}
        </Button>
      </div>

      {detailOpen && (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void log({ summary: summary.trim() || null, occurredAt: date });
          }}
        >
          <input
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="what happened, in your words…"
            aria-label="interaction summary"
            maxLength={280}
            className={INPUT_CLASS}
          />
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={date}
              max={today}
              onChange={(e) => setDate(e.target.value || today)}
              aria-label="when it happened"
              className={`${INPUT_CLASS} w-auto`}
            />
            <Button type="submit" variant="outline" disabled={busy}>
              log it
            </Button>
          </div>
        </form>
      )}

      {error && <p className="mt-2 text-meta text-danger">{error}</p>}

      {interactions.length > 0 && (
        <ul className="mt-4">
          {interactions.map((row) => (
            <li
              key={row.id}
              className="group flex min-h-11 items-center justify-between gap-3 border-b border-line"
            >
              {editingId === row.id ? (
                <form
                  className="flex flex-1 items-center gap-2 py-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void updateInteraction({
                      interactionId: row.id,
                      summary: editSummary.trim() || null,
                    }).then(() => {
                      setEditingId(null);
                      router.refresh();
                    });
                  }}
                >
                  <input
                    value={editSummary}
                    onChange={(e) => setEditSummary(e.target.value)}
                    aria-label="edit summary"
                    maxLength={280}
                    autoFocus
                    className={INPUT_CLASS}
                  />
                  <Button type="submit" variant="quiet">
                    save
                  </Button>
                </form>
              ) : (
                <>
                  <span className="flex min-w-0 items-baseline gap-3">
                    <span className="text-meta text-muted shrink-0 w-28">
                      {formatOccurred(row, today)}
                    </span>
                    <span className="text-body text-fg truncate">
                      {row.summary ?? "talked"}
                    </span>
                  </span>
                  {/* Touch has no hover: keep the controls visible on mobile,
                      reveal-on-hover only from sm up. */}
                  <span className="flex shrink-0 items-center gap-2 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(row.id);
                        setEditSummary(row.summary ?? "");
                      }}
                      className="text-label uppercase text-muted hover:text-fg transition-colors min-h-11"
                    >
                      edit
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void deleteInteraction(row.id).then(() => router.refresh());
                      }}
                      className="text-label uppercase text-muted hover:text-danger transition-colors min-h-11"
                    >
                      delete
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
