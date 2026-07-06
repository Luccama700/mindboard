import { redirect } from "next/navigation";

import { createClient } from "@/utils/supabase/server";

// Placeholder until the copilot milestone lands: /plan is a rail citizen from
// day one so the IA is stable, but the conversation surface arrives with M5.
export default async function PlanPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] | undefined }>;
}) {
  const query = await searchParams;
  const q = Array.isArray(query.q) ? query.q[0] : query.q;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <main className="min-h-screen px-5 pt-6 pb-64 max-w-2xl mx-auto">
      <header className="mb-10">
        <h1 className="text-label uppercase text-muted">plan</h1>
      </header>
      {q && (
        <p className="mb-6 text-body text-fg">
          <span className="text-accent">›</span> {q}
        </p>
      )}
      <div className="border border-hairline px-4 py-6 space-y-2">
        <p className="text-body text-fg">the planning copilot lands here.</p>
        <p className="text-meta text-muted leading-relaxed">
          it will read your tasks, money, stock, and schedule, and propose
          plans you confirm — nothing is ever written without your tap. until
          then, the week view is one tab away.
        </p>
      </div>
    </main>
  );
}
