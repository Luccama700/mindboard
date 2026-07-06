export default function BrainGraphLoading() {
  return (
    <main className="h-dvh flex flex-col animate-pulse" aria-hidden>
      <div className="flex items-center justify-between px-5 pt-8 pb-6">
        <div className="h-3 w-16 bg-card" />
        <div className="h-3 w-12 bg-card" />
      </div>
      <div className="flex gap-2 px-5 pb-3">
        <div className="h-11 w-24 bg-card" />
        <div className="h-11 w-24 bg-card" />
        <div className="h-11 w-24 bg-card" />
      </div>
      <div className="flex-1 mx-5 mb-5 bg-card" />
    </main>
  );
}
