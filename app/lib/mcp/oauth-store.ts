import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/utils/supabase/service";
import { hashCode, newJti, parseClientId } from "./oauth";

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

// ---------- refresh-token families (audit M2) ----------

// What the next refresh token should say: which family, and its place in that
// family's chain.
export type GrantHandle = { id: string; jti: string };

export type CreateGrantResult =
  | { status: "ok"; grant: GrantHandle }
  | { status: "unprotected" } // table missing; issue a familyless token
  | { status: "error" };

// One authorization-code exchange opens one family. Everything the settings
// "connected apps" list shows comes from this row, and revoking it is what
// makes a refresh token stop working.
export async function createGrant(input: {
  userId: string;
  clientId: string;
  clientName: string | null;
}): Promise<CreateGrantResult> {
  const jti = newJti();
  const stamp = new Date().toISOString();

  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from("oauth_grants")
      .insert({
        user_id: input.userId,
        client_id: input.clientId,
        client_name: input.clientName,
        created_at: stamp,
        last_used_at: stamp,
        current_refresh_jti: jti,
      })
      .select("id")
      .single();

    if (error) {
      if (tableMissing(error)) {
        warnTableMissing("oauth_grants");
        return { status: "unprotected" };
      }
      return { status: "error" };
    }
    const id = (data as { id?: unknown } | null)?.id;
    if (typeof id !== "string") return { status: "error" };
    return { status: "ok", grant: { id, jti } };
  } catch {
    return { status: "error" };
  }
}

export type RotateResult =
  | { status: "ok"; grant: GrantHandle }
  | { status: "reuse" } // a superseded jti — the family is now revoked
  | { status: "revoked" } // gone, or revoked from /settings
  | { status: "client_mismatch" }
  | { status: "raced" } // another refresh rotated first; not an attack
  | { status: "unprotected" }
  | { status: "error" };

// Rotate a family forward one step. Every outcome but "ok" is invalid_grant at
// the endpoint; they are distinguished here because only ONE of them
// (`reuse`) means the family is compromised and gets revoked.
export async function rotateRefreshToken(input: {
  grantId: string;
  userId: string;
  clientId: string;
  jti: string;
}): Promise<RotateResult> {
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from("oauth_grants")
      .select("id, client_id, revoked_at, current_refresh_jti")
      .eq("id", input.grantId)
      .eq("user_id", input.userId)
      .maybeSingle();

    if (error) {
      if (tableMissing(error)) {
        warnTableMissing("oauth_grants");
        return { status: "unprotected" };
      }
      return { status: "error" };
    }

    const grant = data as {
      client_id?: string;
      revoked_at?: string | null;
      current_refresh_jti?: string | null;
    } | null;
    if (!grant) return { status: "revoked" };
    if (grant.revoked_at) return { status: "revoked" };
    if (grant.client_id !== input.clientId) return { status: "client_mismatch" };

    if (grant.current_refresh_jti !== input.jti) {
      // The presented token was already rotated away. Either it leaked and the
      // thief is using it, or it leaked and the legitimate client is — there
      // is no way to tell, so the whole family dies (RFC 9700 §4.14.2).
      // If the revoke itself fails, say so: answering "revoked" while the
      // family is still live would be a lie the caller acts on.
      const revokeError = await revokeGrantRow(supabase, input.userId, input.grantId);
      return revokeError ? { status: "error" } : { status: "reuse" };
    }

    const next = newJti();
    const { data: rotated, error: rotateError } = await supabase
      .from("oauth_grants")
      .update({ current_refresh_jti: next, last_used_at: new Date().toISOString() })
      // Compare-and-swap on the jti we just read: two refreshes racing on the
      // same token must not both mint a successor.
      .eq("id", input.grantId)
      .eq("user_id", input.userId)
      .eq("current_refresh_jti", input.jti)
      .is("revoked_at", null)
      .select("id");

    if (rotateError) {
      if (tableMissing(rotateError)) {
        warnTableMissing("oauth_grants");
        return { status: "unprotected" };
      }
      return { status: "error" };
    }
    // Losing the CAS is a lost race, NOT reuse: the read above already proved
    // the jti was current, so revoking here would kill a grant over a
    // double-submitted refresh.
    if (!Array.isArray(rotated) || rotated.length === 0) return { status: "raced" };

    return { status: "ok", grant: { id: input.grantId, jti: next } };
  } catch {
    return { status: "error" };
  }
}

// Pre-0059 refresh tokens carry no family, so they can be neither rotated nor
// revoked. They are honoured only while the grants table is absent — the
// cutover window — and refused the moment it exists, which costs each
// connector exactly one re-authorization.
// Takes the owner id purely so this query carries the same explicit user_id
// filter every other service-client read in the app does — the multi-tenant
// invariant is textual as much as behavioural, and an unfiltered service query
// is the shape a reviewer has to stop on.
export async function legacyRefreshAllowed(
  ownerId: string,
): Promise<"allow" | "deny" | "error"> {
  try {
    const supabase = createServiceClient();
    const { error } = await supabase
      .from("oauth_grants")
      .select("id")
      .eq("user_id", ownerId)
      .limit(1);
    if (error) {
      if (tableMissing(error)) {
        warnTableMissing("oauth_grants");
        return "allow";
      }
      return "error";
    }
    return "deny";
  } catch {
    return "error";
  }
}

// ---------- settings: connected apps ----------

export type ConnectedApp = {
  id: string;
  // The host the authorization code was delivered to. This is the identity
  // the list leads with: it had to clear the registration host allow-list,
  // unlike clientName, which a registration simply asserts.
  host: string;
  clientName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

const UNKNOWN_HOST = "unknown host";

// client_id is a signed token carrying the client's registered redirect_uris.
// It can be past its own 1-year exp by the time this list renders, so a grant
// whose client_id no longer verifies still has to show something.
function grantHost(clientId: unknown): string {
  if (typeof clientId !== "string") return UNKNOWN_HOST;
  const uri = parseClientId(clientId)?.redirectUris[0];
  if (!uri) return UNKNOWN_HOST;
  try {
    return new URL(uri).host;
  } catch {
    return UNKNOWN_HOST;
  }
}

// Read for /settings. Every failure — including the pre-0059 missing table —
// reports an empty list rather than breaking the page; this is a display read,
// and the security-relevant paths above are the ones that warn.
export async function listConnectedApps(userId: string): Promise<ConnectedApp[]> {
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from("oauth_grants")
      .select("id, client_id, client_name, created_at, last_used_at")
      .eq("user_id", userId)
      .is("revoked_at", null)
      .order("created_at", { ascending: false });

    if (error || !Array.isArray(data)) return [];
    return data.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: String(r.id),
        host: grantHost(r.client_id),
        clientName: typeof r.client_name === "string" ? r.client_name : null,
        createdAt: String(r.created_at),
        lastUsedAt: typeof r.last_used_at === "string" ? r.last_used_at : null,
      };
    });
  } catch {
    return [];
  }
}

async function revokeGrantRow(
  supabase: SupabaseClient,
  userId: string,
  grantId: string,
): Promise<string | null> {
  const { error } = await supabase
    .from("oauth_grants")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", grantId)
    .eq("user_id", userId)
    .is("revoked_at", null);
  return error ? "could not revoke this connection" : null;
}

// Revocation stops refreshes at once. An access token already in flight stays
// valid until its own 1-hour exp, because access tokens are deliberately
// stateless — checking a row on every MCP call would put the database in front
// of every tool invocation.
export async function revokeConnectedApp(
  userId: string,
  grantId: string,
): Promise<{ error: string | null }> {
  try {
    return { error: await revokeGrantRow(createServiceClient(), userId, grantId) };
  } catch {
    return { error: "could not revoke this connection" };
  }
}

export async function revokeAllConnectedApps(
  userId: string,
): Promise<{ error: string | null }> {
  try {
    const supabase = createServiceClient();
    const { error } = await supabase
      .from("oauth_grants")
      .update({ revoked_at: new Date().toISOString() })
      .eq("user_id", userId)
      .is("revoked_at", null);
    return { error: error ? "could not revoke these connections" : null };
  } catch {
    return { error: "could not revoke these connections" };
  }
}
