import { getPublicOrigin } from "mcp-handler";
import {
  ACCESS_TTL_SECONDS,
  issueAccessToken,
  issueRefreshToken,
  parseClientId,
  verifyCode,
  verifyPkceS256,
  verifyRefreshToken,
} from "@/app/lib/mcp/oauth";
import {
  consumeAuthorizationCode,
  createGrant,
  legacyRefreshAllowed,
  rotateRefreshToken,
  type GrantHandle,
} from "@/app/lib/mcp/oauth-store";

// OAuth token endpoint. Exchanges an authorization code (with PKCE) or a refresh
// token for an access token. Public client (no client secret).
//
// The tokens still carry their own signed state, but an authorization code is
// now ALSO single-use: its hash is recorded in oauth_used_codes (migration
// 0059) and a second exchange fails. A signature can prove a code is authentic
// and unexpired; only a row can prove it has not been spent, and without that
// row the same code + verifier minted an unlimited number of independent
// 30-day refresh families for the whole 60s TTL (audit M1).
//
// Refresh tokens ROTATE (audit M2): each exchange opens one oauth_grants
// family, every refresh mints the next link in its chain, and presenting a
// superseded link revokes the whole family. Access tokens stay stateless and
// short-lived, so revoking a grant stops refreshes immediately while an
// access token already in a client's hands keeps working for up to its 1-hour
// exp — the deliberate trade for not querying the database on every MCP call.

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

function tokenResponse(
  ownerId: string,
  clientId: string,
  origin: string,
  grant: GrantHandle | null,
) {
  return {
    access_token: issueAccessToken({ ownerId, clientId, origin }),
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: issueRefreshToken({ ownerId, clientId, grant }),
    scope: "mcp",
  };
}

function invalidGrant(description: string): Response {
  return json({ error: "invalid_grant", error_description: description }, 400);
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

    const opened = await createGrant({
      userId: parsed.ownerId,
      clientId: parsed.clientId,
      clientName: parseClientId(parsed.clientId)?.clientName ?? null,
    });
    if (opened.status === "error") return json({ error: "server_error" }, 500);

    return json(
      tokenResponse(
        parsed.ownerId,
        parsed.clientId,
        origin,
        opened.status === "ok" ? opened.grant : null,
      ),
      200,
    );
  }

  if (grantType === "refresh_token") {
    const { refresh_token: refreshToken, client_id: presentedClientId } = params;
    if (!refreshToken) return json({ error: "invalid_request" }, 400);
    const parsed = verifyRefreshToken(refreshToken);
    if (!parsed) return invalidGrant("bad or expired refresh token");
    // client_id is optional for this public client (RFC 6749 §6): the token
    // already names its client, so requiring the parameter would add no secret
    // and would break clients that omit it. When it is sent it must match.
    // What makes a leaked refresh token survivable is rotation + reuse
    // revocation below, not this check.
    if (presentedClientId && parsed.clientId !== presentedClientId) {
      return invalidGrant("client mismatch");
    }
    const clientId = parsed.clientId;

    if (!parsed.grantId || !parsed.jti) {
      const legacy = await legacyRefreshAllowed(parsed.ownerId);
      if (legacy === "error") return json({ error: "server_error" }, 500);
      if (legacy === "deny") return invalidGrant("re-authorization required");
      return json(tokenResponse(parsed.ownerId, parsed.clientId, origin, null), 200);
    }

    const rotated = await rotateRefreshToken({
      grantId: parsed.grantId,
      userId: parsed.ownerId,
      clientId,
      jti: parsed.jti,
    });

    switch (rotated.status) {
      case "ok":
        return json(tokenResponse(parsed.ownerId, parsed.clientId, origin, rotated.grant), 200);
      // Table missing (pre-0059): re-issue the SAME gid and jti rather than a
      // fresh one, so the chain still lines up with the row once it exists.
      case "unprotected":
        return json(
          tokenResponse(parsed.ownerId, parsed.clientId, origin, {
            id: parsed.grantId,
            jti: parsed.jti,
          }),
          200,
        );
      case "reuse":
        return invalidGrant("refresh token reused — this connection has been revoked");
      case "revoked":
        return invalidGrant("this connection has been revoked");
      case "client_mismatch":
        return invalidGrant("client mismatch");
      case "raced":
        return invalidGrant("refresh token already rotated");
      default:
        return json({ error: "server_error" }, 500);
    }
  }

  return json({ error: "unsupported_grant_type" }, 400);
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
