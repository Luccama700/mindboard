import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { createClient } from "@/utils/supabase/server";
import {
  findNote,
  getVaultCorpus,
  VaultConnectionError,
  VaultNotConfiguredError,
} from "@/app/lib/brain/vault";
import { NoteView } from "../../_components/note-view";
import { RefreshButton } from "../../_components/refresh-button";

export default async function BrainNotePage(props: {
  params: Promise<{ path: string[] }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { path } = await props.params;
  const notePath = path.join("/") + ".md";

  let connectionError: string | null = null;
  let note = null;
  let corpus = null;
  try {
    corpus = await getVaultCorpus(user.id);
    note = findNote(corpus, notePath);
  } catch (error) {
    if (error instanceof VaultNotConfiguredError) {
      redirect("/brain");
    } else if (error instanceof VaultConnectionError) {
      connectionError = error.message;
    } else {
      throw error;
    }
  }

  if (!connectionError && !note) notFound();

  return (
    <main className="min-h-screen px-5 pt-8 pb-64 max-w-2xl mx-auto">
      <header className="flex items-center justify-between mb-10">
        <Link
          href="/brain"
          className="text-muted text-xs tracking-widest uppercase hover:text-fg transition-colors"
        >
          ← brain
        </Link>
        <div className="flex items-center gap-4">
          <h1 className="text-xs tracking-widest uppercase text-muted truncate max-w-[50vw]">
            {note ? note.title.toLowerCase() : "note"}
          </h1>
          <RefreshButton />
        </div>
      </header>

      {connectionError ? (
        <p className="text-sm text-muted glass-panel px-4 py-3">
          vault unavailable — {connectionError.toLowerCase()}
        </p>
      ) : note && corpus ? (
        <>
          <NoteView note={note} corpus={corpus} />
          <p className="mt-10 border-t border-hairline pt-4">
            <Link
              href={`/plan?q=${encodeURIComponent(copilotPrompt(note.title, note.body))}`}
              className="text-label uppercase text-muted hover:text-fg transition-colors min-h-11 inline-flex items-center"
            >
              send to copilot ◇
            </Link>
          </p>
        </>
      ) : null}
    </main>
  );
}

// The first knowledge → planning bridge: hand the note (title + a plain-text
// excerpt) to /plan as the opening message.
function copilotPrompt(title: string, body: string): string {
  const excerpt = body
    .replace(/[#>*`[\]|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
  return `about my note "${title}": ${excerpt}${excerpt.length >= 280 ? "…" : ""} — help me act on it`;
}
