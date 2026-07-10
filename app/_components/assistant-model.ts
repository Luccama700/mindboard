// One source of truth for the copilot model choice: the Dock's plan-mode
// picker and /plan's picker read and write the same localStorage key, so the
// preference follows the user across both entry points.
export const MODEL_OPTIONS = [
  { id: "claude-opus-4-8", label: "opus (default)" },
  { id: "claude-sonnet-5", label: "sonnet (cheaper)" },
  { id: "claude-haiku-4-5", label: "haiku (cheapest)" },
] as const;

export const DEFAULT_ASSISTANT_MODEL = "claude-opus-4-8";

const STORAGE_KEY = "assistant-model";

export function readStoredModel(): string {
  if (typeof window === "undefined") return DEFAULT_ASSISTANT_MODEL;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && MODEL_OPTIONS.some((m) => m.id === stored)) return stored;
  } catch {
    // ignore
  }
  return DEFAULT_ASSISTANT_MODEL;
}

export function storeModel(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // ignore
  }
}
