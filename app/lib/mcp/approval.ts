// Which proposals a chat model may NOT confirm for itself (audit 2026-10-26, H2).
//
// Propose → confirm is only consent when the confirming hand is a different one
// from the proposing hand. Over MCP it is not: the same model that calls a
// propose tool can call confirm_action in the next breath, so a prompt injected
// into text the model READ — a vault Daily Brief built from email/WhatsApp, a
// reel transcript, a task note — can propose and confirm a destructive or
// financial write without the user ever seeing it.
//
// The answer is not to ban self-confirm (additive, low-risk writes are the
// whole point of the assistant) but to route the dangerous kinds through a
// channel a model cannot reach: a tap in Mindboard at /approvals, or the watch.
// This module is the pure predicate that says which those are. The gate itself
// lives in confirmAction (app/lib/mcp/writes.ts), which applies it only to
// `mcp:` credentials — the in-app rail and the watch ARE the human channel.
//
// It reads a proposal's STORED input, which for the batch tools is the resolved
// op array ({ operations: [{ kind: … }] }), not the raw tool arguments. It also
// accepts the raw `op` spelling, because an ai_audit_log 'proposed' row is
// forgeable by its own user (M7) and a hand-written row could carry either.

export const APP_APPROVAL_PATH = "/approvals";

// Op kinds that destroy or hide data, per batch tool. Matched against both the
// resolved `kind` and the raw `op` discriminator.
const FINANCE_GATED_OPS = new Set(["remove", "adjust", "reconcile"]);
const PEOPLE_GATED_OPS = new Set(["archive", "delete"]);
// update_stock has no delete op today (ResolvedStockOp stops at `archive`,
// which `restore` undoes). Listed so a future hard delete is gated the day it
// lands rather than the day someone notices.
const STOCK_GATED_OPS = new Set(["delete", "delete_forever"]);

function operationsOf(input: unknown): Record<string, unknown>[] {
  if (typeof input !== "object" || input === null) return [];
  const ops = (input as { operations?: unknown }).operations;
  if (!Array.isArray(ops)) return [];
  return ops.filter(
    (op): op is Record<string, unknown> =>
      typeof op === "object" && op !== null && !Array.isArray(op),
  );
}

// The resolved shape keys on `kind`; the raw (and forgeable) shape on `op`.
function discriminator(op: Record<string, unknown>): string {
  const kind = op.kind;
  if (typeof kind === "string" && kind) return kind;
  const raw = op.op;
  return typeof raw === "string" ? raw : "";
}

function anyOp(input: unknown, match: (op: Record<string, unknown>) => boolean): boolean {
  return operationsOf(input).some(match);
}

export function requiresAppApproval(toolName: string, input: unknown): boolean {
  switch (toolName) {
    // Irreversible.
    case "delete_task":
    case "delete_spend_limit":
      return true;

    // Spends the user's API credits.
    case "generate_audio_overview":
      return true;

    // Timezone, wake window, shopping day: quiet levers under every projection
    // and every "today" the agent itself reads back.
    case "update_settings":
      return true;

    // The overnight harness builds and runs code on the PC off 'approved'.
    // validateUpdateTask already refuses it at propose time (E2); this is the
    // confirm-side half, because the stored input of a forged row never passed
    // through that validator.
    case "update_task":
      return (
        typeof input === "object" &&
        input !== null &&
        (input as { aiState?: unknown }).aiState === "approved"
      );

    // Ledger corrections and reconciliation anchors rewrite money that is
    // already recorded. Pure additive imports (spend/income/transfer/create_*)
    // stay chat-confirmable — that is the statement-import flow.
    case "update_finance":
      return anyOp(input, (op) => FINANCE_GATED_OPS.has(discriminator(op)));

    // Finance configuration: archiving an account, category, recurring rule or
    // income source silently changes every forecast. `archived: true` is the
    // only delete/archive-type action in the manage_finance union.
    case "manage_finance":
      return anyOp(input, (op) => op.archived === true);

    case "update_people":
      return anyOp(input, (op) => PEOPLE_GATED_OPS.has(discriminator(op)));

    case "update_stock":
      return anyOp(input, (op) => STOCK_GATED_OPS.has(discriminator(op)));

    // Deliberately NOT gated: spawn_urc already requires an `mcp:` credential
    // that is not the shared static bearer, the spawned session starts idle
    // (no starting prompt in v1), and the only way to drive it is the private
    // claude.ai/code link returned to the owner's own account. Gating it in the
    // app would cost the one-tap-from-chat flow the feature exists for.
    default:
      return false;
  }
}

// State-dependent half of the build gate. Once a task is 'approved' the
// overnight harness builds whatever its notes' latest "## AI plan" says (and
// its title names), so rewriting either between approval and the build would
// let a chat change what runs on the PC without a human seeing it. The harness
// itself never writes notes or title while a task is 'approved' — it flips the
// task to 'building' first — so gating only that state costs it nothing.
export function editsApprovedBuildPlan(
  toolName: string,
  input: unknown,
  currentAiState: string | null | undefined,
): boolean {
  if (toolName !== "update_task" || currentAiState !== "approved") return false;
  if (typeof input !== "object" || input === null) return false;
  const v = input as { notes?: unknown; title?: unknown };
  return v.notes !== undefined || v.title !== undefined;
}

// Which surface a pending proposal came from, derived from the stored row.
// `source` only distinguishes the in-app copilot from everything external; the
// watch records source 'mcp' (it is an external client of the same class) and
// is told apart by the idempotency key it alone writes into the input
// (app/lib/watch/writes.ts).
export type ProposalChannel = "copilot" | "watch" | "chat" | "unknown";

export function proposalChannel(source: unknown, input: unknown): ProposalChannel {
  if (source === "assistant") return "copilot";
  if (source !== "mcp") return "unknown";
  const key =
    typeof input === "object" && input !== null
      ? (input as { idempotencyKey?: unknown }).idempotencyKey
      : undefined;
  return typeof key === "string" && key ? "watch" : "chat";
}

// Proposals the in-app confirm rail cannot execute: spawn_urc's executor takes
// its credential from the ExecutorContext and refuses anything that is not an
// `mcp:` one (app/lib/urc/auth.ts), so approving it from a browser session
// would only ever produce an error. The approvals inbox offers reject only.
export function confirmableInApp(toolName: string): boolean {
  return toolName !== "spawn_urc";
}

// What the MCP confirm_action hands back when the gate fires. The proposal row
// is left untouched at 'proposed' so the user can approve the very same one.
export function appApprovalMessage(toolName: string): string {
  return (
    `${toolName} needs the user's own approval in Mindboard — a chat client cannot confirm it. ` +
    `The proposal is still pending: ask the user to open Mindboard at ${APP_APPROVAL_PATH} and approve or reject it there. ` +
    `Do not retry confirm_action for this proposal.`
  );
}
