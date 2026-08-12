"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { confirmSeeding } from "@/app/actions/people";
import { Button, SectionRuler } from "@/app/_components/ui";

// First-visit seeding: every eligible vault note listed once, the user
// corrects in one pass (docs/people-plan.md §5). Non-person types and the
// likely self-note arrive pre-unticked as a HINT — no frontmatter parsing
// can settle "who counts as a person here", so we ask instead of guessing.
export function SeedingChecklist({
  candidates,
}: {
  candidates: { path: string; title: string; preticked: boolean }[];
}) {
  const router = useRouter();
  const [ticked, setTicked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(candidates.map((c) => [c.path, c.preticked])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const count = Object.values(ticked).filter(Boolean).length;

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await confirmSeeding(
      candidates.map((c) => ({ path: c.path, include: ticked[c.path] ?? false })),
    );
    setBusy(false);
    if (result?.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <section className="space-y-4" data-tour="people-seeding">
      <p className="text-body text-muted leading-relaxed">
        these look like people from your vault — untick anything that
        isn&apos;t someone you&apos;d keep in touch with (yourself, pets,
        placeholders). you can change all of this later.
      </p>
      <SectionRuler label="from your vault" count={candidates.length} />
      <ul>
        {candidates.map((c) => (
          <li key={c.path}>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-line">
              <input
                type="checkbox"
                checked={ticked[c.path] ?? false}
                onChange={(e) =>
                  setTicked((prev) => ({ ...prev, [c.path]: e.target.checked }))
                }
                className="h-4 w-4 accent-[var(--accent)]"
              />
              <span className="text-body text-fg lowercase">{c.title}</span>
              {!c.preticked && (
                <span className="text-meta text-muted">maybe not?</span>
              )}
            </label>
          </li>
        ))}
      </ul>
      <Button variant="accent" disabled={busy} onClick={() => void confirm()}>
        {busy ? "setting up…" : `track ${count} ${count === 1 ? "person" : "people"}`}
      </Button>
      {error && <p className="text-meta text-danger">{error}</p>}
    </section>
  );
}
