export default function Loading() {
  return (
    <main
      className="min-h-screen px-5 pt-8 pb-64 lg:px-12 animate-pulse"
      aria-hidden
    >
      <div className="flex items-center justify-between mb-10">
        <div className="h-3 w-24 bg-line rounded-md" />
        <div className="h-3 w-16 bg-line rounded-md" />
      </div>
      <div className="grid gap-8 lg:grid-cols-2 lg:gap-24 lg:items-start">
        <div className="space-y-px">
          <div className="h-12 bg-card rounded-field" />
          <div className="h-14 bg-card rounded-panel" />
          <div className="h-14 bg-card rounded-panel" />
          <div className="h-14 bg-card rounded-panel" />
        </div>
        <div className="border border-line h-64 bg-card rounded-panel" />
      </div>
    </main>
  );
}
