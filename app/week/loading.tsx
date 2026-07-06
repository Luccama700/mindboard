export default function WeekLoading() {
  return (
    <main
      className="min-h-screen px-4 pt-6 pb-64 lg:px-8 max-w-6xl mx-auto animate-pulse"
      aria-hidden
    >
      <div className="h-3 w-20 bg-card mb-6" />
      <div className="border border-line p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="h-3 w-32 bg-line" />
          <div className="h-3 w-16 bg-line" />
        </div>
        <div className="grid grid-cols-7 gap-px">
          {Array.from({ length: 21 }).map((_, i) => (
            <div key={i} className="h-24 bg-card" />
          ))}
        </div>
      </div>
    </main>
  );
}
