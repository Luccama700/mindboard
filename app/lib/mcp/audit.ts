import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// The ai_audit_log-backed proposal store. Because MCP is stateless, the audit
// row IS the proposal state: a write tool records a 'proposed' row and returns
// its id; confirm_action looks it up and resolves it. Nothing executes without
// a row here (the plan's locked write-with-confirmation rule). MCP rows carry
// source='mcp'.

export type AuditStatus = "proposed" | "executed" | "rejected" | "error";

export type AuditProposal = {
  id: string;
  tool_name: string;
  input: Record<string, unknown>;
  summary: string;
  status: AuditStatus;
};

export async function recordProposal(
  supabase: SupabaseClient,
  ownerId: string,
  toolName: string,
  input: Record<string, unknown>,
  summary: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("ai_audit_log")
    .insert({
      user_id: ownerId,
      source: "mcp",
      status: "proposed",
      tool_name: toolName,
      input,
      summary,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "failed to record proposal");
  }
  return data.id as string;
}

export async function loadProposal(
  supabase: SupabaseClient,
  ownerId: string,
  proposalId: string,
): Promise<AuditProposal | null> {
  const { data } = await supabase
    .from("ai_audit_log")
    .select("id, tool_name, input, summary, status")
    .eq("id", proposalId)
    .eq("user_id", ownerId)
    .eq("status", "proposed")
    .maybeSingle();
  return (data as AuditProposal | null) ?? null;
}

// Resolve a proposal, guarded on status='proposed' so a second confirm can't
// re-run an already-applied write. Returns false if nothing was still pending.
export async function resolveProposal(
  supabase: SupabaseClient,
  ownerId: string,
  proposalId: string,
  status: Exclude<AuditStatus, "proposed">,
  result: Record<string, unknown> | null,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("ai_audit_log")
    .update({ status, result, resolved_at: new Date().toISOString() })
    .eq("id", proposalId)
    .eq("user_id", ownerId)
    .eq("status", "proposed")
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}
