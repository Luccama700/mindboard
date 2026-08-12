"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { confirmCandidate, dismissCandidate } from "@/app/actions/people";
import { Button } from "@/app/_components/ui";
import type { MentionCandidate } from "@/app/_components/people-types";
import { daysBetweenKeys } from "@/app/_components/people-recency";
import { backfillToDate } from "@/app/lib/snapshots/people";

// Candidate review (docs/people-plan.md §10 M4): pull, not push — a quiet
// affordance the user expands, never a per-mention prompt. A mention is
// evidence someone was on your mind; it becomes contact only when a human
// says so (§2), and confirmation asks WHEN separately because a sentence
// can describe contact from years ago (§2.4).
export function MentionReview({
  candidates,
  today,
}: {
  candidates: MentionCandidate[];
  today: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (candidates.length === 0) return null;

  const label =
    candidates.length === 1
      ? "one unreviewed mention"
      : candidates.length <= 4
        ? "a few unreviewed mentions"
        : "quite a few unreviewed mentions";

  async function act(fn: () => Promise<{ error?: string | null } | void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await fn();
    setBusy(false);
    if (result && "error" in result && result.error) {
      setError(result.error);
      return;
    }
    setConfirming(null);
    router.refresh();
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-meta text-muted hover:text-fg transition-colors min-h-11 inline-flex items-center"
      >
        {label} {open ? "▾" : "›"}
      </button>

      {open && (
        <ul className="mt-1 space-y-3">
          {candidates.map((candidate) => {
            const age = daysBetweenKeys(candidate.occurred_at, today);
            return (
              <li key={candidate.id} className="glass-panel rounded-pop px-4 py-3">
                <p className="text-meta text-muted">
                  {candidate.source_kind === "session" ? "from a chat" : "calendar"} ·{" "}
                  {age === 0 ? "today" : `${age}d ago`}
                  {candidate.matched_term && ` · matched "${candidate.matched_term}"`}
                </p>
                {candidate.excerpt && (
                  <p className="text-body text-fg mt-1 leading-relaxed">
                    &ldquo;…{candidate.excerpt}…&rdquo;
                  </p>
                )}
                {confirming === candidate.id ? (
                  <div className="mt-2 space-y-2">
                    <p className="text-meta text-muted">when did you actually talk?</p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void act(() =>
                            confirmCandidate({
                              candidateId: candidate.id,
                              occurredAt: candidate.occurred_at,
                              precision: "approx",
                            }),
                          )
                        }
                      >
                        around then
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void act(() =>
                            confirmCandidate({
                              candidateId: candidate.id,
                              occurredAt: today,
                              precision: "exact",
                            }),
                          )
                        }
                      >
                        today
                      </Button>
                      {(["this_week", "longer_ago"] as const).map((choice) => {
                        const resolved = backfillToDate(choice, today);
                        if (!resolved) return null;
                        return (
                          <Button
                            key={choice}
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              void act(() =>
                                confirmCandidate({
                                  candidateId: candidate.id,
                                  occurredAt: resolved.occurredAt,
                                  precision: resolved.precision,
                                }),
                              )
                            }
                          >
                            {choice === "this_week" ? "this week" : "longer ago"}
                          </Button>
                        );
                      })}
                      <Button variant="quiet" onClick={() => setConfirming(null)}>
                        back
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 flex items-center gap-2">
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => setConfirming(candidate.id)}
                    >
                      we talked
                    </Button>
                    <Button
                      variant="quiet"
                      disabled={busy}
                      onClick={() =>
                        void act(() => dismissCandidate(candidate.id))
                      }
                    >
                      just thinking about them
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="mt-2 text-meta text-danger">{error}</p>}
    </div>
  );
}
