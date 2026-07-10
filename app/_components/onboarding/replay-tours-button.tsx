"use client";

import { useState } from "react";
import { resetTours } from "@/app/actions/onboarding";
import { TOURS_MIRROR_KEY } from "./tours";

// Wipes every completed tour and hard-navigates home, where the intro
// carousel re-triggers. The reload matters: the onboarding controller's
// in-memory state only resets with a fresh server render.
export function ReplayToursButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      localStorage.removeItem(TOURS_MIRROR_KEY);
    } catch {
      // ignore
    }
    const result = await resetTours();
    if (result.error) {
      setError(result.error);
      setBusy(false);
      return;
    }
    window.location.href = "/";
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="min-h-11 px-3 text-action lowercase border border-hairline text-fg hover:border-accent transition-colors disabled:opacity-50"
      >
        {busy ? "resetting…" : "replay all tours"}
      </button>
      <p className="text-meta text-muted leading-relaxed">
        forgets every walkthrough you&apos;ve seen and starts the intro over.
        the little ? on each screen replays just that screen&apos;s tour.
      </p>
      {error && <p className="text-meta text-danger">{error}</p>}
    </div>
  );
}
