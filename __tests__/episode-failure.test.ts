// The audio-overview pipeline marks its row 'rendering' before it calls the
// TTS provider, and only generateEpisodeFor can move it out of that status.
// Anything that escapes as a throw therefore strands the episode: the UI shows
// "rendering…" forever, so the user re-triggers a render that costs real money.
// These tests pin the failure paths that used to throw.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {
    status = 500;
  }
  class FakeAnthropic {
    messages = {
      stream: () => ({
        finalMessage: async () => ({
          content: [
            {
              type: "tool_use",
              id: "tu_1",
              name: "write_script",
              input: {
                title: "the trolley problem, revisited",
                lines: [
                  { speaker: "A", text: "welcome back." },
                  { speaker: "B", text: "glad to be here." },
                  { speaker: "A", text: "so, the trolley." },
                  { speaker: "B", text: "always the trolley." },
                ],
              },
            },
          ],
        }),
      }),
    };
    static APIError = APIError;
  }
  return { default: FakeAnthropic, APIError };
});

vi.mock("@/app/lib/connections/keys", () => ({
  readProviderKey: vi.fn(async () => "test-key"),
}));

vi.mock("@/app/lib/learn/context", () => ({
  loadConvertedSources: vi.fn(async () => ({
    ok: true,
    value: [{ id: "s1", title: "lecture 1" }],
  })),
  loadSourceDocuments: vi.fn(async () => ({
    ok: true,
    value: [{ source: { title: "lecture 1" }, markdown: "# notes" }],
  })),
}));

import { generateEpisodeFor } from "@/app/lib/learn/episodes";

const COURSE = {
  id: "c1",
  name: "phil 220",
  code: null,
  term: null,
  color: "#b5ff3c",
  archived: false,
  created_at: "2026-07-28T00:00:00Z",
};

type Update = { table: string; payload: Record<string, unknown> };

function fakeSupabase(upload: () => Promise<{ error: { message: string } | null }>) {
  const updates: Update[] = [];

  const thenable = <T,>(value: T) => {
    const q = {
      select: () => q,
      eq: () => q,
      then: (resolve: (v: T) => unknown) => Promise.resolve(resolve(value)),
    };
    return q;
  };

  const client = {
    from(table: string) {
      if (table === "courses") return thenable({ data: [COURSE], error: null });
      return {
        insert: () => ({
          select: () => ({
            single: async () => ({ data: { id: "ep1" }, error: null }),
          }),
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve(resolve({ error: null })),
        }),
        update: (payload: Record<string, unknown>) => {
          updates.push({ table, payload });
          return thenable({ error: null });
        },
      };
    },
    storage: { from: () => ({ upload }) },
  };

  return { client: client as unknown as SupabaseClient, updates };
}

const RAW = {
  course: "c1",
  source_ids: null,
  flavor: "deep-dive",
  engine: "gemini",
};

function lastUpdate(updates: Update[]) {
  return updates[updates.length - 1]?.payload ?? {};
}

const okUpload = async () => ({ error: null });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("generateEpisodeFor failure paths", () => {
  test("a 200 with a non-json body fails the episode instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<html><body>502 Bad Gateway</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    const { client, updates } = fakeSupabase(okUpload);

    const result = await generateEpisodeFor(client, "u1", RAW);

    expect(result.ok).toBe(false);
    const payload = lastUpdate(updates);
    expect(payload.status).toBe("failed");
    expect(String(payload.error)).toContain("non-json body");
    expect(String(payload.error)).toContain("text/html");
  });

  test("an unreadable error body still yields a status-bearing failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        headers: new Headers(),
        text: async () => {
          throw new TypeError("terminated");
        },
        json: async () => {
          throw new TypeError("terminated");
        },
      })),
    );
    const { client, updates } = fakeSupabase(okUpload);

    const result = await generateEpisodeFor(client, "u1", RAW);

    expect(result.ok).toBe(false);
    const payload = lastUpdate(updates);
    expect(payload.status).toBe("failed");
    expect(String(payload.error)).toContain("503");
  });

  test("a network error reaching the tts api fails the episode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const { client, updates } = fakeSupabase(okUpload);

    const result = await generateEpisodeFor(client, "u1", RAW);

    expect(result.ok).toBe(false);
    expect(lastUpdate(updates).status).toBe("failed");
  });

  test("a throwing storage upload fails the episode rather than stranding it", async () => {
    const pcm = Buffer.alloc(48_000).toString("base64");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          candidates: [
            { content: { parts: [{ inlineData: { data: pcm } }] } },
          ],
        }),
      ),
    );
    const { client, updates } = fakeSupabase(async () => {
      throw new TypeError("fetch failed");
    });

    const result = await generateEpisodeFor(client, "u1", RAW);

    expect(result.ok).toBe(false);
    const payload = lastUpdate(updates);
    expect(payload.status).toBe("failed");
    expect(String(payload.error)).toContain("episode generation failed");
  });

  test("no failure message echoes the provider api key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("nope", { status: 401, headers: { "content-type": "text/plain" } }),
      ),
    );
    const { client, updates } = fakeSupabase(okUpload);

    await generateEpisodeFor(client, "u1", RAW);

    expect(String(lastUpdate(updates).error)).not.toContain("test-key");
  });

  test("the happy path still lands 'done' with a duration", async () => {
    const pcm = Buffer.alloc(48_000).toString("base64");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          candidates: [
            { content: { parts: [{ inlineData: { data: pcm } }] } },
          ],
        }),
      ),
    );
    const { client, updates } = fakeSupabase(okUpload);

    const result = await generateEpisodeFor(client, "u1", RAW);

    expect(result.ok).toBe(true);
    const payload = lastUpdate(updates);
    expect(payload.status).toBe("done");
    expect(payload.duration_sec).toBe(1);
  });
});
