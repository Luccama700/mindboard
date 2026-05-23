export default function Loading() {
  return (
    <main className="min-h-screen px-5 pt-8 pb-32 max-w-2xl mx-auto animate-pulse" aria-hidden>
      <div className="flex items-center justify-between mb-10">
        <div className="h-3 w-24 bg-line" />
        <div className="h-3 w-16 bg-line" />
      </div>
      <div className="space-y-px">
        <div className="h-16 bg-card" />
        <div className="h-16 bg-card" />
        <div className="h-16 bg-card" />
        <div className="h-16 bg-card" />
      </div>
    </main>
  );
}
