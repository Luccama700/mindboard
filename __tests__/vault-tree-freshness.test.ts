import { afterEach, describe, expect, test, vi } from "vitest";

import { createVaultFileWithRetry } from "@/app/lib/mcp/capture";
import {
  listVaultNotePaths,
  readVaultNoteRaw,
  vaultTag,
} from "@/app/lib/brain/vault";

// Regression cover for the stale-tree bug: after the worker committed a reel
// note, list_brain_notes kept returning the pre-commit tree because fetchTree
// was cached (stale-while-revalidate, so even past the TTL a read could be
// served the old tree). The MCP reads are how an agent verifies its own write
// landed, so they must bypass the data cache.
//
// Note what makes this test meaningful: outside the Next runtime there is no
// data cache, so "the new path is visible" alone would pass even with the bug.
// The assertions on the request init are the ones that actually pin the fix.

const CREDENTIALS = { repo: "lucca/vault", branch: "main", token: "ghp_test" };
const TAG = vaultTag("user-1");

type Recorded = { url: string; init: RequestInit | undefined };

// A fake GitHub holding one mutable file set: PUT /contents commits a path,
// GET /git/trees returns whatever is committed at that instant. Write and read
// share the backing state, so anything the read misses is the cache layer's
// doing rather than GitHub's.
function fakeGitHub(initialPaths: string[]) {
  const files = new Map(initialPaths.map((path) => [path, `# ${path}`]));
  const requests: Recorded[] = [];

  const impl = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    requests.push({ url, init });

    if (url.includes("/git/trees/")) {
      const tree = [...files.keys()].map((path) => ({
        path,
        sha: `sha-${path}`,
        type: "blob",
      }));
      return new Response(JSON.stringify({ tree, truncated: false }), {
        status: 200,
      });
    }
    if (url.includes("/git/blobs/")) {
      const sha = url.slice(url.indexOf("/git/blobs/") + "/git/blobs/".length);
      const path = [...files.keys()].find((p) => `sha-${p}` === sha);
      return new Response(files.get(path ?? "") ?? "", { status: 200 });
    }
    if (init?.method === "PUT" && url.includes("/contents/")) {
      const encoded = url.slice(url.indexOf("/contents/") + "/contents/".length);
      const path = encoded.split("/").map(decodeURIComponent).join("/");
      if (files.has(path)) return new Response("{}", { status: 422 });
      files.set(path, "committed body");
      return new Response(JSON.stringify({ content: { path } }), { status: 201 });
    }
    return new Response("unexpected request", { status: 500 });
  };

  const treeRequests = () => requests.filter((r) => r.url.includes("/git/trees/"));
  return { impl, treeRequests };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("vault tree freshness", () => {
  test("a just-written note is visible to listVaultNotePaths with no delay", async () => {
    const github = fakeGitHub(["Home.md", "Topics/Artificial intelligence.md"]);
    vi.stubGlobal("fetch", github.impl);

    const written = await createVaultFileWithRetry(
      CREDENTIALS,
      () => "Reels/Video by seanaiux.md",
      "# reel",
      "Reel record (via home worker)",
      github.impl,
    );
    expect(written.ok).toBe(true);

    const notes = await listVaultNotePaths(CREDENTIALS, TAG);
    expect(notes.map((note) => note.path)).toContain(
      "Reels/Video by seanaiux.md",
    );
  });

  test("listVaultNotePaths bypasses the data cache by default", async () => {
    const github = fakeGitHub(["Home.md"]);
    vi.stubGlobal("fetch", github.impl);

    await listVaultNotePaths(CREDENTIALS, TAG);

    const [request] = github.treeRequests();
    expect(request.init?.cache).toBe("no-store");
    expect(request.init?.next).toBeUndefined();
  });

  test("readVaultNoteRaw bypasses the data cache by default", async () => {
    const github = fakeGitHub(["Inbox/2026-07-24 1200 Note.md"]);
    vi.stubGlobal("fetch", github.impl);

    const note = await readVaultNoteRaw(
      CREDENTIALS,
      TAG,
      "Inbox/2026-07-24 1200 Note.md",
    );
    expect(note?.markdown).toBe("# Inbox/2026-07-24 1200 Note.md");

    const [request] = github.treeRequests();
    expect(request.init?.cache).toBe("no-store");
  });

  test("fresh:false keeps the tagged 180s cache (the DockMount badge)", async () => {
    const github = fakeGitHub(["Home.md"]);
    vi.stubGlobal("fetch", github.impl);

    await listVaultNotePaths(CREDENTIALS, TAG, { fresh: false });

    const [request] = github.treeRequests();
    expect(request.init?.cache).toBeUndefined();
    expect(request.init?.next).toEqual({ revalidate: 180, tags: [TAG] });
  });
});
