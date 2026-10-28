import { redirect } from "next/navigation";

import { createClient } from "@/utils/supabase/server";
import { getUserPreferences } from "@/app/lib/data/settings";
import { safeTimeZone } from "@/app/_components/date-utils";
import {
  confirmableInApp,
  proposalChannel,
  requiresAppApproval,
} from "@/app/lib/mcp/approval";
import { ApprovalsClient, type PendingProposal } from "./approvals-client";

// The approvals inbox: every write any AI surface has proposed and nobody has
// answered yet, from one place. It exists because a chat client can no longer
// confirm the risky kinds for itself (audit 2026-10-26, H2) — this is the
// different channel those proposals get routed to.

// A pending row is small and the list is an inbox, not an archive; past this
// many the user has a bigger problem than paging.
const MAX_PENDING = 100;

type AuditRow = {
  id: string;
  tool_name: string;
  summary: string | null;
  input: Record<string, unknown> | null;
  source: string | null;
  created_at: string;
};

export default async function ApprovalsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data }, prefs] = await Promise.all([
    supabase
      .from("ai_audit_log")
      .select("id, tool_name, summary, input, source, created_at")
      .eq("user_id", user.id)
      .eq("status", "proposed")
      .order("created_at", { ascending: false })
      .limit(MAX_PENDING),
    getUserPreferences(user.id),
  ]);

  // Stamped in the user's stored zone on the server, so the time a proposal
  // landed reads the same on every device (AGENTS.md's timezone convention).
  const timeZone = safeTimeZone(prefs.timezone);
  const stamp = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone ?? undefined,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const items: PendingProposal[] = ((data ?? []) as AuditRow[]).map((row) => ({
    id: row.id,
    tool: row.tool_name,
    preview: row.summary?.trim() || `${row.tool_name} (no preview recorded)`,
    at: stamp.format(new Date(row.created_at)),
    channel: proposalChannel(row.source, row.input),
    needsYou: requiresAppApproval(row.tool_name, row.input),
    approvable: confirmableInApp(row.tool_name),
  }));

  return (
    <main className="min-h-screen px-5 pt-6 pb-40 max-w-2xl mx-auto">
      <header className="mb-5">
        <h1 className="text-label uppercase text-muted">approvals</h1>
        <p className="mt-2 text-meta text-muted leading-relaxed">
          writes i&apos;ve proposed and you haven&apos;t answered yet. nothing here has
          happened. the risky ones i can&apos;t confirm for myself, wherever they were
          asked for — they wait for your tap.
        </p>
      </header>

      <ApprovalsClient items={items} />
    </main>
  );
}
