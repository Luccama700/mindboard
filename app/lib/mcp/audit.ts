import "server-only";
import { createServiceClient } from "@/utils/supabase/service";

// The ai_audit_log-backed proposal store. Because MCP is stateless, the audit
// row IS the proposal state: a write tool records a 'proposed' row and returns
// its id; confirm_action looks it up and resolves it. Nothing executes without
// a row here (the plan's locked write-with-confirmation rule). MCP rows carry
// source='mcp'.
//
// Every function here runs on the SERVICE client and filters by user_id itself
// (audit 2026-10-26, M7). The row is a security record, not user data: with the
// cookie client a signed-in user could flip their own 'executed' row back to
// 'proposed' and replay the write, or rewrite created_at to defeat spawn_urc's
// five-minute age check. Migration 0060 drops the client insert/update/delete
// policies so the database agrees; the code is correct either way, and the
// explicit .eq("user_id", …) on every query is what replaces RLS here.
//
// Callers therefore pass a userId, never a client. A session-authenticated
// caller MUST derive that id from supabase.auth.getUser(), never from input.

export type AuditStatus =
  | "proposed"
  | "executing"
  | "executed"
  | "rejected"
  | "error";

export type AuditProposal = {
  id: string;
  tool_name: string;
  input: Record<string, unknown>;
  summary: string;
  status: AuditStatus;
  created_at: string | null;
};

// What an executor knows about the confirm that invoked it, beyond the stored
// input. Carried because the input itself is NOT trustworthy: a 'proposed' row
// could have been forged while clients could still insert them, and rows
// predating migration 0060 were. An executor that cares who confirmed it (URC:
// only an OAuth/PAT MCP credential may start a session on the PC) or how old
// the proposal is (URC: five minutes) must read it from here and re-validate
// the rest against server state.
//
// authKind is namespaced by the confirm path: `mcp:<clientId>` from the MCP
// server, "assistant" from the in-app confirm rail, "watch" from the watch.
export type ExecutorContext = {
  proposalId: string;
  proposedAt: string | null;
  authKind: string;
};

export async function recordProposal(
  ownerId: string,
  toolName: string,
  input: Record<string, unknown>,
  summary: string,
  options?: { source?: "mcp" | "assistant"; conversationId?: string | null },
): Promise<string> {
  const { data, error } = await createServiceClient()
    .from("ai_audit_log")
    .insert({
      user_id: ownerId,
      source: options?.source ?? "mcp",
      conversation_id: options?.conversationId ?? null,
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
  ownerId: string,
  proposalId: string,
): Promise<AuditProposal | null> {
  const { data } = await createServiceClient()
    .from("ai_audit_log")
    .select("id, tool_name, input, summary, status, created_at")
    .eq("id", proposalId)
    .eq("user_id", ownerId)
    .eq("status", "proposed")
    .maybeSingle();
  return (data as AuditProposal | null) ?? null;
}

// Resolve a proposal, guarded on status='proposed' so a second confirm can't
// re-run an already-applied write. Returns false if nothing was still pending.
export async function resolveProposal(
  ownerId: string,
  proposalId: string,
  status: Exclude<AuditStatus, "proposed">,
  result: Record<string, unknown> | null,
): Promise<boolean> {
  const { data, error } = await createServiceClient()
    .from("ai_audit_log")
    .update({ status, result, resolved_at: new Date().toISOString() })
    .eq("id", proposalId)
    .eq("user_id", ownerId)
    .eq("status", "proposed")
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

// Claim a proposal for execution BEFORE running the executor: an atomic
// proposed → 'executing' flip guarded on status='proposed'. Only one caller can
// win, so a concurrent confirm (double-tap / client retry) can't also run the
// executor and double-apply the write. Returns false if it was already claimed
// or resolved. The row reads 'executing' only while the write is in flight;
// finalizeClaimedProposal then flips it to 'executed' (with result) or 'error'.
// A mid-execution crash therefore leaves a distinguishable 'executing' row, not
// a fake-completed 'executed' one. Requires migration 0035.
export async function claimProposal(
  ownerId: string,
  proposalId: string,
): Promise<boolean> {
  const { data, error } = await createServiceClient()
    .from("ai_audit_log")
    .update({ status: "executing" })
    .eq("id", proposalId)
    .eq("user_id", ownerId)
    .eq("status", "proposed")
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

// Record the outcome of a claimed proposal (result on success, or flip to
// 'error'). Guarded on status='executing' — the claim we already hold.
export async function finalizeClaimedProposal(
  ownerId: string,
  proposalId: string,
  status: "executed" | "error",
  result: Record<string, unknown> | null,
): Promise<void> {
  const { error } = await createServiceClient()
    .from("ai_audit_log")
    .update({ status, result, resolved_at: new Date().toISOString() })
    .eq("id", proposalId)
    .eq("user_id", ownerId)
    .eq("status", "executing");
  if (error) throw new Error(error.message);
}
