export default function FinanceSetupLoading() {
  return (
    <main
      className="min-h-screen px-5 pt-8 pb-64 max-w-2xl mx-auto animate-pulse"
      aria-hidden
    >
      <div className="mb-8 flex items-center justify-between">
        <div className="h-3 w-16 bg-card rounded-md" />
        <div className="h-3 w-16 bg-card rounded-md" />
      </div>
      <div className="space-y-8">
        <div className="h-10 bg-card rounded-xl" />
        <div className="h-10 bg-card rounded-xl" />
        <div className="h-10 bg-card rounded-xl" />
      </div>
    </main>
  );
}
