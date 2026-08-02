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
type WriteResult = { error: { message: string } | null };

function fakeSupabase(
  upload: () => Promise<WriteResult>,
  // Lets a test make one specific update return an error, or throw.
  updateResult: (payload: Record<string, unknown>) => WriteResult = () => ({
    error: null,
  }),
) {
  const updates: Update[] = [];
  const inserts: string[] = [];

  // A postgrest builder is a thenable, and it can reject as well as resolve —
  // honour both, or a throwing produce() becomes an unhandled rejection that
  // never settles the await.
  const thenable = <T,>(produce: () => T) => {
    const q = {
      select: () => q,
      eq: () => q,
      then: (resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) => {
        try {
          return Promise.resolve(resolve(produce()));
        } catch (error) {
          return reject ? Promise.resolve(reject(error)) : Promise.reject(error);
        }
      },
    };
    return q;
  };

  const client = {
    from(table: string) {
      if (table === "courses") {
        return thenable(() => ({ data: [COURSE], error: null }));
      }
      return {
        insert: () => {
          inserts.push(table);
          return {
            select: () => ({
              single: async () => ({ data: { id: "ep1" }, error: null }),
            }),
            then: (resolve: (v: unknown) => unknown) =>
              Promise.resolve(resolve({ error: null })),
          };
        },
        update: (payload: Record<string, unknown>) => {
          updates.push({ table, payload });
          return thenable(() => updateResult(payload));
        },
      };
    },
    storage: { from: () => ({ upload }) },
  };

  return { client: client as unknown as SupabaseClient, updates, inserts };
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

// A Gemini TTS success body: 48 000 bytes of PCM at 24 kHz mono 16-bit = 1s.
function renderedAudio(): Response {
  return Response.json({
    candidates: [
      {
        content: {
          parts: [
            { inlineData: { data: Buffer.alloc(48_000).toString("base64") } },
          ],
        },
      },
    ],
  });
}

const okUpload = async () => ({ error: null });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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

  test("a storage upload that reports an error fails the episode", async () => {
    // The ordinary path: storage-js turns request failures into a StorageError
    // and hands it back through `error` rather than throwing.
    vi.stubGlobal("fetch", vi.fn(async () => renderedAudio()));
    const { client, updates } = fakeSupabase(async () => ({
      error: { message: "Bucket not found" },
    }));

    const result = await generateEpisodeFor(client, "u1", RAW);

    expect(result.ok).toBe(false);
    const payload = lastUpdate(updates);
    expect(payload.status).toBe("failed");
    expect(String(payload.error)).toContain("audio upload failed");
  });

  test("an upload throwing something storage-js does not wrap still fails the episode", async () => {
    // handleOperation rethrows anything that isn't a StorageError — a throw
    // while building the request body, or any error under shouldThrowOnError.
    vi.stubGlobal("fetch", vi.fn(async () => renderedAudio()));
    const { client, updates } = fakeSupabase(async () => {
      throw new Error("Invalid metadata");
    });

    const result = await generateEpisodeFor(client, "u1", RAW);

    expect(result.ok).toBe(false);
    const payload = lastUpdate(updates);
    expect(payload.status).toBe("failed");
    expect(String(payload.error)).toContain("episode generation failed");
  });

  test("a rejecting fail() does not reject the caller, and says the row is stuck", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<html>502</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    // Only the recovery write blows up — a throw from inside the catch handler
    // is not caught by its own try, so this used to reject the whole call.
    const { client } = fakeSupabase(okUpload, (payload) => {
      if (payload.status === "failed") throw new Error("JWT expired");
      return { error: null };
    });

    const result = await generateEpisodeFor(client, "u1", RAW);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain(
      "could not be marked failed",
    );
    expect(result.ok === false && result.error).toContain("JWT expired");
  });

  test("a fail() whose write is refused reports that, not a clean failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const { client } = fakeSupabase(okUpload, (payload) =>
      payload.status === "failed"
        ? { error: { message: "new row violates row-level security policy" } }
        : { error: null },
    );

    const result = await generateEpisodeFor(client, "u1", RAW);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain(
      "could not be marked failed",
    );
  });

  test("a failed 'queued' write stops the vibevoice job from being enqueued", async () => {
    // The script lives on that row; a job whose script never landed burns all
    // three worker attempts on "episode has no script" before dead-lettering.
    vi.stubEnv("MINDBOARD_OWNER_USER_ID", "u1");
    const { client, updates, inserts } = fakeSupabase(okUpload, (payload) =>
      payload.status === "queued"
        ? { error: { message: "payload too large" } }
        : { error: null },
    );

    const result = await generateEpisodeFor(client, "u1", {
      ...RAW,
      engine: "vibevoice",
    });

    expect(result.ok).toBe(false);
    expect(inserts).not.toContain("jobs");
    expect(lastUpdate(updates).status).toBe("failed");
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
    vi.stubGlobal("fetch", vi.fn(async () => renderedAudio()));
    const { client, updates } = fakeSupabase(okUpload);

    const result = await generateEpisodeFor(client, "u1", RAW);

    expect(result.ok).toBe(true);
    const payload = lastUpdate(updates);
    expect(payload.status).toBe("done");
    expect(payload.duration_sec).toBe(1);
  });
});
