export default function HomeLoading() {
  return (
    <main
      className="min-h-screen px-5 pt-6 pb-64 max-w-2xl mx-auto animate-pulse"
      aria-hidden
    >
      <div className="flex items-center justify-between mb-8">
        <div className="h-4 w-40 bg-card" />
        <div className="h-4 w-48 bg-card" />
      </div>
      {[3, 2, 2].map((rows, section) => (
        <div key={section} className="mb-8">
          <div className="h-3 w-full bg-card mb-2" />
          <div className="space-y-px">
            {Array.from({ length: rows }).map((_, i) => (
              <div key={i} className="h-16 bg-card" />
            ))}
          </div>
        </div>
      ))}
    </main>
  );
}
