import Link from "next/link";

export default function BrainNoteNotFound() {
  return (
    <main className="min-h-screen px-5 pt-8 pb-32 max-w-2xl mx-auto">
      <header className="flex items-center justify-between mb-10">
        <Link
          href="/brain"
          className="text-muted text-xs tracking-widest uppercase hover:text-fg transition-colors"
        >
          ← brain
        </Link>
        <h1 className="text-xs tracking-widest uppercase text-muted">note</h1>
      </header>
      <p className="text-sm text-muted border border-line px-4 py-3">
        this note does not exist in the vault.
      </p>
    </main>
  );
}
