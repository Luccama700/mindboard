"use client";

import { useMemo, useState, useTransition } from "react";

import { seedMindspaceTopics } from "@/app/actions/mindspace";
import type { SeedCandidate } from "@/app/lib/mindspace/seed";
import type { TopicKind } from "@/app/lib/mindspace/types";

const KIND_LABELS: Record<TopicKind, string> = {
  person: "people",
  project: "projects",
  work: "work",
  course: "courses",
  area: "areas",
  emergent: "emerging",
};

const KIND_ORDER: TopicKind[] = [
  "person",
  "project",
  "work",
  "course",
  "area",
  "emergent",
];

export function SeedClient({ candidates }: { candidates: SeedCandidate[] }) {
  const [selected, setSelected] = useState<Set<string>>(
    () =>
      new Set(
        candidates
          .filter((candidate) => candidate.defaultSelected)
          .map((candidate) => candidate.name.toLowerCase()),
      ),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const grouped = useMemo(() => {
    const map = new Map<TopicKind, SeedCandidate[]>();
    for (const candidate of candidates) {
      const bucket = map.get(candidate.kind);
      if (bucket) bucket.push(candidate);
      else map.set(candidate.kind, [candidate]);
    }
    return KIND_ORDER.filter((kind) => map.has(kind)).map(
      (kind) => [kind, map.get(kind)!] as const,
    );
  }, [candidates]);

  function toggle(name: string) {
    const key = name.toLowerCase();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function submit() {
    const chosen = candidates.filter((candidate) =>
      selected.has(candidate.name.toLowerCase()),
    );
    startTransition(async () => {
      const result = await seedMindspaceTopics(
        chosen.map((candidate) => ({
          name: candidate.name,
          kind: candidate.kind,
          vaultPath: candidate.vaultPath,
          groupId: candidate.groupId,
          color: candidate.color,
        })),
      );
      if (result.error) setError(result.error);
    });
  }

  if (candidates.length === 0) {
    return (
      <p className="text-sm text-muted leading-relaxed">
        nothing to seed topics from yet — add task groups or connect a vault,
        then come back.
      </p>
    );
  }

  return (
    <div>
      <p className="text-sm text-muted mb-8 leading-relaxed">
        mindspace shows what share of your recorded attention each of these
        concerns has been getting. these candidates come from your vault and
        task groups — keep the ones that feel like real, current concerns. you
        can rename, merge, mute, or add more anytime.
      </p>

      <div className="space-y-6">
        {grouped.map(([kind, list]) => (
          <div key={kind}>
            <p className="text-[10px] tracking-widest uppercase text-muted mb-1">
              {KIND_LABELS[kind]}{" "}
              <span className="text-muted">({list.length})</span>
            </p>
            <ul>
              {list.map((candidate) => {
                const checked = selected.has(candidate.name.toLowerCase());
                return (
                  <li key={candidate.name}>
                    <button
                      type="button"
                      onClick={() => toggle(candidate.name)}
                      aria-pressed={checked}
                      className="flex w-full items-center gap-3 min-h-11 border-b border-line text-sm text-left hover:text-accent transition-colors"
                    >
                      <span
                        aria-hidden
                        className={`inline-block h-2 w-2 rounded-full ${
                          checked ? "" : "opacity-25"
                        }`}
                        style={{
                          backgroundColor: candidate.color ?? "#6b6b6b",
                        }}
                      />
                      <span className={checked ? "" : "text-muted"}>
                        {candidate.name}
                      </span>
                      <span className="ml-auto text-[10px] text-muted">
                        {checked ? "tracking" : "skipped"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      {error && <p className="mt-6 text-sm text-danger">{error}</p>}

      <button
        type="button"
        onClick={submit}
        disabled={pending || selected.size === 0}
        className="mt-8 min-h-11 w-full rounded-lg bg-accent text-page text-action font-medium disabled:opacity-40 transition-opacity"
      >
        {pending ? "setting up…" : `start tracking ${selected.size} topics`}
      </button>
    </div>
  );
}
