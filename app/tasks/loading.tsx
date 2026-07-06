export default function TasksLoading() {
  return (
    <main
      className="min-h-screen px-5 pt-6 pb-64 max-w-2xl mx-auto animate-pulse"
      aria-hidden
    >
      <div className="h-3 w-16 bg-card mb-4" />
      <div className="flex gap-2 mb-6">
        <div className="h-11 w-16 bg-card" />
        <div className="h-11 w-20 bg-card" />
        <div className="h-11 w-24 bg-card" />
      </div>
      <div className="space-y-px">
        <div className="h-14 bg-card" />
        <div className="h-14 bg-card" />
        <div className="h-14 bg-card" />
        <div className="h-14 bg-card" />
      </div>
    </main>
  );
}
