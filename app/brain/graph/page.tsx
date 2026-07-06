import Link from "next/link";
import { redirect } from "next/navigation";

import { createClient } from "@/utils/supabase/server";
import { isVaultOwner } from "@/app/lib/brain/access";
import { buildGraphData } from "@/app/lib/brain/graph";
import {
  getVaultCorpus,
  VaultConnectionError,
} from "@/app/lib/brain/vault";
import { GraphClient } from "./graph-client";

export default async function BrainGraphPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");
  if (!isVaultOwner(user.id)) redirect("/");

  let data = null;
  let connectionError: string | null = null;
  try {
    const corpus = await getVaultCorpus();
    data = buildGraphData([...corpus.notes.values()]);
  } catch (error) {
    if (error instanceof VaultConnectionError) {
      connectionError = error.message;
    } else {
      throw error;
    }
  }

  return (
    <main className="h-dvh flex flex-col">
      <header className="flex items-center justify-between px-5 pt-8 pb-6 shrink-0">
        <Link
          href="/brain"
          className="text-muted text-xs tracking-widest uppercase hover:text-fg transition-colors"
        >
          ← brain
        </Link>
        <h1 className="text-xs tracking-widest uppercase text-muted">graph</h1>
      </header>

      {connectionError || !data ? (
        <p className="text-sm text-muted border border-line px-4 py-3 mx-5">
          vault unavailable —{" "}
          {(connectionError ?? "no data").toLowerCase()}
        </p>
      ) : (
        <GraphClient data={data} />
      )}
    </main>
  );
}
