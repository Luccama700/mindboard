export default function BrainLoading() {
  return (
    <main
      className="min-h-screen px-5 pt-8 pb-64 max-w-2xl mx-auto animate-pulse"
      aria-hidden
    >
      <div className="flex items-center justify-between mb-10">
        <div className="h-3 w-24 bg-card rounded-md" />
        <div className="h-3 w-16 bg-card rounded-md" />
      </div>
      <div className="h-14 w-full bg-card rounded-xl mb-6" />
      <div className="space-y-3">
        <div className="h-4 w-2/3 bg-card rounded-md" />
        <div className="h-4 w-full bg-card rounded-md" />
        <div className="h-4 w-5/6 bg-card rounded-md" />
        <div className="h-4 w-1/2 bg-card rounded-md" />
      </div>
      <div className="mt-12 space-y-4">
        <div className="h-3 w-16 bg-card rounded-md" />
        <div className="h-11 w-full border-b border-line" />
        <div className="h-11 w-full border-b border-line" />
        <div className="h-11 w-full border-b border-line" />
      </div>
    </main>
  );
}
