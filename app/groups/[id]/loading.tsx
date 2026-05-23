export default function Loading() {
  return (
    <main className="min-h-screen px-5 pt-8 pb-56 lg:px-12 animate-pulse" aria-hidden>
      <div className="flex items-center justify-between mb-8">
        <div className="h-3 w-20 bg-line" />
        <div className="h-3 w-16 bg-line" />
      </div>
      <div className="flex items-center gap-3 mb-8">
        <div className="w-1.5 h-8 bg-line" />
        <div className="h-7 w-40 bg-line" />
      </div>
      <div className="grid gap-8 lg:grid-cols-2 lg:gap-12 lg:items-start">
        <section className="min-w-0 space-y-px">
          <div className="h-14 bg-card" />
          <div className="h-14 bg-card" />
          <div className="h-14 bg-card" />
          <div className="h-14 bg-card" />
        </section>
        <aside className="min-w-0">
          <div className="h-2.5 w-32 bg-line mb-2" />
          <div className="h-[320px] border border-line bg-card" />
        </aside>
      </div>
    </main>
  );
}
