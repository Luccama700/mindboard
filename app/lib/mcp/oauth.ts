import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Minimal, stateless OAuth 2.1 primitives for the MCP authorization server.
// Every artifact (client_id, auth code, access/refresh token) is a signed token
// that embeds its own state, so there are no OAuth DB tables. Signing is
// HMAC-SHA256 with a fixed algorithm (the token carries no alg header, so there
// is no alg-confusion surface) keyed by MCP_OAUTH_SECRET. No external dep.

const RESOURCE_PATH = "/api/mcp/mcp";
const SCOPE = "mcp";

const CODE_TTL = 60; // seconds — auth code is short-lived
const ACCESS_TTL = 60 * 60; // 1 hour
const REFRESH_TTL = 60 * 60 * 24 * 30; // 30 days
const CLIENT_TTL = 60 * 60 * 24 * 365; // 1 year

export const ACCESS_TTL_SECONDS = ACCESS_TTL;
export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

function secret(): Buffer {
  const s = process.env.MCP_OAUTH_SECRET;
  if (!s) throw new Error("MCP_OAUTH_SECRET is not set");
  return Buffer.from(s, "utf8");
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function hmac(data: string): string {
  return createHmac("sha256", secret()).update(data).digest("base64url");
}

// ---------- signed token: "<payload_b64url>.<sig_b64url>" ----------

export function signToken(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${hmac(body)}`;
}

export function verifyToken<T extends Record<string, unknown>>(
  token: string,
  expectedTyp: string,
  now: number = nowSec(),
): T | null {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload.typ !== expectedTyp) return null;
  if (typeof payload.exp === "number" && payload.exp < now) return null;
  return payload as T;
}

// ---------- PKCE (S256 only) ----------

export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (typeof verifier !== "string" || typeof challenge !== "string") return false;
  if (verifier.length < 43 || verifier.length > 128) return false;
  const computed = createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- client_id (dynamic client registration) ----------

export function issueClientId(redirectUris: string[]): string {
  return signToken({ typ: "client", redirect_uris: redirectUris, exp: nowSec() + CLIENT_TTL });
}

export function parseClientId(clientId: string): { redirectUris: string[] } | null {
  const p = verifyToken<{ redirect_uris?: string[] }>(clientId, "client");
  return p ? { redirectUris: p.redirect_uris ?? [] } : null;
}

export function isAllowedRedirect(redirectUri: string, registered: string[]): boolean {
  return typeof redirectUri === "string" && registered.includes(redirectUri);
}

// ---------- authorization code ----------

export function issueCode(input: {
  ownerId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
}): string {
  return signToken({
    typ: "code",
    sub: input.ownerId,
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    cc: input.codeChallenge,
    exp: nowSec() + CODE_TTL,
  });
}

export function verifyCode(code: string): {
  ownerId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
} | null {
  const p = verifyToken<{
    sub: string;
    client_id: string;
    redirect_uri: string;
    cc: string;
  }>(code, "code");
  return p
    ? { ownerId: p.sub, clientId: p.client_id, redirectUri: p.redirect_uri, codeChallenge: p.cc }
    : null;
}

// ---------- access / refresh tokens ----------

export function issueAccessToken(input: {
  ownerId: string;
  clientId: string;
  origin: string;
}): string {
  return signToken({
    typ: "access",
    sub: input.ownerId,
    client_id: input.clientId,
    aud: `${input.origin}${RESOURCE_PATH}`,
    scope: SCOPE,
    exp: nowSec() + ACCESS_TTL,
  });
}

export function verifyAccessToken(token: string): { ownerId: string; clientId: string } | null {
  const p = verifyToken<{ sub: string; client_id: string }>(token, "access");
  return p ? { ownerId: p.sub, clientId: p.client_id } : null;
}

export function issueRefreshToken(input: { ownerId: string; clientId: string }): string {
  return signToken({
    typ: "refresh",
    sub: input.ownerId,
    client_id: input.clientId,
    exp: nowSec() + REFRESH_TTL,
  });
}

export function verifyRefreshToken(token: string): { ownerId: string; clientId: string } | null {
  const p = verifyToken<{ sub: string; client_id: string }>(token, "refresh");
  return p ? { ownerId: p.sub, clientId: p.client_id } : null;
}

// ---------- discovery metadata ----------

export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}${RESOURCE_PATH}`,
    authorization_servers: [origin],
  };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/api/mcp/oauth/authorize`,
    token_endpoint: `${origin}/api/mcp/oauth/token`,
    registration_endpoint: `${origin}/api/mcp/oauth/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
  };
}
