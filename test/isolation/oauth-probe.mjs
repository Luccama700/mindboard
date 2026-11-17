// Exercises the MCP OAuth authorization server over real HTTP.
//
// app/lib/mcp/oauth.ts is unit-tested as pure functions in
// __tests__/mcp-oauth.test.ts, but the routes that compose them —
// /api/mcp/oauth/{register,authorize,token} — were never driven end to end.
// A one-click account takeover through this flow was the audit's first
// CRITICAL, so the fixed behaviours get permanent regression probes here:
// consent binding, redirect equality, PKCE, wrong client, and above all that a
// bare GET to /authorize never mints an authorization code.
//
// Never logs tokens, codes, cookies or Authorization headers — only shapes.

import { createHash, randomBytes } from "node:crypto";
import { createServerClient } from "@supabase/ssr";

const REDIRECT = "http://localhost:3000/oauth-probe-callback";
const REDIRECT_ALT = "http://localhost:3000/oauth-probe-other";

function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// A cookie jar backed by the same @supabase/ssr writer the app reads with, so
// the probe presents byte-identical session cookies to a real browser's.
export function makeSessionClient(url, anon) {
  const jar = new Map();
  const client = createServerClient(url, anon, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list) => {
        for (const { name, value } of list) {
          if (!value) jar.delete(name);
          else jar.set(name, value);
        }
      },
    },
  });
  const header = () =>
    [...jar.entries()].map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join("; ");
  return { client, jar, header };
}

function ticketFrom(html) {
  const m = html.match(/name="consent"\s+value="([^"]*)"/);
  return m ? m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"') : null;
}

function codeFrom(location) {
  if (!location) return null;
  try {
    return new URL(location, "http://localhost").searchParams.get("code");
  } catch {
    return null;
  }
}

function errorFrom(location) {
  if (!location) return null;
  try {
    return new URL(location, "http://localhost").searchParams.get("error");
  } catch {
    return null;
  }
}

export async function runOauthProbe({ origin, sessionA, sessionB, reporter, mcpProbeAs }) {
  const post = (path, body, headers = {}) =>
    fetch(`${origin}${path}`, { method: "POST", body, headers, redirect: "manual" });

  const register = async (redirectUris, clientName = "isolation-probe") => {
    const res = await post(
      "/api/mcp/oauth/register",
      JSON.stringify({ redirect_uris: redirectUris, client_name: clientName }),
      { "content-type": "application/json" },
    );
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON body */
    }
    return { status: res.status, json };
  };

  const authorizeGet = (params, cookie) =>
    fetch(`${origin}/api/mcp/oauth/authorize?${new URLSearchParams(params)}`, {
      headers: cookie ? { cookie } : {},
      redirect: "manual",
    });

  const authorizePost = (fields, cookie) =>
    post("/api/mcp/oauth/authorize", new URLSearchParams(fields), cookie ? { cookie } : {});

  const tokenExchange = async (params) => {
    const res = await post("/api/mcp/oauth/token", new URLSearchParams(params), {
      "content-type": "application/x-www-form-urlencoded",
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON body */
    }
    return { status: res.status, json };
  };

  // ---------------- dynamic client registration: the host allowlist ----------------
  reporter.section("oauth: dynamic client registration host allowlist");

  const rejections = [
    ["a plain attacker host", ["https://evil.com/cb"]],
    ["an attacker host that suffixes an allowed one", ["https://claude.ai.evil.com/cb"]],
    ["a lookalike host (substring, not a subdomain)", ["https://evilclaude.ai/cb"]],
    ["a non-https, non-loopback host", ["http://evil.example/cb"]],
    ["a malformed URL", ["not-a-url"]],
    ["a javascript: URI", ["javascript:alert(1)"]],
    ["an allowed host smuggled in the userinfo", ["https://claude.ai@evil.com/cb"]],
    ["one good and one attacker URI in the same registration", ["https://claude.ai/cb", "https://evil.com/cb"]],
  ];
  for (const [label, uris] of rejections) {
    const res = await register(uris);
    reporter.check(
      `register rejects ${label}`,
      res.status === 400 && !res.json?.client_id,
      `status=${res.status} ${res.json?.error ?? ""}`,
    );
  }

  const accepted = [
    ["the real claude.ai callback", ["https://claude.ai/api/mcp/auth_callback"]],
    ["a claude.ai subdomain", ["https://console.claude.ai/cb"]],
    ["a loopback http callback", [REDIRECT]],
  ];
  for (const [label, uris] of accepted) {
    const res = await register(uris);
    reporter.check(
      `register accepts ${label}`,
      res.status === 201 && typeof res.json?.client_id === "string",
      `status=${res.status} ${res.json?.error_description ?? ""}`,
    );
  }

  // The client used for the rest of the flow, registered with TWO redirect URIs
  // so redirect equality (not mere membership) can be tested at exchange time.
  const main = await register([REDIRECT, REDIRECT_ALT]);
  if (main.status !== 201) {
    reporter.fail("oauth probe setup: could not register a probe client", `status=${main.status}`);
    return;
  }
  const clientId = main.json.client_id;

  const other = await register([REDIRECT]);
  const otherClientId = other.json?.client_id;

  const { verifier, challenge } = pkce();
  const baseQuery = {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "probe-state",
  };

  // ---------------- the fixed CRITICAL: GET must never mint a code ----------------
  reporter.section("oauth: cross-site GET to /authorize");

  const getAsA = await authorizeGet(baseQuery, sessionA.header());
  const getBody = await getAsA.text();
  reporter.check(
    "GET /authorize with a live session renders consent, never a redirect",
    getAsA.status === 200 && !getAsA.headers.get("location"),
    `status=${getAsA.status} location=${getAsA.headers.get("location") ? "set" : "none"}`,
  );
  reporter.check(
    "GET /authorize hands back no authorization code",
    !/[?&]code=/.test(getBody) && !getBody.includes(REDIRECT + "?code"),
  );
  reporter.check(
    "the consent page refuses to be framed",
    (getAsA.headers.get("x-frame-options") ?? "").toUpperCase() === "DENY" &&
      (getAsA.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"),
    `xfo=${getAsA.headers.get("x-frame-options")}`,
  );
  const sessionRecognized = getAsA.status === 200 && getBody.includes('name="consent"');
  reporter.check(
    "the probe's session cookies are accepted by the app (not bounced to /login)",
    sessionRecognized,
    sessionRecognized ? "" : "authorize did not render a consent form for a signed-in user",
  );
  if (!sessionRecognized) {
    reporter.fail("oauth probe setup: no usable session — remaining oauth checks skipped");
    return;
  }
  const ticketA = ticketFrom(getBody);

  // ---------------- redirect equality ----------------
  reporter.section("oauth: redirect_uri handling");

  const unregistered = await authorizeGet(
    { ...baseQuery, redirect_uri: "http://localhost:3000/never-registered" },
    sessionA.header(),
  );
  reporter.check(
    "GET /authorize rejects a redirect_uri never registered for the client",
    unregistered.status === 400 && !unregistered.headers.get("location"),
    `status=${unregistered.status}`,
  );

  const foreignHost = await authorizeGet(
    { ...baseQuery, redirect_uri: "https://evil.com/cb" },
    sessionA.header(),
  );
  reporter.check(
    "GET /authorize rejects an attacker-host redirect_uri",
    foreignHost.status === 400,
    `status=${foreignHost.status}`,
  );

  // ---------------- PKCE ----------------
  reporter.section("oauth: PKCE enforcement");

  const noMethod = await authorizeGet(
    { ...baseQuery, code_challenge_method: "" },
    sessionA.header(),
  );
  reporter.check(
    "GET /authorize refuses a request with no code_challenge_method=S256",
    errorFrom(noMethod.headers.get("location")) === "invalid_request" &&
      !codeFrom(noMethod.headers.get("location")),
    `status=${noMethod.status} error=${errorFrom(noMethod.headers.get("location"))}`,
  );

  const plainMethod = await authorizeGet(
    { ...baseQuery, code_challenge_method: "plain" },
    sessionA.header(),
  );
  reporter.check(
    "GET /authorize refuses downgrade to code_challenge_method=plain",
    errorFrom(plainMethod.headers.get("location")) === "invalid_request" &&
      !codeFrom(plainMethod.headers.get("location")),
    `error=${errorFrom(plainMethod.headers.get("location"))}`,
  );

  const noChallenge = await authorizeGet(
    { ...baseQuery, code_challenge: "" },
    sessionA.header(),
  );
  reporter.check(
    "GET /authorize refuses a request with no code_challenge at all",
    !codeFrom(noChallenge.headers.get("location")),
  );

  // ---------------- consent binding ----------------
  reporter.section("oauth: consent ticket binding");

  const bGet = await authorizeGet(baseQuery, sessionB.header());
  const ticketB = ticketFrom(await bGet.text());
  reporter.check("tenant B can render their own consent form", typeof ticketB === "string");

  const crossTicket = await authorizePost(
    { ...baseQuery, consent: ticketB ?? "", decision: "allow" },
    sessionA.header(),
  );
  const crossLocation = crossTicket.headers.get("location");
  reporter.check(
    "POST /authorize refuses a consent ticket minted for a different user",
    !codeFrom(crossLocation) && errorFrom(crossLocation) === "access_denied",
    `error=${errorFrom(crossLocation)} code=${codeFrom(crossLocation) ? "ISSUED" : "none"}`,
  );

  const noTicket = await authorizePost(
    { ...baseQuery, consent: "", decision: "allow" },
    sessionA.header(),
  );
  reporter.check(
    "POST /authorize refuses a submission with no consent ticket",
    !codeFrom(noTicket.headers.get("location")),
    `error=${errorFrom(noTicket.headers.get("location"))}`,
  );

  const swappedChallenge = pkce();
  const rebound = await authorizePost(
    { ...baseQuery, code_challenge: swappedChallenge.challenge, consent: ticketA, decision: "allow" },
    sessionA.header(),
  );
  reporter.check(
    "POST /authorize refuses a ticket rebound to a different code_challenge",
    !codeFrom(rebound.headers.get("location")),
    `error=${errorFrom(rebound.headers.get("location"))}`,
  );

  const anonymous = await authorizePost({ ...baseQuery, consent: ticketA, decision: "allow" });
  reporter.check(
    "POST /authorize refuses a submission with no session at all",
    !codeFrom(anonymous.headers.get("location")),
    `error=${errorFrom(anonymous.headers.get("location"))}`,
  );

  const denied = await authorizePost(
    { ...baseQuery, consent: ticketA, decision: "deny" },
    sessionA.header(),
  );
  reporter.check(
    "POST /authorize honours an explicit deny",
    !codeFrom(denied.headers.get("location")) &&
      errorFrom(denied.headers.get("location")) === "access_denied",
  );

  // ---------------- the happy path, then everything that must not work ----------------
  reporter.section("oauth: token exchange");

  const freshGet = await authorizeGet(baseQuery, sessionA.header());
  const freshTicket = ticketFrom(await freshGet.text());
  const granted = await authorizePost(
    { ...baseQuery, consent: freshTicket, decision: "allow" },
    sessionA.header(),
  );
  const code = codeFrom(granted.headers.get("location"));
  reporter.check("POST /authorize with a matching ticket issues a code", typeof code === "string");
  if (!code) return;

  const wrongClient = await tokenExchange({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: otherClientId ?? "bogus",
    code_verifier: verifier,
  });
  reporter.check(
    "token exchange refuses a code presented by a different client_id",
    wrongClient.status === 400 && !wrongClient.json?.access_token,
    `status=${wrongClient.status} ${wrongClient.json?.error_description ?? ""}`,
  );

  const wrongRedirect = await tokenExchange({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_ALT,
    client_id: clientId,
    code_verifier: verifier,
  });
  reporter.check(
    "token exchange requires redirect_uri EQUALITY, not just registration",
    wrongRedirect.status === 400 && !wrongRedirect.json?.access_token,
    `status=${wrongRedirect.status} ${wrongRedirect.json?.error_description ?? ""}`,
  );

  const wrongVerifier = await tokenExchange({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: pkce().verifier,
  });
  reporter.check(
    "token exchange refuses a mismatched PKCE verifier",
    wrongVerifier.status === 400 && !wrongVerifier.json?.access_token,
    `status=${wrongVerifier.status} ${wrongVerifier.json?.error_description ?? ""}`,
  );

  const noVerifier = await tokenExchange({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
  });
  reporter.check(
    "token exchange refuses an exchange with no verifier at all",
    noVerifier.status === 400 && !noVerifier.json?.access_token,
    `status=${noVerifier.status}`,
  );

  const garbage = await tokenExchange({
    grant_type: "authorization_code",
    code: "not.a.code",
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
  });
  reporter.check(
    "token exchange refuses a forged code",
    garbage.status === 400 && !garbage.json?.access_token,
  );

  const exchanged = await tokenExchange({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
  });
  reporter.check(
    "the correct exchange issues an access token",
    exchanged.status === 200 && typeof exchanged.json?.access_token === "string",
    `status=${exchanged.status} ${exchanged.json?.error_description ?? ""}`,
  );

  // The token's identity is the whole point: it must resolve to the user who
  // was signed in at the consent screen, and to nobody else's data.
  if (exchanged.json?.access_token && mcpProbeAs) {
    await mcpProbeAs(exchanged.json.access_token);
  }

  // ---------------- replay (reported, deliberately not fixed) ----------------
  reporter.section("oauth: authorization-code replay inside the 60s TTL");

  const replay = await tokenExchange({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
  });
  const replayed = replay.status === 200 && typeof replay.json?.access_token === "string";
  reporter.info(
    replayed
      ? "OBSERVED: the same authorization code exchanged twice inside its TTL, both times issuing a token."
      : `OBSERVED: the replayed code was rejected (status=${replay.status} ${replay.json?.error ?? ""}).`,
  );
  reporter.info(
    "Codes are verified by signature + 60s expiry with no single-use record, so this is expected.",
  );
  reporter.info(
    "Not fixed here by instruction: a real fix needs storage (a migration), and PKCE S256 means",
  );
  reporter.info(
    "an attacker replaying the code would also need the code_verifier. Reported, not patched.",
  );

  return { replayed };
}
