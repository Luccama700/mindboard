export default function Loading() {
  return (
    <main className="min-h-screen px-5 pt-8 pb-40 max-w-2xl mx-auto animate-pulse" aria-hidden>
      <div className="flex items-center justify-between mb-8">
        <div className="h-3 w-20 bg-line" />
        <div className="h-3 w-16 bg-line" />
      </div>
      <div className="flex items-center gap-3 mb-8">
        <div className="w-1.5 h-8 bg-line" />
        <div className="h-7 w-24 bg-line" />
      </div>
      <div className="space-y-px">
        <div className="h-14 bg-card" />
        <div className="h-14 bg-card" />
        <div className="h-14 bg-card" />
      </div>
    </main>
  );
}
