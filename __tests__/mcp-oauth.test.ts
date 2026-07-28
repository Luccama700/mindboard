import { createHash } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import {
  authorizationServerMetadata,
  isAllowedRedirect,
  isAllowedRedirectHost,
  issueAccessToken,
  issueClientId,
  issueCode,
  issueConsentTicket,
  issueRefreshToken,
  parseClientId,
  verifyConsentTicket,
  protectedResourceMetadata,
  signToken,
  verifyAccessToken,
  verifyCode,
  verifyPkceS256,
  verifyRefreshToken,
  verifyToken,
} from "@/app/lib/mcp/oauth";

beforeAll(() => {
  process.env.MCP_OAUTH_SECRET =
    process.env.MCP_OAUTH_SECRET ?? "test-oauth-secret-0123456789abcdef";
});

function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

describe("verifyPkceS256", () => {
  const verifier = "a".repeat(43);
  const challenge = challengeFor(verifier);

  test("accepts a matching verifier/challenge", () => {
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
  });
  test("rejects a wrong verifier", () => {
    expect(verifyPkceS256("b".repeat(43), challenge)).toBe(false);
  });
  test("rejects an out-of-range verifier length", () => {
    expect(verifyPkceS256("short", challenge)).toBe(false);
  });
});

describe("signToken / verifyToken", () => {
  test("round-trips a payload and enforces typ", () => {
    const t = signToken({ typ: "x", hello: "world" });
    expect(verifyToken(t, "x")).toMatchObject({ hello: "world" });
    expect(verifyToken(t, "y")).toBeNull();
  });

  test("rejects a tampered token", () => {
    const t = signToken({ typ: "x", n: 1 });
    const tampered = t.slice(0, -2) + (t.endsWith("aa") ? "bb" : "aa");
    expect(verifyToken(tampered, "x")).toBeNull();
  });

  test("rejects an expired token by the injected clock", () => {
    const t = signToken({ typ: "x", exp: 1000 });
    expect(verifyToken(t, "x", 500)).not.toBeNull();
    expect(verifyToken(t, "x", 2000)).toBeNull();
  });

  test("rejects garbage", () => {
    expect(verifyToken("not-a-token", "x")).toBeNull();
    expect(verifyToken("a.b.c", "x")).toBeNull();
  });
});

describe("authorization code", () => {
  test("round-trips owner/client/redirect/challenge", () => {
    const code = issueCode({
      ownerId: "owner-1",
      clientId: "client-1",
      redirectUri: "https://claude.ai/cb",
      codeChallenge: "chal",
    });
    expect(verifyCode(code)).toEqual({
      ownerId: "owner-1",
      clientId: "client-1",
      redirectUri: "https://claude.ai/cb",
      codeChallenge: "chal",
    });
  });

  test("an access token is not accepted as a code (typ isolation)", () => {
    const access = issueAccessToken({ ownerId: "o", clientId: "c", origin: "https://x" });
    expect(verifyCode(access)).toBeNull();
  });
});

describe("access / refresh tokens", () => {
  test("access token round-trips", () => {
    const t = issueAccessToken({ ownerId: "o1", clientId: "c1", origin: "https://x" });
    expect(verifyAccessToken(t)).toEqual({ ownerId: "o1", clientId: "c1" });
    expect(verifyRefreshToken(t)).toBeNull();
  });
  test("refresh token round-trips", () => {
    const t = issueRefreshToken({ ownerId: "o1", clientId: "c1" });
    expect(verifyRefreshToken(t)).toEqual({ ownerId: "o1", clientId: "c1" });
    expect(verifyAccessToken(t)).toBeNull();
  });
});

describe("client_id + redirect allow-list", () => {
  test("round-trips registered redirect_uris", () => {
    const id = issueClientId(["https://claude.ai/cb", "https://claude.ai/cb2"]);
    expect(parseClientId(id)?.redirectUris).toEqual([
      "https://claude.ai/cb",
      "https://claude.ai/cb2",
    ]);
    expect(parseClientId("garbage")).toBeNull();
  });

  test("allows only exact registered uris", () => {
    const uris = ["https://claude.ai/cb"];
    expect(isAllowedRedirect("https://claude.ai/cb", uris)).toBe(true);
    expect(isAllowedRedirect("https://claude.ai/evil", uris)).toBe(false);
    expect(isAllowedRedirect("https://evil.com/cb", uris)).toBe(false);
  });

  test("carries an optional client_name for the consent screen", () => {
    expect(parseClientId(issueClientId(["https://claude.ai/cb"], "Claude"))?.clientName).toBe(
      "Claude",
    );
    expect(parseClientId(issueClientId(["https://claude.ai/cb"]))?.clientName).toBeUndefined();
  });
});

// Registration is unauthenticated, so this host gate is what stops an attacker
// registering their own redirect target and phishing a code out of a signed-in
// user.
describe("registration host allow-list", () => {
  const hosts = ["claude.ai", "chatgpt.com", "localhost"];

  test("accepts allowed hosts and their subdomains", () => {
    expect(isAllowedRedirectHost("https://claude.ai/cb", hosts)).toBe(true);
    expect(isAllowedRedirectHost("https://api.claude.ai/cb", hosts)).toBe(true);
    expect(isAllowedRedirectHost("http://localhost:3000/cb", hosts)).toBe(true);
  });

  test("rejects look-alike and unrelated hosts", () => {
    expect(isAllowedRedirectHost("https://evil.example/cb", hosts)).toBe(false);
    // substring matching would wrongly accept these
    expect(isAllowedRedirectHost("https://claude.ai.evil.com/cb", hosts)).toBe(false);
    expect(isAllowedRedirectHost("https://evilclaude.ai/cb", hosts)).toBe(false);
    expect(isAllowedRedirectHost("https://notclaude.ai/cb", hosts)).toBe(false);
    expect(isAllowedRedirectHost("not-a-url", hosts)).toBe(false);
    expect(isAllowedRedirectHost("https://claude.ai/cb", [])).toBe(false);
  });
});

describe("consent ticket", () => {
  const grant = {
    ownerId: "user-1",
    clientId: "client-1",
    redirectUri: "https://claude.ai/cb",
    codeChallenge: "chal",
  };

  test("round-trips for the exact grant it was issued for", () => {
    expect(verifyConsentTicket(issueConsentTicket(grant), grant)).toBe(true);
  });

  test("rejects a ticket bound to a different user (the CSRF case)", () => {
    const ticket = issueConsentTicket(grant);
    expect(verifyConsentTicket(ticket, { ...grant, ownerId: "victim" })).toBe(false);
  });

  test("rejects tampered client, redirect, or PKCE challenge", () => {
    const ticket = issueConsentTicket(grant);
    expect(verifyConsentTicket(ticket, { ...grant, clientId: "other" })).toBe(false);
    expect(verifyConsentTicket(ticket, { ...grant, redirectUri: "https://evil/cb" })).toBe(false);
    expect(verifyConsentTicket(ticket, { ...grant, codeChallenge: "other" })).toBe(false);
  });

  test("rejects garbage and cross-type tokens", () => {
    expect(verifyConsentTicket("garbage", grant)).toBe(false);
    expect(verifyConsentTicket(issueCode(grant), grant)).toBe(false);
  });
});

describe("discovery metadata", () => {
  const origin = "https://mindboard.example";

  test("protected-resource points at the MCP endpoint + this AS", () => {
    expect(protectedResourceMetadata(origin)).toEqual({
      resource: "https://mindboard.example/api/mcp/mcp",
      authorization_servers: ["https://mindboard.example"],
    });
  });

  test("AS metadata advertises the endpoints + PKCE S256", () => {
    const m = authorizationServerMetadata(origin);
    expect(m.issuer).toBe(origin);
    expect(m.authorization_endpoint).toBe(`${origin}/api/mcp/oauth/authorize`);
    expect(m.token_endpoint).toBe(`${origin}/api/mcp/oauth/token`);
    expect(m.registration_endpoint).toBe(`${origin}/api/mcp/oauth/register`);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.grant_types_supported).toContain("authorization_code");
  });
});
