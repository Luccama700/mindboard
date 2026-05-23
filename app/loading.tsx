export default function Loading() {
  return (
    <main className="min-h-screen px-5 pt-8 pb-56 lg:px-12">
      <div className="grid gap-8 lg:grid-cols-2 lg:gap-24 lg:items-start">
        <section className="min-w-0 animate-pulse" aria-hidden>
          <div className="flex items-start justify-between mb-8">
            <div className="space-y-2">
              <div className="h-2.5 w-32 bg-line" />
              <div className="h-8 w-24 bg-line" />
            </div>
            <div className="h-8 w-24 bg-line" />
          </div>
          <div className="h-2.5 w-16 bg-line mb-3" />
          <div className="space-y-px">
            <div className="h-14 bg-card" />
            <div className="h-14 bg-card" />
            <div className="h-14 bg-card" />
            <div className="h-14 bg-card" />
          </div>
        </section>
        <aside className="min-w-0 animate-pulse" aria-hidden>
          <div className="border border-line p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="h-3 w-32 bg-line" />
              <div className="h-3 w-16 bg-line" />
            </div>
            <div className="grid grid-cols-7 gap-px">
              {Array.from({ length: 42 }).map((_, i) => (
                <div key={i} className="aspect-square bg-card" />
              ))}
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
