import Link from "next/link";
import { redirect } from "next/navigation";

import { createClient } from "@/utils/supabase/server";
import {
  getVaultCorpus,
  getVaultSettings,
  VaultConnectionError,
  type VaultCorpus,
} from "@/app/lib/brain/vault";
import { noteHref } from "@/app/lib/brain/parse";
import { NoteView } from "./_components/note-view";
import { RefreshButton } from "./_components/refresh-button";
import { VaultSettingsForm } from "./_components/vault-settings-form";

const FOLDER_ORDER = [
  "People",
  "Projects",
  "Areas",
  "Topics",
  "Journal",
  "Archive",
];

function FolderListing({ corpus }: { corpus: VaultCorpus }) {
  const rootNotes = (corpus.folders.get("") ?? []).filter(
    (note) => note.path !== "Home.md",
  );
  const sections = [
    ...(rootNotes.length > 0 ? [["root", rootNotes] as const] : []),
    ...FOLDER_ORDER.map(
      (folder) => [folder, corpus.folders.get(folder) ?? []] as const,
    ),
  ];

  return (
    <section className="mt-12" data-tour="brain-notes">
      <h2 className="text-xs tracking-widest uppercase text-muted mb-4">
        vault
      </h2>
      <div className="space-y-6">
        {sections.map(([folder, notes]) => (
          <div key={folder}>
            <p className="text-[10px] tracking-widest uppercase text-muted mb-1">
              {folder.toLowerCase()}{" "}
              <span className="text-muted">({notes.length})</span>
            </p>
            {notes.length === 0 ? (
              <p className="text-xs text-muted py-2">empty</p>
            ) : (
              <ul>
                {notes.map((note) => (
                  <li key={note.path}>
                    <Link
                      href={noteHref(note.path)}
                      className="flex items-center justify-between gap-3 min-h-11 border-b border-line text-sm hover:text-accent transition-colors"
                    >
                      <span>{note.title}</span>
                      {note.backlinks.length > 0 && (
                        <span className="text-[10px] text-muted shrink-0">
                          ← {note.backlinks.length}
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export default async function BrainPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const settings = await getVaultSettings(user.id);

  if (!settings) {
    return (
      <main className="min-h-screen px-5 pt-8 pb-64 max-w-2xl mx-auto">
        <header className="flex items-center justify-between mb-10">
          <Link
            href="/"
            className="text-muted text-xs tracking-widest uppercase hover:text-fg transition-colors"
          >
            ← mindboard
          </Link>
          <h1 className="text-xs tracking-widest uppercase text-muted">
            brain
          </h1>
        </header>
        <p className="text-sm text-muted mb-6 leading-relaxed">
          connect an Obsidian vault stored in a GitHub repo to browse it here,
          read-only.
        </p>
        <VaultSettingsForm initialRepo="" initialBranch="main" connected={false} />
      </main>
    );
  }

  let corpus: VaultCorpus | null = null;
  let connectionError: string | null = null;
  try {
    corpus = await getVaultCorpus(user.id);
  } catch (error) {
    if (error instanceof VaultConnectionError) {
      connectionError = error.message;
    } else {
      throw error;
    }
  }

  const home = corpus?.notes.get("Home.md") ?? null;

  return (
    <main className="min-h-screen px-5 pt-8 pb-64 max-w-2xl mx-auto">
      <header className="flex items-center justify-between mb-10 pr-10 lg:pr-0">
        <Link
          href="/"
          className="text-muted text-xs tracking-widest uppercase hover:text-fg transition-colors"
        >
          ← mindboard
        </Link>
        <div className="flex items-center gap-4">
          <h1 className="text-xs tracking-widest uppercase text-muted">
            brain
          </h1>
          <Link
            href="/brain/graph"
            data-tour="brain-graph-link"
            className="text-xs tracking-widest uppercase text-muted hover:text-fg transition-colors min-h-11 flex items-center"
          >
            graph →
          </Link>
          <RefreshButton />
        </div>
      </header>

      {connectionError ? (
        <div className="space-y-6">
          <p className="text-sm text-muted border border-line px-4 py-3">
            vault unavailable — {connectionError.toLowerCase()}
          </p>
          <VaultSettingsForm
            initialRepo={settings.repo}
            initialBranch={settings.branch}
            connected
          />
        </div>
      ) : corpus ? (
        <>
          {home ? (
            <NoteView note={home} corpus={corpus} />
          ) : (
            <p className="text-sm text-muted">
              no Home.md found at the vault root.
            </p>
          )}
          <FolderListing corpus={corpus} />
          <p className="mt-12 border-t border-line pt-4">
            <Link
              href="/settings"
              className="text-xs tracking-widest uppercase text-muted hover:text-fg transition-colors min-h-11 inline-flex items-center"
            >
              vault settings — {settings.repo} →
            </Link>
          </p>
        </>
      ) : null}
    </main>
  );
}
