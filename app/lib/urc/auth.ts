import "server-only";
import type { Result } from "../mcp/validate";
import { URC_NOT_AVAILABLE } from "./preview";

// Layer 1 of URC's three gates (see supabase/migrations/0054_urc.sql): the
// server env names exactly one user who may touch URC at all, and the shared
// static MCP bearer is refused even for that user.
//
// Why the static token is refused: MCP_BEARER_TOKEN is one long-lived secret
// that already sits in worker/worker.env and overnight/.env on this machine and
// maps straight to the owner. Starting an interactive session on the PC is the
// one MCP capability where "whoever holds the shared token is the owner" is too
// weak, so URC accepts only an OAuth token from claude.ai.
//
// Why PATs are refused too (audit 2026-10-26 M3): a user has exactly one PAT
// (user_settings.mcp_token_hash), and the owner's sits in overnight/.env on the
// same PC where the dispatch agent runs with Bash(*). A credential stored on
// disk next to an agent can't be the one that starts interactive sessions.

export const URC_MCP_PREFIX = "mcp:";

export const URC_STATIC_REFUSED =
  "URC can't be driven with the shared static MCP token — connect over OAuth (claude.ai)";

export const URC_PAT_REFUSED =
  "URC can't be driven with a personal access token — connect over OAuth (claude.ai)";

export const URC_NON_MCP_REFUSED =
  "URC sessions can only be started from the Mindboard MCP server";

export function urcOwnerUserId(): string | null {
  const id = (process.env.URC_OWNER_USER_ID ?? "").trim();
  return id ? id : null;
}

// Whether to expose the URC tools at all. The MCP tool list is built once per
// request without the caller's identity in scope, so the tools cannot be hidden
// per user; they are hidden when the deployment has no URC owner configured,
// and every handler re-checks the caller regardless.
export function urcConfigured(): boolean {
  return urcOwnerUserId() !== null;
}

// The namespaced auth kind every URC entry point takes. Namespacing is what
// makes the check an allowlist: a raw clientId would make "assistant" or
// "watch" indistinguishable from an OAuth client name.
export function mcpAuthKind(clientId: string | null | undefined): string {
  return `${URC_MCP_PREFIX}${clientId ?? ""}`;
}

// Resolve the caller to the confirmed_auth label stored on the job, or refuse.
// Fails closed: anything that is not an MCP OAuth credential is rejected,
// including a missing kind, PATs, and the in-app assistant / watch confirm
// paths.
export function urcAuth(
  userId: string,
  authKind: string | null | undefined,
): Result<{ confirmedAuth: string }> {
  const owner = urcOwnerUserId();
  if (!owner || userId !== owner) {
    return { ok: false, error: URC_NOT_AVAILABLE };
  }
  if (typeof authKind !== "string" || !authKind.startsWith(URC_MCP_PREFIX)) {
    return { ok: false, error: URC_NON_MCP_REFUSED };
  }
  const clientId = authKind.slice(URC_MCP_PREFIX.length);
  if (!clientId || clientId === "static") {
    return { ok: false, error: URC_STATIC_REFUSED };
  }
  if (clientId === "pat") return { ok: false, error: URC_PAT_REFUSED };
  return { ok: true, value: { confirmedAuth: `oauth:${clientId}` } };
}
