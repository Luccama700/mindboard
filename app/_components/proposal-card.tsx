"use client";

// The universal propose → confirm surface. Capture's `$` flow pins into this
// card, and the copilot renders every proposed write with it — one confirm
// grammar for human and AI. Ghost styling (dashed hairline over accent wash)
// marks "not yet real"; nothing it previews has been written.

export function ProposalCard({
  title,
  children,
  confirmLabel = "confirm",
  onConfirm,
  onSkip,
  pending = false,
  error = null,
}: {
  title: string;
  children: React.ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  onSkip: () => void;
  pending?: boolean;
  error?: string | null;
}) {
  return (
    <div className="border border-dashed border-line-strong bg-accent-wash px-3 py-3 space-y-3">
      <p className="text-label uppercase text-muted">{title}</p>
      <div className="space-y-2">{children}</div>
      {error && <p className="text-action text-danger">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className="min-h-11 px-4 text-action lowercase border border-accent bg-accent text-accent-fg hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {pending ? "…" : confirmLabel}
        </button>
        <button
          type="button"
          onClick={onSkip}
          disabled={pending}
          className="min-h-11 px-4 text-action lowercase border border-hairline text-muted hover:text-fg transition-colors disabled:opacity-50"
        >
          skip
        </button>
      </div>
    </div>
  );
}
