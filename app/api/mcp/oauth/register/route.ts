import { isAllowedRedirectHost, issueClientId } from "@/app/lib/mcp/oauth";
import { oauthAllowedRedirectHosts } from "@/app/lib/mcp/config";

// Dynamic Client Registration (RFC 7591). MCP clients (claude.ai) self-register
// here. We issue a stateless client_id (a signed token embedding the client's
// redirect_uris) — public client, PKCE required, no client_secret.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "*",
};

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: CORS });
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_client_metadata", error_description: "body must be JSON" }, 400);
  }

  const raw = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  const redirectUris = raw.filter((u): u is string => typeof u === "string");
  if (redirectUris.length === 0) {
    return json({ error: "invalid_redirect_uri", error_description: "redirect_uris is required" }, 400);
  }
  const allowedHosts = oauthAllowedRedirectHosts();
  for (const uri of redirectUris) {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      return json({ error: "invalid_redirect_uri", error_description: `not a URL: ${uri}` }, 400);
    }
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !local) {
      return json({ error: "invalid_redirect_uri", error_description: `must be https: ${uri}` }, 400);
    }
    // This endpoint is unauthenticated, so an unrestricted redirect_uri would
    // let anyone register their own host and then phish a full-scope code out
    // of a signed-in user via /authorize.
    if (!isAllowedRedirectHost(uri, allowedHosts)) {
      return json(
        { error: "invalid_redirect_uri", error_description: `host not allowed: ${u.hostname}` },
        400,
      );
    }
  }

  const clientName = typeof body.client_name === "string" ? body.client_name : undefined;
  return json(
    {
      client_id: issueClientId(redirectUris, clientName),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(clientName ? { client_name: clientName } : {}),
    },
    201,
  );
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
