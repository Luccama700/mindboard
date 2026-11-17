// @vitest-environment node
// The route-level cases below construct real Request/Response objects and
// import a Route Handler; jsdom's fetch primitives are not the ones Next uses.
import { createHash } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  authorizationServerMetadata,
  isAllowedRedirect,
  isAllowedRedirectHost,
  issueAccessToken,
  issueClientId,
  issueCode,
  issueConsentTicket,
  issueRefreshToken,
  mcpResourceUrl,
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
import { oauthAllowedRedirectHosts } from "@/app/lib/mcp/config";

// A chainable PostgREST stub. Each test scripts `db.state.respond`, which sees
// the whole call (table, verb, payload, filters) and returns { data, error }.
// Defined inside vi.hoisted because the vi.mock factory below runs during
// module instantiation, before this file's own body evaluates.
const db = vi.hoisted(() => {
  type Op = {
    table: string;
    verb: "select" | "insert" | "update" | "delete";
    payload?: Record<string, unknown>;
    filters: [string, string, unknown][];
    terminal?: "single" | "maybeSingle";
  };
  type Reply = { data?: unknown; error?: unknown };

  const state: { respond: (op: Op) => Reply; calls: Op[] } = {
    respond: () => ({}),
    calls: [],
  };

  function from(table: string) {
    const op: Op = { table, verb: "select", filters: [] };
    const chain = {
      select: () => chain,
      insert: (payload: Record<string, unknown>) => {
        op.verb = "insert";
        op.payload = payload;
        return chain;
      },
      update: (payload: Record<string, unknown>) => {
        op.verb = "update";
        op.payload = payload;
        return chain;
      },
      delete: () => {
        op.verb = "delete";
        return chain;
      },
      eq: (column: string, value: unknown) => {
        op.filters.push(["eq", column, value]);
        return chain;
      },
      is: (column: string, value: unknown) => {
        op.filters.push(["is", column, value]);
        return chain;
      },
      lt: (column: string, value: unknown) => {
        op.filters.push(["lt", column, value]);
        return chain;
      },
      limit: () => chain,
      order: () => chain,
      single: () => {
        op.terminal = "single";
        return chain;
      },
      maybeSingle: () => {
        op.terminal = "maybeSingle";
        return chain;
      },
      then: (
        onFulfilled: (value: { data: unknown; error: unknown }) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) =>
        Promise.resolve()
          .then(() => {
            state.calls.push(op);
            const reply = state.respond(op);
            return { data: reply.data ?? null, error: reply.error ?? null };
          })
          .then(onFulfilled, onRejected),
    };
    return chain;
  }

  return { state, from, reset: () => {
    state.respond = () => ({});
    state.calls = [];
  } };
});

vi.mock("@/utils/supabase/service", () => ({
  createServiceClient: () => ({ from: db.from }),
}));

// The real export pulls Next server internals in; the route only needs it to
// name the origin the request arrived on.
vi.mock("mcp-handler", () => ({
  getPublicOrigin: (request: Request) => new URL(request.url).origin,
}));

// A signed-in session, so /authorize renders its consent form instead of
// bouncing through /login.
vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "owner-1" } } }) },
  }),
}));

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
    expect(verifyCode(code)).toMatchObject({
      ownerId: "owner-1",
      clientId: "client-1",
      redirectUri: "https://claude.ai/cb",
      codeChallenge: "chal",
    });
    expect(typeof verifyCode(code)?.expiresAt).toBe("number");
  });

  // Without the jti, two authorizations for the same user/client/redirect/
  // challenge in the same second would be byte-identical — and the second
  // one's spent-code row would collide with the first's, locking out a
  // legitimate exchange.
  test("two codes for the same grant are distinct", () => {
    const grant = {
      ownerId: "owner-1",
      clientId: "client-1",
      redirectUri: "https://claude.ai/cb",
      codeChallenge: "chal",
    };
    expect(issueCode(grant)).not.toBe(issueCode(grant));
  });

  test("an access token is not accepted as a code (typ isolation)", () => {
    const access = issueAccessToken({ ownerId: "o", clientId: "c", origin: "https://x" });
    expect(verifyCode(access)).toBeNull();
  });
});

describe("access / refresh tokens", () => {
  const audience = mcpResourceUrl("https://x");

  test("access token round-trips", () => {
    const t = issueAccessToken({ ownerId: "o1", clientId: "c1", origin: "https://x" });
    expect(verifyAccessToken(t, audience)).toEqual({ ownerId: "o1", clientId: "c1" });
    expect(verifyRefreshToken(t)).toBeNull();
  });

  // A Vercel preview shares MCP_OAUTH_SECRET with production, so the signature
  // alone cannot say which deployment a token was minted for.
  test("rejects an access token minted for another origin", () => {
    const t = issueAccessToken({
      ownerId: "o1",
      clientId: "c1",
      origin: "https://mindboard.example",
    });
    expect(verifyAccessToken(t, mcpResourceUrl("https://preview.example"))).toBeNull();
    expect(verifyAccessToken(t, mcpResourceUrl("https://mindboard.example"))).toEqual({
      ownerId: "o1",
      clientId: "c1",
    });
  });

  test("refresh token carries its family and chain position", () => {
    const t = issueRefreshToken({
      ownerId: "o1",
      clientId: "c1",
      grant: { id: "grant-1", jti: "jti-1" },
    });
    expect(verifyRefreshToken(t)).toEqual({
      ownerId: "o1",
      clientId: "c1",
      grantId: "grant-1",
      jti: "jti-1",
    });
    expect(verifyAccessToken(t, audience)).toBeNull();
  });

  test("a familyless (pre-0059) refresh token still parses, with nulls", () => {
    const t = issueRefreshToken({ ownerId: "o1", clientId: "c1", grant: null });
    expect(verifyRefreshToken(t)).toEqual({
      ownerId: "o1",
      clientId: "c1",
      grantId: null,
      jti: null,
    });
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

describe("default registration host allow-list", () => {
  const ENV = "MCP_OAUTH_ALLOWED_REDIRECT_HOSTS";
  const saved = process.env[ENV];

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  // A bare host matches every subdomain and every path on it, so chatgpt.com
  // in the default meant any custom GPT could register a redirect target
  // (audit L2). Putting it back is now a deliberate act by whoever controls
  // the deployment.
  test("ships only the hosts this deployment uses", () => {
    delete process.env[ENV];
    expect(oauthAllowedRedirectHosts()).toEqual([
      "claude.ai",
      "claude.com",
      "localhost",
      "127.0.0.1",
    ]);
    expect(oauthAllowedRedirectHosts()).not.toContain("chatgpt.com");
  });

  test("the env var replaces the default outright", () => {
    process.env[ENV] = " chatgpt.com , example.test ";
    expect(oauthAllowedRedirectHosts()).toEqual(["chatgpt.com", "example.test"]);
  });

  test("an empty env var falls back to the default", () => {
    process.env[ENV] = "  ,  ";
    expect(oauthAllowedRedirectHosts()).toContain("claude.ai");
  });
});

// Registration is unauthenticated, so this host gate is what stops an attacker
// registering their own redirect target and phishing a code out of a signed-in
// user.
describe("registration host matching", () => {
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

// ---------- token endpoint, against the stubbed store ----------

const TOKEN_ORIGIN = "https://mindboard.example";
const VERIFIER = "v".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const REDIRECT = "https://claude.ai/cb";

async function postToken(
  body: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { POST } = await import("@/app/api/mcp/oauth/token/route");
  const response = await POST(
    new Request(`${TOKEN_ORIGIN}/api/mcp/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function freshCode(clientId = "client-1", ownerId = "owner-1"): string {
  return issueCode({ ownerId, clientId, redirectUri: REDIRECT, codeChallenge: CHALLENGE });
}

function exchangeBody(code: string, clientId = "client-1"): Record<string, string> {
  return {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
  };
}

describe("token endpoint — authorization codes are single-use", () => {
  beforeEach(() => {
    db.reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a first exchange records the code hash and returns tokens", async () => {
    db.state.respond = (op) => (op.table === "oauth_grants" ? { data: { id: "grant-1" } } : {});
    const result = await postToken(exchangeBody(freshCode()));

    expect(result.status).toBe(200);
    expect(typeof result.body.access_token).toBe("string");
    expect(typeof result.body.refresh_token).toBe("string");

    const insert = db.state.calls.find((c) => c.verb === "insert");
    expect(insert?.table).toBe("oauth_used_codes");
    expect(typeof insert?.payload?.code_hash).toBe("string");
    // Opportunistic GC of expired rows rides along with the exchange.
    expect(db.state.calls.some((c) => c.verb === "delete")).toBe(true);
  });

  test("a replayed code is invalid_grant (the unique violation)", async () => {
    db.state.respond = (op) =>
      op.verb === "insert" ? { error: { code: "23505" } } : {};

    const result = await postToken(exchangeBody(freshCode()));
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("invalid_grant");
    expect(result.body.error_description).toBe("code already used");
  });

  test("a wrong verifier is rejected without spending the code", async () => {
    db.state.respond = (op) => (op.table === "oauth_grants" ? { data: { id: "grant-1" } } : {});
    const result = await postToken({
      ...exchangeBody(freshCode()),
      code_verifier: "w".repeat(64),
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toBe("invalid_grant");
    expect(db.state.calls).toHaveLength(0);
  });

  test("a database fault fails CLOSED", async () => {
    db.state.respond = (op) =>
      op.verb === "insert" ? { error: { code: "08006" } } : {};

    const result = await postToken(exchangeBody(freshCode()));
    expect(result.status).toBe(500);
    expect(result.body.error).toBe("server_error");
  });

  // Cutover: the code deploys before migration 0059 is applied, so a missing
  // table must not lock every claude.ai connector out.
  test("a missing used-codes table fails OPEN and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.state.respond = (op) =>
      op.table === "oauth_used_codes" && op.verb === "insert"
        ? { error: { code: "42P01" } }
        : op.table === "oauth_grants"
          ? { data: { id: "grant-1" } }
          : {};

    expect((await postToken(exchangeBody(freshCode()))).status).toBe(200);
    expect((await postToken(exchangeBody(freshCode()))).status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // PostgREST normally answers an unknown table out of its schema cache.
  test("PGRST205 counts as a missing table too", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    db.state.respond = (op) =>
      op.table === "oauth_used_codes" && op.verb === "insert"
        ? { error: { code: "PGRST205" } }
        : op.table === "oauth_grants"
          ? { data: { id: "grant-1" } }
          : {};

    expect((await postToken(exchangeBody(freshCode()))).status).toBe(200);
  });
});

describe("consent page", () => {
  async function renderConsent(clientName?: string): Promise<string> {
    const { GET } = await import("@/app/api/mcp/oauth/authorize/route");
    const url = new URL(`${TOKEN_ORIGIN}/api/mcp/oauth/authorize`);
    url.searchParams.set("client_id", issueClientId([REDIRECT], clientName));
    url.searchParams.set("redirect_uri", REDIRECT);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", CHALLENGE);
    url.searchParams.set("code_challenge_method", "S256");
    const response = await GET(new Request(url));
    expect(response.status).toBe(200);
    return response.text();
  }

  // client_name is whatever the (unauthenticated) registration typed, so it
  // must never occupy the spot a user reads as "who is asking".
  test("leads with the redirect host and demotes client_name to a claim", async () => {
    const html = await renderConsent("Mindboard Official Sync");

    expect(html).toContain('<span class="who">claude.ai</span>');
    expect(html).toContain("It calls itself");
    expect(html.indexOf('class="who"')).toBeLessThan(
      html.indexOf("Mindboard Official Sync"),
    );
    // The browser tab is the one surface a phished user sees first.
    expect(html).toContain("<title>Authorize claude.ai — Mindboard</title>");
  });

  test("a client with no name shows the host alone", async () => {
    const html = await renderConsent();
    expect(html).toContain('<span class="who">claude.ai</span>');
    expect(html).not.toContain("It calls itself");
  });

  test("a client_name cannot inject markup", async () => {
    const html = await renderConsent('<script>alert(1)</script>');
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("token endpoint — refresh families rotate and can be revoked", () => {
  const GRANT_ID = "11111111-2222-3333-4444-555555555555";

  function refreshFor(jti: string | null, clientId = "client-1"): string {
    return issueRefreshToken({
      ownerId: "owner-1",
      clientId,
      grant: jti === null ? null : { id: GRANT_ID, jti },
    });
  }

  async function postRefresh(
    refreshToken: string,
    clientId: string | null = "client-1",
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return postToken({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      ...(clientId === null ? {} : { client_id: clientId }),
    });
  }

  // A live grant whose chain currently sits at `jti`.
  function liveGrant(jti: string, clientId = "client-1") {
    return {
      id: GRANT_ID,
      client_id: clientId,
      revoked_at: null,
      current_refresh_jti: jti,
    };
  }

  beforeEach(() => {
    db.reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a code exchange opens a family and the refresh token names it", async () => {
    db.state.respond = (op) => (op.table === "oauth_grants" ? { data: { id: GRANT_ID } } : {});
    const result = await postToken(exchangeBody(freshCode()));

    const parsed = verifyRefreshToken(String(result.body.refresh_token));
    expect(parsed?.grantId).toBe(GRANT_ID);
    expect(typeof parsed?.jti).toBe("string");

    const insert = db.state.calls.find((c) => c.table === "oauth_grants");
    expect(insert?.payload?.user_id).toBe("owner-1");
    expect(insert?.payload?.current_refresh_jti).toBe(parsed?.jti);
  });

  test("a refresh rotates the chain forward", async () => {
    db.state.respond = (op) => {
      if (op.terminal === "maybeSingle") return { data: liveGrant("jti-1") };
      if (op.verb === "update") return { data: [{ id: GRANT_ID }] };
      return {};
    };

    const result = await postRefresh(refreshFor("jti-1"));
    expect(result.status).toBe(200);

    const next = verifyRefreshToken(String(result.body.refresh_token));
    expect(next?.grantId).toBe(GRANT_ID);
    expect(next?.jti).not.toBe("jti-1");

    // The rotation is a compare-and-swap on the jti that was just read.
    const update = db.state.calls.find((c) => c.verb === "update");
    expect(update?.payload?.current_refresh_jti).toBe(next?.jti);
    expect(update?.filters).toContainEqual(["eq", "current_refresh_jti", "jti-1"]);
    expect(update?.filters).toContainEqual(["eq", "user_id", "owner-1"]);
  });

  test("a superseded refresh token revokes the whole family", async () => {
    db.state.respond = (op) => {
      if (op.terminal === "maybeSingle") return { data: liveGrant("jti-2") };
      return {};
    };

    const result = await postRefresh(refreshFor("jti-1"));
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("invalid_grant");
    expect(String(result.body.error_description)).toContain("revoked");

    const revoke = db.state.calls.find((c) => c.verb === "update");
    expect(typeof revoke?.payload?.revoked_at).toBe("string");
    expect(revoke?.filters).toContainEqual(["eq", "user_id", "owner-1"]);
    // No successor was minted.
    expect(result.body.refresh_token).toBeUndefined();
  });

  test("a lost-response retry of the previous token inside the grace window rotates, not revokes", async () => {
    db.state.respond = (op) => {
      if (op.terminal === "maybeSingle") {
        return {
          data: {
            ...liveGrant("jti-2"),
            previous_refresh_jti: "jti-1",
            rotated_at: new Date(Date.now() - 5_000).toISOString(),
          },
        };
      }
      if (op.verb === "update") return { data: [{ id: GRANT_ID }] };
      return {};
    };

    const result = await postRefresh(refreshFor("jti-1"));
    expect(result.status).toBe(200);
    const update = db.state.calls.find((c) => c.verb === "update");
    expect(update?.payload?.revoked_at).toBeUndefined();
    // the CAS runs on the family's CURRENT jti, so only one retry can win
    expect(update?.filters).toContainEqual(["eq", "current_refresh_jti", "jti-2"]);
  });

  test("the previous token outside the grace window is still reuse", async () => {
    db.state.respond = (op) => {
      if (op.terminal === "maybeSingle") {
        return {
          data: {
            ...liveGrant("jti-2"),
            previous_refresh_jti: "jti-1",
            rotated_at: new Date(Date.now() - 10 * 60_000).toISOString(),
          },
        };
      }
      return {};
    };

    const result = await postRefresh(refreshFor("jti-1"));
    expect(result.status).toBe(400);
    const revoke = db.state.calls.find((c) => c.verb === "update");
    expect(typeof revoke?.payload?.revoked_at).toBe("string");
  });

  // Answering "revoked" while the revoke itself failed would be a lie the
  // caller acts on.
  test("a failed family revoke reports server_error, not reuse", async () => {
    db.state.respond = (op) =>
      op.terminal === "maybeSingle"
        ? { data: liveGrant("jti-2") }
        : op.verb === "update"
          ? { error: { code: "08006" } }
          : {};

    const result = await postRefresh(refreshFor("jti-1"));
    expect(result.status).toBe(500);
    expect(result.body.error).toBe("server_error");
  });

  test("a revoked grant refuses the refresh", async () => {
    db.state.respond = (op) =>
      op.terminal === "maybeSingle"
        ? { data: { ...liveGrant("jti-1"), revoked_at: "2026-10-27T00:00:00.000Z" } }
        : {};

    const result = await postRefresh(refreshFor("jti-1"));
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("invalid_grant");
  });

  test("the client_id must match the grant row, not just the token", async () => {
    db.state.respond = (op) =>
      op.terminal === "maybeSingle" ? { data: liveGrant("jti-1", "some-other-client") } : {};

    // The token says client-1 and so does the request, but the family was
    // opened by a different registered client.
    const result = await postRefresh(refreshFor("jti-1"));
    expect(result.status).toBe(400);
    expect(result.body.error_description).toBe("client mismatch");
  });

  test("a refresh without client_id uses the client the token names", async () => {
    db.state.respond = (op) => {
      if (op.terminal === "maybeSingle") return { data: liveGrant("jti-1") };
      if (op.verb === "update") return { data: [{ id: GRANT_ID }] };
      return {};
    };
    const result = await postRefresh(refreshFor("jti-1"), null);
    expect(result.status).toBe(200);
  });

  test("a client_id that disagrees with the token is refused", async () => {
    db.state.respond = () => ({});
    const result = await postRefresh(refreshFor("jti-1"), "someone-else");
    expect(result.status).toBe(400);
    expect(result.body.error_description).toBe("client mismatch");
  });

  // Losing the compare-and-swap is a concurrent refresh, not an attack, so it
  // must not take the family down with it.
  test("losing the rotation race is invalid_grant but revokes nothing", async () => {
    db.state.respond = (op) => {
      if (op.terminal === "maybeSingle") return { data: liveGrant("jti-1") };
      if (op.verb === "update") return { data: [] };
      return {};
    };

    const result = await postRefresh(refreshFor("jti-1"));
    expect(result.status).toBe(400);
    expect(result.body.error_description).toBe("refresh token already rotated");
    expect(
      db.state.calls.filter((c) => c.verb === "update" && "revoked_at" in (c.payload ?? {})),
    ).toHaveLength(0);
  });

  test("a pre-0059 familyless refresh token is refused once the table exists", async () => {
    db.state.respond = () => ({});
    const result = await postRefresh(refreshFor(null));
    expect(result.status).toBe(400);
    expect(result.body.error_description).toBe("re-authorization required");
    // Even the availability probe carries the explicit user_id filter every
    // service-client read in this app does.
    expect(db.state.calls[0]?.filters).toContainEqual(["eq", "user_id", "owner-1"]);
  });

  test("…but is honoured while the table is still missing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    db.state.respond = () => ({ error: { code: "42P01" } });

    const result = await postRefresh(refreshFor(null));
    expect(result.status).toBe(200);
    expect(verifyRefreshToken(String(result.body.refresh_token))?.grantId).toBeNull();
  });

  // Rolled back below 0059 with family-bearing tokens already out there: keep
  // the SAME jti so the chain still lines up when the table returns.
  test("a familied token survives a missing table with its jti unchanged", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    db.state.respond = () => ({ error: { code: "42P01" } });

    const result = await postRefresh(refreshFor("jti-1"));
    expect(result.status).toBe(200);
    expect(verifyRefreshToken(String(result.body.refresh_token))).toMatchObject({
      grantId: GRANT_ID,
      jti: "jti-1",
    });
  });

  test("a database fault on refresh fails CLOSED", async () => {
    db.state.respond = () => ({ error: { code: "08006" } });
    const result = await postRefresh(refreshFor("jti-1"));
    expect(result.status).toBe(500);
    expect(result.body.error).toBe("server_error");
  });
});
