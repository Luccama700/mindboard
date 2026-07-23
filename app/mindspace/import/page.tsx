import Link from "next/link";
import { redirect } from "next/navigation";

import { createClient } from "@/utils/supabase/server";
import { countExternalSessions } from "@/app/lib/mindspace/sessions";
import { ImportClient } from "./import-client";

export default async function MindspaceImportPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const counts = await countExternalSessions(supabase, user.id);

  return (
    <main className="min-h-screen px-5 pt-8 pb-64 max-w-2xl mx-auto">
      <header className="flex items-center justify-between mb-10 pr-10 lg:pr-0">
        <Link
          href="/mindspace"
          className="text-muted text-xs tracking-widest uppercase hover:text-fg transition-colors"
        >
          ← mindspace
        </Link>
        <h1 className="text-xs tracking-widest uppercase text-muted">
          import
        </h1>
      </header>
      <ImportClient
        claudeAiCount={counts.claudeAi}
        claudeCodeCount={counts.claudeCode}
      />
    </main>
  );
}
