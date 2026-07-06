import "server-only";
import { cache } from "react";

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

function vaultRepo(): string {
  return process.env.VAULT_GITHUB_REPO ?? "Luccama700/2ndBrain";
}

function vaultBranch(): string {
  return process.env.VAULT_GITHUB_BRANCH ?? "main";
}

function githubHeaders(): Record<string, string> {
  const token = process.env.VAULT_GITHUB_TOKEN;
  if (!token) {
    throw new VaultConnectionError("VAULT_GITHUB_TOKEN is not configured");
  }
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

async function fetchTree(): Promise<TreeEntry[]> {
  const url = `https://api.github.com/repos/${vaultRepo()}/git/trees/${encodeURIComponent(vaultBranch())}?recursive=1`;
  const response = await fetch(url, {
    headers: githubHeaders(),
    next: { revalidate: TREE_REVALIDATE_SECONDS, tags: ["vault"] },
  });
  if (response.status === 401 || response.status === 403) {
    throw new VaultConnectionError("Vault repo access was rejected");
  }
  if (response.status === 404) {
    throw new VaultConnectionError("Vault repo or branch not found");
  }
  if (!response.ok) {
    throw new VaultConnectionError(
      `Vault tree request failed (${response.status})`,
    );
  }
  const payload = (await response.json()) as {
    tree?: TreeEntry[];
    truncated?: boolean;
  };
  if (payload.truncated) {
    throw new VaultConnectionError("Vault tree response was truncated");
  }
  return (payload.tree ?? []).filter(
    (entry) => entry.type === "blob" && includedMarkdownPath(entry.path),
  );
}

async function fetchBlob(sha: string): Promise<string> {
  const url = `https://api.github.com/repos/${vaultRepo()}/git/blobs/${sha}`;
  const response = await fetch(url, {
    headers: {
      ...githubHeaders(),
      Accept: "application/vnd.github.raw+json",
    },
    cache: "force-cache",
  });
  if (!response.ok) {
    throw new VaultConnectionError(
      `Vault file request failed (${response.status})`,
    );
  }
  return response.text();
}

export const getVaultCorpus = cache(async (): Promise<VaultCorpus> => {
  const entries = await fetchTree();
  const contents = new Map<string, string>();
  for (let i = 0; i < entries.length; i += BLOB_BATCH_SIZE) {
    const batch = entries.slice(i, i + BLOB_BATCH_SIZE);
    const texts = await Promise.all(batch.map((entry) => fetchBlob(entry.sha)));
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
});

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
