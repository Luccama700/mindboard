import { refreshVault } from "@/app/actions/brain";

export function RefreshButton() {
  return (
    <form action={refreshVault}>
      <button
        type="submit"
        className="text-xs tracking-widest uppercase text-muted hover:text-fg transition-colors min-h-11 px-2 -mr-2"
      >
        refresh ↺
      </button>
    </form>
  );
}
