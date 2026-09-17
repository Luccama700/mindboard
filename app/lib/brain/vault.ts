import "server-only";
import { cache } from "react";
import { revalidateTag, updateTag } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/utils/supabase/server";
import {
  isEncryptedSecret,
  revealSecret,
  sealSecret,
} from "@/app/lib/assistant/crypto";
import {
  buildResolver,
  computeBacklinks,
  extractWikilinks,
  noteFolder,
  noteTitle,
  parseFrontmatter,
  type NoteFrontmatter,
  type WikilinkResolver,
} from "@/app/lib/brain/parse";

export class VaultConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultConnectionError";
  }
}

export class VaultNotConfiguredError extends VaultConnectionError {
  constructor() {
    super("vault not connected");
    this.name = "VaultNotConfiguredError";
  }
}

export type VaultSettings = {
  repo: string;
  branch: string;
  updated_at: string;
};

export type VaultNote = {
  path: string;
  folder: string;
  title: string;
  frontmatter: NoteFrontmatter;
  body: string;
  outgoing: string[];
  backlinks: string[];
};

export type VaultCorpus = {
  notes: Map<string, VaultNote>;
  folders: Map<string, VaultNote[]>;
  resolve: WikilinkResolver;
};

const EXCLUDED_PREFIXES = ["_import/", ".obsidian/"];
const TREE_REVALIDATE_SECONDS = 180;
const BLOB_BATCH_SIZE = 25;

export function vaultTag(userId: string): string {
  return `vault:${userId}`;
}

// Invalidate a user's cached vault tree after a commit. Route Handlers (the
// MCP server, /api/capture, /api/worker) can only use revalidateTag, which is
// stale-while-revalidate — the very next read may still be served the old
// tree. That is precisely why the MCP read path fetches fresh instead of
// trusting this: invalidation here keeps the /brain pages honest, it does NOT
// make a read authoritative. Never throws: a failed invalidation must not undo
// a successful write, but it is logged rather than swallowed.
export function revalidateVaultTree(userId: string): void {
  try {
    revalidateTag(vaultTag(userId), "max");
  } catch (error) {
    console.warn("vault tree revalidation failed", error);
  }
}

// Server Actions only (Next 16 restricts updateTag to them): expires the entry
// immediately so the acting user reads their own write on the next render.
export function expireVaultTree(userId: string): void {
  try {
    updateTag(vaultTag(userId));
  } catch (error) {
    console.warn("vault tree expiry failed", error);
  }
}

// Public read for pages: connection state without the token column.
export const getVaultSettings = cache(
  async (userId: string): Promise<VaultSettings | null> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("vault_settings")
      .select("repo, branch, updated_at")
      .eq("user_id", userId)
      .maybeSingle();
    return (data as VaultSettings | null) ?? null;
  },
);

export type VaultCredentials = { repo: string; branch: string; token: string };

// The only read path for the token: RLS-scoped on the session client (/brain),
// explicitly user-filtered on the service client (MCP capture_to_brain). The
// token is never returned to the client and never logged. Stored AES-256-GCM
// encrypted (the provider-key pattern); rows written before the encryption
// change are plaintext and lazily upgraded on first read.
export async function readVaultCredentials(
  supabase: SupabaseClient,
  userId: string,
): Promise<VaultCredentials | null> {
  const { data } = await supabase
    .from("vault_settings")
    .select("repo, branch, github_token")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return null;
  const stored = data.github_token as string;
  const token = revealSecret(stored);
  // Encrypted but undecryptable (rotated secret): treat as not connected
  // rather than sending garbage to GitHub as a bearer.
  if (!token) return null;
  if (!isEncryptedSecret(stored)) {
    // Lazy upgrade: the first read after the encryption change re-writes the
    // row encrypted. Best-effort — a failed write must not block the read.
    const sealed = sealSecret(token);
    if (isEncryptedSecret(sealed)) {
      await supabase
        .from("vault_settings")
        .update({ github_token: sealed })
        .eq("user_id", userId);
    }
  }
  return {
    repo: data.repo as string,
    branch: data.branch as string,
    token,
  };
}

async function getVaultCredentials(
  userId: string,
): Promise<VaultCredentials | null> {
  return readVaultCredentials(await createClient(), userId);
}

export function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function includedMarkdownPath(path: string): boolean {
  if (!path.toLowerCase().endsWith(".md")) return false;
  const segments = path.split("/");
  if (segments.some((segment) => segment.startsWith("."))) return false;
  return !EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

type TreeEntry = { path: string; sha: string; type: string };

// `fresh` bypasses the data cache entirely. Needed because the cached path is
// stale-while-revalidate: past the TTL a read can still be served the old tree
// while the refresh happens behind it, and on serverless the refreshed entry
// may not be visible to the next invocation either. Callers that must observe
// a just-committed write (the MCP tools) cannot tolerate that.
export type TreeFetchOptions = { fresh?: boolean };

async function fetchTree(
  credentials: VaultCredentials,
  tag: string,
  { fresh = false }: TreeFetchOptions = {},
): Promise<TreeEntry[]> {
  const url = `https://api.github.com/repos/${credentials.repo}/git/trees/${encodeURIComponent(credentials.branch)}?recursive=1`;
  const response = await fetch(url, {
    headers: githubHeaders(credentials.token),
    ...(fresh
      ? { cache: "no-store" as const }
      : { next: { revalidate: TREE_REVALIDATE_SECONDS, tags: [tag] } }),
  });
  if (response.status === 401 || response.status === 403) {
    throw new VaultConnectionError(
      "vault repo access was rejected (does the token have Contents read permission?)",
    );
  }
  if (response.status === 404) {
    throw new VaultConnectionError("vault repo or branch not found");
  }
  if (!response.ok) {
    throw new VaultConnectionError(
      `vault tree request failed (${response.status})`,
    );
  }
  const payload = (await response.json()) as {
    tree?: TreeEntry[];
    truncated?: boolean;
  };
  if (payload.truncated) {
    throw new VaultConnectionError("vault tree response was truncated");
  }
  return (payload.tree ?? []).filter(
    (entry) => entry.type === "blob" && includedMarkdownPath(entry.path),
  );
}

async function fetchBlob(
  credentials: VaultCredentials,
  sha: string,
): Promise<string> {
  const url = `https://api.github.com/repos/${credentials.repo}/git/blobs/${sha}`;
  const response = await fetch(url, {
    headers: {
      ...githubHeaders(credentials.token),
      Accept: "application/vnd.github.raw+json",
    },
    cache: "force-cache",
  });
  if (!response.ok) {
    throw new VaultConnectionError(
      `vault file request failed (${response.status})`,
    );
  }
  return response.text();
}

export const getVaultCorpus = cache(
  async (userId: string): Promise<VaultCorpus> => {
    const credentials = await getVaultCredentials(userId);
    if (!credentials) throw new VaultNotConfiguredError();

    const entries = await fetchTree(credentials, vaultTag(userId));
    const contents = new Map<string, string>();
    for (let i = 0; i < entries.length; i += BLOB_BATCH_SIZE) {
      const batch = entries.slice(i, i + BLOB_BATCH_SIZE);
      const texts = await Promise.all(
        batch.map((entry) => fetchBlob(credentials, entry.sha)),
      );
      batch.forEach((entry, index) => contents.set(entry.path, texts[index]));
    }

    const paths = entries.map((entry) => entry.path);
    const resolve = buildResolver(paths);

    const notes = new Map<string, VaultNote>();
    for (const path of paths) {
      const { frontmatter, body } = parseFrontmatter(contents.get(path) ?? "");
      const outgoing = [
        ...new Set(
          extractWikilinks(body)
            .map((target) => resolve(target))
            .filter((resolved): resolved is string => resolved !== null),
        ),
      ];
      notes.set(path, {
        path,
        folder: noteFolder(path),
        title: noteTitle(path),
        frontmatter,
        body,
        outgoing,
        backlinks: [],
      });
    }

    const backlinks = computeBacklinks([...notes.values()]);
    for (const [target, sources] of backlinks) {
      const note = notes.get(target);
      if (note) note.backlinks = sources;
    }

    const folders = new Map<string, VaultNote[]>();
    for (const note of notes.values()) {
      const bucket = folders.get(note.folder);
      if (bucket) bucket.push(note);
      else folders.set(note.folder, [note]);
    }
    for (const bucket of folders.values()) {
      bucket.sort((a, b) => a.title.localeCompare(b.title));
    }

    return { notes, folders, resolve };
  },
);

// Session-less vault reads for the MCP server: list note paths, or fetch one
// note's raw markdown by path (case-insensitive). Both use the same tree fetch
// as getVaultCorpus but skip the full-corpus blob download.
//
// These DEFAULT TO FRESH. They are how an agent checks whether its own write
// landed, so answering from a cached tree is a correctness bug, not a
// performance win — staleness is opt-in (see DockMount's badge), never the
// default. getVaultCorpus keeps the cache: it downloads every blob.
export async function listVaultNotePaths(
  credentials: VaultCredentials,
  tag: string,
  { fresh = true }: TreeFetchOptions = {},
): Promise<{ path: string; folder: string; title: string }[]> {
  const entries = await fetchTree(credentials, tag, { fresh });
  return entries.map((entry) => ({
    path: entry.path,
    folder: noteFolder(entry.path),
    title: noteTitle(entry.path),
  }));
}

export async function readVaultNoteRaw(
  credentials: VaultCredentials,
  tag: string,
  path: string,
  { fresh = true }: TreeFetchOptions = {},
): Promise<{ path: string; markdown: string } | null> {
  const entries = await fetchTree(credentials, tag, { fresh });
  const lowered = path.toLowerCase();
  const entry =
    entries.find((e) => e.path === path) ??
    entries.find((e) => e.path.toLowerCase() === lowered) ??
    entries.find((e) => e.path.toLowerCase() === `${lowered}.md`);
  if (!entry) return null;
  return { path: entry.path, markdown: await fetchBlob(credentials, entry.sha) };
}

// Read a non-markdown attachment's text by its embed basename (![[name]]).
// fetchTree filters to markdown, so this does its own unfiltered tree fetch
// and matches the basename exactly or as a text file (an extension-less embed
// resolves to a sniffed .txt). Restricted to text extensions so a same-named
// image/video is never pulled. Used to recover a reel URL that an older
// capture stored in a .txt attachment beside the note.
export async function readVaultAttachmentText(
  credentials: VaultCredentials,
  embedName: string,
): Promise<string | null> {
  const target = embedName.trim().toLowerCase();
  if (!target) return null;
  const candidates = [target, `${target}.txt`, `${target}.text`, `${target}.md`];

  const url = `https://api.github.com/repos/${credentials.repo}/git/trees/${encodeURIComponent(credentials.branch)}?recursive=1`;
  const response = await fetch(url, {
    headers: githubHeaders(credentials.token),
    cache: "no-store",
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { tree?: TreeEntry[] };
  const entry = (payload.tree ?? []).find((e) => {
    if (e.type !== "blob") return false;
    const base = (e.path.split("/").pop() ?? "").toLowerCase();
    return candidates.includes(base);
  });
  if (!entry) return null;
  return fetchBlob(credentials, entry.sha);
}

export function findNote(
  corpus: VaultCorpus,
  path: string,
): VaultNote | null {
  const direct = corpus.notes.get(path);
  if (direct) return direct;
  const lowered = path.toLowerCase();
  for (const note of corpus.notes.values()) {
    if (note.path.toLowerCase() === lowered) return note;
  }
  return null;
}
