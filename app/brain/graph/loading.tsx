export default function BrainGraphLoading() {
  return (
    <main className="h-[calc(100dvh-var(--app-top,0px))] flex flex-col animate-pulse" aria-hidden>
      <div className="flex items-center justify-between px-5 pt-3 pb-4 lg:pt-8 lg:pb-6">
        <div className="h-3 w-16 bg-card rounded-md" />
        <div className="h-3 w-12 bg-card rounded-md" />
      </div>
      <div className="flex gap-2 px-5 pb-3">
        <div className="h-11 w-24 bg-card rounded-md" />
        <div className="h-11 w-24 bg-card rounded-md" />
        <div className="h-11 w-24 bg-card rounded-md" />
      </div>
      <div className="flex-1 mx-5 mb-5 bg-card rounded-md" />
    </main>
  );
}
