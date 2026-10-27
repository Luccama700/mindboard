import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/utils/supabase/service";
import { hashCode } from "./oauth";

// The stateful half of the MCP authorization server (migration 0059).
//
// Everything a signature can prove stays in the token (app/lib/mcp/oauth.ts).
// This module owns the two facts a signature cannot: whether an authorization
// code has already been spent, and whether a refresh family is still live.
// Both tables have RLS enabled with no policies, so they are reachable only
// through the service client here — which means every query must filter
// user_id itself.
//
// CUTOVER. The code ships before Lucca applies 0059. While a table is missing
// the store fails OPEN (the pre-0059 stateless behaviour, so live claude.ai
// connectors keep working) and warns once per cold start. Every OTHER database
// fault fails CLOSED: "the database is unreachable" must never read as "this
// code is unused".

type StoreError = { code?: string | null } | null;

// Undefined table. PostgREST normally answers an unknown table out of its
// schema cache (PGRST205) and only surfaces the raw Postgres undefined_table
// (42P01) when that cache is ahead of the database — both mean the same thing
// here: 0059 is not applied on this deployment yet. (Expect a minute of
// PGRST205 right after it IS applied, while the cache catches up.)
function tableMissing(error: StoreError): boolean {
  const code = error?.code ?? "";
  return code === "42P01" || code === "PGRST205";
}

const UNIQUE_VIOLATION = "23505";

const warnedTables = new Set<string>();

// Fixed label, no request data: every server console.* in this app logs a
// constant plus (at most) an Error, never a payload.
function warnTableMissing(table: string): void {
  if (warnedTables.has(table)) return;
  warnedTables.add(table);
  console.warn(
    `[oauth] ${table} is missing — failing open until migration 0059_oauth_grants is applied`,
  );
}

// ---------- single-use authorization codes (audit M1) ----------

export type ConsumeCodeResult =
  | { status: "ok" } // first exchange; the code is now spent
  | { status: "replay" } // already spent — the finding this closes
  | { status: "unprotected" } // table missing; failed open
  | { status: "error" }; // database fault; fail closed

// Records the code as spent. The primary key IS the single-use guarantee, so
// this stays a bare insert: a unique violation means some earlier exchange
// already won the race. Call it only after the signature, client, redirect and
// PKCE checks pass — otherwise a probe with a wrong verifier could burn a
// legitimate user's code.
export async function consumeAuthorizationCode(
  code: string,
  expiresAtSeconds: number,
): Promise<ConsumeCodeResult> {
  let supabase: SupabaseClient;
  try {
    supabase = createServiceClient();
  } catch {
    return { status: "error" };
  }

  try {
    const { error } = await supabase.from("oauth_used_codes").insert({
      code_hash: hashCode(code),
      expires_at: new Date(expiresAtSeconds * 1000).toISOString(),
    });

    if (error) {
      if (error.code === UNIQUE_VIOLATION) return { status: "replay" };
      if (tableMissing(error)) {
        warnTableMissing("oauth_used_codes");
        return { status: "unprotected" };
      }
      return { status: "error" };
    }
  } catch {
    return { status: "error" };
  }

  await sweepExpiredCodes(supabase);
  return { status: "ok" };
}

// Opportunistic GC. A spent-code row is useless past the code's own 60s exp,
// and token exchanges are rare (one per connector authorization), so one
// indexed delete per successful exchange keeps the table empty without a cron.
// Never fails the exchange.
async function sweepExpiredCodes(supabase: SupabaseClient): Promise<void> {
  try {
    await supabase
      .from("oauth_used_codes")
      .delete()
      .lt("expires_at", new Date().toISOString());
  } catch {
    // ignore: housekeeping, not correctness
  }
}
