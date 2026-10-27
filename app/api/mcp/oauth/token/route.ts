import { getPublicOrigin } from "mcp-handler";
import {
  ACCESS_TTL_SECONDS,
  issueAccessToken,
  issueRefreshToken,
  verifyCode,
  verifyPkceS256,
  verifyRefreshToken,
} from "@/app/lib/mcp/oauth";
import { consumeAuthorizationCode } from "@/app/lib/mcp/oauth-store";

// OAuth token endpoint. Exchanges an authorization code (with PKCE) or a refresh
// token for an access token. Public client (no client secret).
//
// The tokens still carry their own signed state, but an authorization code is
// now ALSO single-use: its hash is recorded in oauth_used_codes (migration
// 0059) and a second exchange fails. A signature can prove a code is authentic
// and unexpired; only a row can prove it has not been spent, and without that
// row the same code + verifier minted an unlimited number of independent
// 30-day refresh families for the whole 60s TTL (audit M1).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "*",
  "cache-control": "no-store",
};

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: CORS });
}

async function readParams(request: Request): Promise<Record<string, string>> {
  const ct = request.headers.get("content-type") ?? "";
  const out: Record<string, string> = {};
  if (ct.includes("application/json")) {
    const body = (await request.json()) as Record<string, unknown>;
    for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v;
    return out;
  }
  const form = await request.formData();
  for (const [k, v] of form.entries()) if (typeof v === "string") out[k] = v;
  return out;
}

function tokenResponse(ownerId: string, clientId: string, origin: string) {
  return {
    access_token: issueAccessToken({ ownerId, clientId, origin }),
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: issueRefreshToken({ ownerId, clientId }),
    scope: "mcp",
  };
}

export async function POST(request: Request): Promise<Response> {
  const origin = getPublicOrigin(request);
  let params: Record<string, string>;
  try {
    params = await readParams(request);
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  const grantType = params.grant_type;

  if (grantType === "authorization_code") {
    const { code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier } = params;
    if (!code || !clientId || !verifier) return json({ error: "invalid_request" }, 400);
    const parsed = verifyCode(code);
    if (!parsed) return json({ error: "invalid_grant", error_description: "bad or expired code" }, 400);
    if (parsed.clientId !== clientId) return json({ error: "invalid_grant", error_description: "client mismatch" }, 400);
    if (parsed.redirectUri !== redirectUri) return json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
    if (!verifyPkceS256(verifier, parsed.codeChallenge)) return json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);

    // Spend the code only once every other check has passed, so a probe with a
    // wrong verifier cannot burn a code the real client is about to exchange.
    const spent = await consumeAuthorizationCode(code, parsed.expiresAt);
    if (spent.status === "replay") {
      return json({ error: "invalid_grant", error_description: "code already used" }, 400);
    }
    if (spent.status === "error") return json({ error: "server_error" }, 500);

    return json(tokenResponse(parsed.ownerId, parsed.clientId, origin), 200);
  }

  if (grantType === "refresh_token") {
    const { refresh_token: refreshToken, client_id: clientId } = params;
    if (!refreshToken) return json({ error: "invalid_request" }, 400);
    const parsed = verifyRefreshToken(refreshToken);
    if (!parsed) return json({ error: "invalid_grant", error_description: "bad or expired refresh token" }, 400);
    if (clientId && parsed.clientId !== clientId) return json({ error: "invalid_grant", error_description: "client mismatch" }, 400);
    return json(tokenResponse(parsed.ownerId, parsed.clientId, origin), 200);
  }

  return json({ error: "unsupported_grant_type" }, 400);
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
