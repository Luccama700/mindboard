import { NextResponse } from "next/server";
import { getPublicOrigin } from "mcp-handler";
import { createClient } from "@/utils/supabase/server";
import {
  isAllowedRedirect,
  issueCode,
  issueConsentTicket,
  parseClientId,
  verifyConsentTicket,
} from "@/app/lib/mcp/oauth";

// OAuth authorization endpoint. Validates the client + PKCE params, then uses
// the app's existing Supabase Google session as the identity: whoever is signed
// in authorizes access to THEIR OWN data (the issued token's sub is their user
// id, and every MCP tool scopes to it). If nobody is signed in, it bounces
// through /login and returns here.
//
// GET only RENDERS a consent form — it never issues a code. The code is issued
// by POST, and only against a signed consent ticket bound to this session and
// these exact client/redirect/PKCE params. A signed-in session alone is not
// proof of intent: registration is unauthenticated, so if GET issued the code,
// any cross-site <img>/iframe/redirect pointing here would silently hand an
// attacker-registered client a full read/write token for the victim's tasks,
// finance, inventory, courses, and vault.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorPage(message: string, status: number): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain" } });
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type Params = {
  clientId: string;
  redirectUri: string;
  responseType: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
};

function read(p: URLSearchParams): Params {
  return {
    clientId: p.get("client_id") ?? "",
    redirectUri: p.get("redirect_uri") ?? "",
    responseType: p.get("response_type") ?? "",
    codeChallenge: p.get("code_challenge") ?? "",
    codeChallengeMethod: p.get("code_challenge_method") ?? "",
    state: p.get("state") ?? "",
  };
}

// Shared validation for both verbs. Returns either a Response to send back
// immediately, or the parsed redirect target to continue with.
function validate(
  q: Params,
): { error: Response } | { redirect: URL; fail: (e: string, d?: string) => Response } {
  const client = parseClientId(q.clientId);
  if (!client) return { error: errorPage("invalid client_id", 400) };
  if (!isAllowedRedirect(q.redirectUri, client.redirectUris)) {
    return { error: errorPage("redirect_uri not registered for this client", 400) };
  }

  const redirect = new URL(q.redirectUri);
  const fail = (error: string, desc?: string): Response => {
    redirect.searchParams.set("error", error);
    if (desc) redirect.searchParams.set("error_description", desc);
    if (q.state) redirect.searchParams.set("state", q.state);
    return NextResponse.redirect(redirect, 302);
  };

  if (q.responseType !== "code") return { error: fail("unsupported_response_type") };
  if (!q.codeChallenge || q.codeChallengeMethod !== "S256") {
    return { error: fail("invalid_request", "PKCE with S256 is required") };
  }
  return { redirect, fail };
}

function consentPage(q: Params, ticket: string, clientName: string | undefined): Response {
  const host = new URL(q.redirectUri).host;
  const who = clientName ? `${clientName} (${host})` : host;
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${esc(value)}">`;

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${esc(who)} — Mindboard</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100dvh; display:grid; place-items:center; padding:24px;
         background:#0d0d0d; color:#f5f0e8;
         font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:15px; line-height:1.5; }
  main { width:100%; max-width:26rem; border:1px solid #2a2a2a; border-radius:14px; padding:22px; }
  h1 { font-size:15px; font-weight:600; margin:0 0 14px; }
  .who { color:#b5ff3c; overflow-wrap:anywhere; }
  ul { margin:14px 0; padding-left:18px; color:#6b6b6b; font-size:13px; }
  p.warn { color:#6b6b6b; font-size:13px; margin:14px 0 0; }
  .row { display:flex; gap:10px; margin-top:20px; }
  button { flex:1; min-height:44px; border-radius:10px; font:inherit; font-size:14px;
           cursor:pointer; border:1px solid #2a2a2a; background:transparent; color:#f5f0e8; }
  button.primary { background:#b5ff3c; color:#0d0d0d; border-color:#b5ff3c; font-weight:600; }
  form { display:contents; }
</style>
</head><body><main>
  <h1>Connect <span class="who">${esc(who)}</span> to Mindboard?</h1>
  <p style="margin:0;color:#6b6b6b;font-size:13px;">It will get full read and write access to:</p>
  <ul>
    <li>tasks, groups, and your calendar</li>
    <li>finance — accounts, ledger, and forecasts</li>
    <li>inventory and shopping list</li>
    <li>courses and your private notes vault</li>
  </ul>
  <p class="warn">Only continue if you just started this from ${esc(host)}. Mindboard will never ask you to open this page from a link.</p>
  <div class="row">
    <form method="POST">
      ${hidden("client_id", q.clientId)}
      ${hidden("redirect_uri", q.redirectUri)}
      ${hidden("response_type", q.responseType)}
      ${hidden("code_challenge", q.codeChallenge)}
      ${hidden("code_challenge_method", q.codeChallengeMethod)}
      ${hidden("state", q.state)}
      ${hidden("consent", ticket)}
      <button type="submit" name="decision" value="deny">Cancel</button>
      <button type="submit" name="decision" value="allow" class="primary">Allow access</button>
    </form>
  </div>
</main></body></html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // Defense in depth: this page must never be framed by the requesting client.
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const q = read(url.searchParams);

  const v = validate(q);
  if ("error" in v) return v.error;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const self = `/api/mcp/oauth/authorize${url.search}`;
    const login = new URL(`/login?next=${encodeURIComponent(self)}`, getPublicOrigin(request));
    return NextResponse.redirect(login, 302);
  }

  const ticket = issueConsentTicket({
    ownerId: user.id,
    clientId: q.clientId,
    redirectUri: q.redirectUri,
    codeChallenge: q.codeChallenge,
  });
  return consentPage(q, ticket, parseClientId(q.clientId)?.clientName);
}

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const get = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };
  const q: Params = {
    clientId: get("client_id"),
    redirectUri: get("redirect_uri"),
    responseType: get("response_type"),
    codeChallenge: get("code_challenge"),
    codeChallengeMethod: get("code_challenge_method"),
    state: get("state"),
  };

  const v = validate(q);
  if ("error" in v) return v.error;

  // Re-read the session on the POST: the ticket is only meaningful against the
  // user who is actually signed in right now.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return v.fail("access_denied", "not signed in");

  if (get("decision") !== "allow") return v.fail("access_denied");

  const ok = verifyConsentTicket(get("consent"), {
    ownerId: user.id,
    clientId: q.clientId,
    redirectUri: q.redirectUri,
    codeChallenge: q.codeChallenge,
  });
  if (!ok) return v.fail("access_denied", "consent expired or invalid — start again");

  const code = issueCode({
    ownerId: user.id,
    clientId: q.clientId,
    redirectUri: q.redirectUri,
    codeChallenge: q.codeChallenge,
  });
  v.redirect.searchParams.set("code", code);
  if (q.state) v.redirect.searchParams.set("state", q.state);
  return NextResponse.redirect(v.redirect, 303);
}
