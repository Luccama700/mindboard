export default function TasksLoading() {
  return (
    <main
      className="min-h-screen px-5 pt-6 pb-64 max-w-2xl mx-auto animate-pulse"
      aria-hidden
    >
      <div className="h-3 w-16 bg-card rounded-md mb-4" />
      <div className="flex gap-2 mb-6">
        <div className="h-11 w-16 bg-card rounded-full" />
        <div className="h-11 w-20 bg-card rounded-full" />
        <div className="h-11 w-24 bg-card rounded-full" />
      </div>
      <div className="space-y-px">
        <div className="h-14 bg-card rounded-panel" />
        <div className="h-14 bg-card rounded-panel" />
        <div className="h-14 bg-card rounded-panel" />
        <div className="h-14 bg-card rounded-panel" />
      </div>
    </main>
  );
}
