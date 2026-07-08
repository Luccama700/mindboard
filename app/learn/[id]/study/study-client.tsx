"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import {
  deleteCard,
  generateArtifact,
  generateCards,
  reviewCard,
} from "@/app/actions/learn";
import type { Course } from "@/app/_components/learn-types";
import { Button, SectionRuler } from "@/app/_components/ui";
import { noteHref } from "@/app/lib/brain/parse";

export type StudyCard = {
  id: string;
  question: string;
  answer: string;
  explain: string | null;
  got_count: number;
  miss_count: number;
  last_reviewed_at: string | null;
};

const ARTIFACT_OPTIONS = [
  { value: "study-guide", label: "study guide" },
  { value: "faq", label: "faq" },
  { value: "briefing", label: "briefing" },
  { value: "timeline", label: "timeline" },
];

function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function StudyClient({
  course,
  initialCards,
  hasConvertedSources,
}: {
  course: Course;
  initialCards: StudyCard[];
  hasConvertedSources: boolean;
}) {
  const [cards, setCards] = useState(initialCards);
  const [deck, setDeck] = useState<string[]>(() =>
    shuffled(initialCards.map((c) => c.id)),
  );
  const [position, setPosition] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [artifactKind, setArtifactKind] = useState("study-guide");
  const [lastArtifact, setLastArtifact] = useState<string | null>(null);
  const [sessionMisses, setSessionMisses] = useState<string[]>([]);

  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const current = position < deck.length ? byId.get(deck[position]) : undefined;
  const missedTotal = cards.filter((c) => c.miss_count > c.got_count).length;

  const startDeck = (ids: string[]) => {
    setDeck(shuffled(ids));
    setPosition(0);
    setRevealed(false);
    setSessionMisses([]);
  };

  const grade = async (got: boolean) => {
    if (!current) return;
    const cardId = current.id;
    setRevealed(false);
    setPosition((p) => p + 1);
    if (!got) setSessionMisses((prev) => [...prev, cardId]);
    setCards((prev) =>
      prev.map((c) =>
        c.id === cardId
          ? {
              ...c,
              got_count: c.got_count + (got ? 1 : 0),
              miss_count: c.miss_count + (got ? 0 : 1),
            }
          : c,
      ),
    );
    const result = await reviewCard({ cardId, got });
    if (result.error) setError(result.error);
  };

  const generate = async () => {
    setError(null);
    setBusy("cards");
    try {
      const result = await generateCards({ courseId: course.id, count: 20 });
      if (result.error) {
        setError(result.error);
        return;
      }
      // Server revalidates; simplest correct refresh is a reload of the page
      // data via location — but keep it SPA-ish: fetch is overkill, so just
      // hard-navigate.
      window.location.reload();
    } finally {
      setBusy(null);
    }
  };

  const makeArtifact = async () => {
    setError(null);
    setLastArtifact(null);
    setBusy("artifact");
    try {
      const result = await generateArtifact({
        courseId: course.id,
        kind: artifactKind,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setLastArtifact(result.vaultPath ?? null);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-8">
      {error && <p className="text-action text-danger">{error}</p>}

      <section className="space-y-3">
        <SectionRuler label="flashcards" count={cards.length} />

        {cards.length === 0 ? (
          <p className="text-meta text-muted leading-relaxed">
            {hasConvertedSources
              ? "no cards yet — generate a set from the converted sources."
              : "convert a source first, then generate cards from it."}
          </p>
        ) : current ? (
          <div className="border border-hairline p-4 space-y-4">
            <p className="text-meta text-muted">
              {position + 1} / {deck.length}
              {sessionMisses.length > 0 && ` · ${sessionMisses.length} missed`}
            </p>
            <p className="text-title text-fg leading-relaxed">
              {current.question}
            </p>
            {revealed ? (
              <div className="space-y-3">
                <p className="text-body text-fg leading-relaxed border-l-2 border-accent pl-3">
                  {current.answer}
                </p>
                {current.explain && (
                  <p className="text-meta text-muted leading-relaxed">
                    {current.explain}
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <Button variant="accent" onClick={() => void grade(true)}>
                    got it
                  </Button>
                  <Button variant="danger" onClick={() => void grade(false)}>
                    missed
                  </Button>
                  <span className="flex-1" />
                  <Button
                    variant="quiet"
                    onClick={async () => {
                      const id = current.id;
                      setCards((prev) => prev.filter((c) => c.id !== id));
                      setDeck((prev) => prev.filter((d) => d !== id));
                      setRevealed(false);
                      const result = await deleteCard({ cardId: id });
                      if (result.error) setError(result.error);
                    }}
                  >
                    drop card
                  </Button>
                </div>
              </div>
            ) : (
              <Button onClick={() => setRevealed(true)} className="w-full">
                reveal
              </Button>
            )}
          </div>
        ) : (
          <div className="border border-hairline p-4 space-y-3">
            <p className="text-body text-fg">
              deck done — {deck.length - sessionMisses.length}/{deck.length} on
              the first try.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {sessionMisses.length > 0 && (
                <Button variant="accent" onClick={() => startDeck(sessionMisses)}>
                  retest missed ({sessionMisses.length})
                </Button>
              )}
              <Button onClick={() => startDeck(cards.map((c) => c.id))}>
                again, shuffled
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {cards.length > 0 && position >= deck.length === false && (
            <Button
              variant="quiet"
              onClick={() => startDeck(cards.map((c) => c.id))}
            >
              reshuffle
            </Button>
          )}
          {missedTotal > 0 && (
            <Button
              variant="quiet"
              onClick={() =>
                startDeck(
                  cards
                    .filter((c) => c.miss_count > c.got_count)
                    .map((c) => c.id),
                )
              }
            >
              weak cards ({missedTotal})
            </Button>
          )}
          {hasConvertedSources && (
            <Button onClick={() => void generate()} disabled={busy !== null}>
              {busy === "cards" ? "generating… (~1 min)" : "+ 20 cards"}
            </Button>
          )}
        </div>
      </section>

      {hasConvertedSources && (
        <section className="space-y-3">
          <SectionRuler label="study documents" />
          <p className="text-meta text-muted leading-relaxed">
            generated into the vault under Courses/{course.name}/ — readable in
            /brain and obsidian.
          </p>
          <div className="flex items-center gap-1">
            <select
              value={artifactKind}
              onChange={(e) => setArtifactKind(e.target.value)}
              aria-label="artifact kind"
              className="bg-surface-0 border border-line-strong text-meta text-muted px-1 py-2 focus:outline-none focus:border-accent font-mono"
            >
              {ARTIFACT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <Button onClick={() => void makeArtifact()} disabled={busy !== null}>
              {busy === "artifact" ? "writing… (~1 min)" : "generate"}
            </Button>
          </div>
          {lastArtifact && (
            <p className="text-meta text-accent">
              done —{" "}
              <Link href={noteHref(lastArtifact)} className="hover:underline">
                open in /brain →
              </Link>
            </p>
          )}
        </section>
      )}
    </div>
  );
}
