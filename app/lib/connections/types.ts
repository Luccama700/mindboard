// Client-safe provider identifiers; the server-only key read path lives in
// app/lib/connections/keys.ts.
export type KeyProvider = "anthropic" | "google" | "openai";
