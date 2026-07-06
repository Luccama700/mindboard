import "server-only";
import { cache } from "react";

import { createClient } from "@/utils/supabase/server";
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

type VaultCredentials = { repo: string; branch: string; token: string };

// Internal read: the only place the token leaves the database. RLS-scoped,
// never returned to the client and never logged.
async function getVaultCredentials(
  userId: string,
): Promise<VaultCredentials | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("vault_settings")
    .select("repo, branch, github_token")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return null;
  return {
    repo: data.repo as string,
    branch: data.branch as string,
    token: data.github_token as string,
  };
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

async function fetchTree(
  credentials: VaultCredentials,
  tag: string,
): Promise<TreeEntry[]> {
  const url = `https://api.github.com/repos/${credentials.repo}/git/trees/${encodeURIComponent(credentials.branch)}?recursive=1`;
  const response = await fetch(url, {
    headers: githubHeaders(credentials.token),
    next: { revalidate: TREE_REVALIDATE_SECONDS, tags: [tag] },
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
