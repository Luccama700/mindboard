export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6">
      <div className="max-w-sm w-full space-y-8">
        <div>
          <p className="text-[#6b6b6b] text-xs tracking-widest uppercase mb-3">
            personal dashboard
          </p>
          <h1 className="text-4xl font-bold tracking-tight text-[#f5f0e8]">
            mindboard
          </h1>
        </div>

        <p className="text-[#6b6b6b] text-sm leading-relaxed">
          Track what matters. Ship what ships.
        </p>

        <div className="pt-4">
          <a
            href="/login"
            className="inline-block bg-[#b5ff3c] text-[#0d0d0d] text-sm font-bold px-6 py-3 hover:bg-[#f5f0e8] transition-colors"
          >
            get started →
          </a>
        </div>
      </div>
    </main>
  );
}
