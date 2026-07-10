import { NextResponse } from "next/server";
import { getPublicOrigin } from "mcp-handler";
import { createClient } from "@/utils/supabase/server";
import { isAllowedRedirect, issueCode, parseClientId } from "@/app/lib/mcp/oauth";

// OAuth authorization endpoint. Validates the client + PKCE params, then uses
// the app's existing Supabase Google session as the identity: whoever is signed
// in authorizes access to THEIR OWN data (the issued token's sub is their user
// id, and every MCP tool scopes to it). On approval it issues a short-lived
// authorization code and redirects back to the client. If nobody is signed in,
// it bounces through /login and returns here.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorPage(message: string, status: number): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain" } });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const p = url.searchParams;
  const clientId = p.get("client_id") ?? "";
  const redirectUri = p.get("redirect_uri") ?? "";
  const responseType = p.get("response_type") ?? "";
  const codeChallenge = p.get("code_challenge") ?? "";
  const codeChallengeMethod = p.get("code_challenge_method") ?? "";
  const state = p.get("state") ?? "";

  // Validate the client + redirect_uri BEFORE trusting the redirect target.
  const client = parseClientId(clientId);
  if (!client) return errorPage("invalid client_id", 400);
  if (!isAllowedRedirect(redirectUri, client.redirectUris)) {
    return errorPage("redirect_uri not registered for this client", 400);
  }

  const redirect = new URL(redirectUri);
  const fail = (error: string, desc?: string): Response => {
    redirect.searchParams.set("error", error);
    if (desc) redirect.searchParams.set("error_description", desc);
    if (state) redirect.searchParams.set("state", state);
    return NextResponse.redirect(redirect, 302);
  };

  if (responseType !== "code") return fail("unsupported_response_type");
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    return fail("invalid_request", "PKCE with S256 is required");
  }

  // Session gate — reuse the app's Supabase Google login. Any signed-in user
  // may authorize; the code binds to their own user id.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const self = `/api/mcp/oauth/authorize${url.search}`;
    const login = new URL(`/login?next=${encodeURIComponent(self)}`, getPublicOrigin(request));
    return NextResponse.redirect(login, 302);
  }

  const code = issueCode({ ownerId: user.id, clientId, redirectUri, codeChallenge });
  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);
  return NextResponse.redirect(redirect, 302);
}
