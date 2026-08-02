// Multi-tenant isolation proof — tranche 1 of the 2026-07-28 audit.
//
// The MCP tool layer runs on an RLS-BYPASSING service client, so tenant
// isolation there is an INVARIANT held up by an explicit `.eq("user_id", …)` on
// every query. One future query missing it is a full cross-tenant breach, and
// no static finder catches a class of *future* misses. This probe is the
// regression net: it creates two throwaway tenants, seeds identifiable data in
// every domain, and then
//
//   1. app path      — anon-key session clients, where RLS is the boundary;
//   2. mcp path      — every registered tool called with A's token but B's
//                      object ids and names (test/isolation/tool-matrix.mjs),
//                      asserting both "no B data returned" and "no B row
//                      changed", with coverage checked against the live
//                      tools/list so a new tool cannot silently go unprobed;
//   3. oauth path    — the authorization server driven over real HTTP
//                      (test/isolation/oauth-probe.mjs).
//
// Both tenants are deleted in a `finally`, and the deletion is verified.
//
// Usage:  node test/isolation-proof.mjs            # RLS checks only
//         MCP_URL=http://localhost:3000/api/mcp/mcp node test/isolation-proof.mjs
//
// Run it against a LOCAL dev server. Pointing MCP_URL at a deployed preview
// writes throwaway users into that deployment's database — the owner's call to
// make, not the probe's.
//
// The audit asks for a preview run eventually. Wiring it up needs, in order:
//   1. a preview deployment whose Supabase project is NOT production (the
//      probe creates and deletes real auth users, and seeds ~20 tables);
//   2. that project's URL + publishable key + service-role key in the
//      environment the probe runs in (it reads .env.local today — a CI job
//      would read the same names from secrets instead);
//   3. MCP_OAUTH_SECRET set on the deployment, or the whole OAuth section
//      fails at the first /authorize;
//   4. Vercel deployment protection disabled for that preview, or a bypass
//      token on every fetch — otherwise every request is a 401 HTML page;
//   5. MCP_URL=https://<preview>/api/mcp/mcp.
// Deliberately left unexecuted here: pointing it at a deployment is the
// owner's decision, not the probe author's.
//
// Reads NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and
// SUPABASE_SERVICE_ROLE_KEY from .env.local (MCP_OAUTH_SECRET too, on the
// server side, for the OAuth section). Never prints real user data — only ids
// and marker strings it created itself, and pass/fail lines.

import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createReporter, loadEnv, toolJson } from "./isolation/harness.mjs";
import { diffSnapshots, seedTenant, snapshotTenant } from "./isolation/seed.mjs";
import { reportCoverage, runToolMatrix } from "./isolation/mcp-probe.mjs";
import { makeSessionClient, runOauthProbe } from "./isolation/oauth-probe.mjs";

const env = loadEnv(new URL("../.env.local", import.meta.url));

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const MCP_URL = process.env.MCP_URL ?? null;
if (!SUPABASE_URL || !ANON || !SERVICE) {
  console.error("missing supabase env in .env.local");
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const reporter = createReporter();
const check = (label, ok, detail) => reporter.check(label, ok, detail);

// One nonce per run so a marker can never collide with a previous run's
// leftovers — a needle match is then unambiguous proof, not a coincidence.
const RUN = randomBytes(3).toString("hex");

async function makeUser(tag) {
  const email = `isolation-${tag}-${Date.now()}@mindboard-test.invalid`;
  const password = randomBytes(24).toString("base64url");
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser(${tag}): ${error.message}`);

  const client = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn(${tag}): ${signInError.message}`);

  // A second sign-in through @supabase/ssr, so the probe holds cookies shaped
  // exactly like a browser's for the OAuth section.
  const session = makeSessionClient(SUPABASE_URL, ANON);
  const { error: cookieError } = await session.client.auth.signInWithPassword({ email, password });
  if (cookieError) throw new Error(`cookieSignIn(${tag}): ${cookieError.message}`);

  return { id: data.user.id, email, password, client, session };
}

function patFor() {
  const token = `mbp_${randomBytes(32).toString("base64url")}`;
  return { token, hash: createHash("sha256").update(token, "utf8").digest("hex") };
}

async function mcpClient(bearer, name = "isolation-proof") {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return client;
}

let a = null;
let b = null;
let mcpA = null;
let mcpB = null;

try {
  reporter.section("setup: two throwaway tenants");
  a = await makeUser("a");
  b = await makeUser("b");
  reporter.info(`user A ${a.id}`);
  reporter.info(`user B ${b.id}`);
  reporter.info(`run marker zzp${RUN}`);

  const patA = patFor();
  const patB = patFor();

  const seedA = await seedTenant({
    client: a.client,
    admin,
    userId: a.id,
    marker: `zzp${RUN}a`,
    // Deliberately different zones: "today" resolved in the wrong tenant's zone
    // is a leak the timezone needle catches, and it is a defect class this
    // codebase has shipped before (see the audit's second CRITICAL).
    timezone: "Pacific/Kiritimati",
    patHash: patA.hash,
    patHint: patA.token.slice(-4),
  });
  const seedB = await seedTenant({
    client: b.client,
    admin,
    userId: b.id,
    marker: `zzp${RUN}b`,
    timezone: "America/Adak",
    patHash: patB.hash,
    patHint: patB.token.slice(-4),
  });
  check("both tenants seed a full row set through their own RLS session", true);

  const ctx = {
    admin,
    a: { ...seedA, userId: a.id },
    b: { ...seedB, userId: b.id },
  };

  // ---------------- app path: RLS is the boundary ----------------
  reporter.section("app path: RLS is the boundary");

  const { data: aSees } = await a.client.from("tasks").select("id, user_id");
  check(
    "A's unfiltered select returns only A's rows",
    (aSees ?? []).length === 2 && aSees.every((r) => r.user_id === a.id),
  );

  const { data: aReadsB } = await a.client.from("tasks").select("id").eq("id", ctx.b.taskId);
  check("A selecting B's task by id gets nothing", (aReadsB ?? []).length === 0);

  const { error: aForges } = await a.client
    .from("tasks")
    .insert({ user_id: b.id, title: "forged into B" });
  check("A inserting a row with user_id=B is rejected", Boolean(aForges));

  const { data: aUpdatesB } = await a.client
    .from("tasks")
    .update({ title: "A vandalized this" })
    .eq("id", ctx.b.taskId)
    .select("id");
  check("A updating B's task affects 0 rows", (aUpdatesB ?? []).length === 0);

  const { data: aDeletesB } = await a.client
    .from("tasks")
    .delete()
    .eq("id", ctx.b.taskId)
    .select("id");
  check("A deleting B's task affects 0 rows", (aDeletesB ?? []).length === 0);

  const { data: bStill } = await b.client
    .from("tasks")
    .select("title")
    .eq("id", ctx.b.taskId)
    .single();
  check("B's task is intact afterwards", bStill?.title === ctx.b.taskTitle);

  const { data: aSettings } = await a.client.from("user_settings").select("user_id");
  check(
    "A's user_settings view is limited to A",
    (aSettings ?? []).every((r) => r.user_id === a.id),
  );

  for (const table of ["accounts", "balance_changes", "inventory_items", "goals", "courses"]) {
    const { data } = await a.client.from(table).select("user_id");
    check(
      `A's unfiltered select on ${table} returns only A's rows`,
      (data ?? []).every((r) => r.user_id === a.id) && (data ?? []).length > 0,
    );
  }

  if (!MCP_URL) {
    reporter.info("\n(mcp + oauth checks skipped — set MCP_URL to a running local dev server)");
  } else {
    reporter.section(`mcp path: per-user tokens against ${MCP_URL}`);
    mcpA = await mcpClient(patA.token, "isolation-proof-a");
    mcpB = await mcpClient(patB.token, "isolation-proof-b");

    const tasksA = toolJson(await mcpA.callTool({ name: "list_tasks", arguments: {} }));
    check(
      "MCP as A lists exactly A's tasks",
      Array.isArray(tasksA) &&
        tasksA.length === 2 &&
        tasksA.every((t) => t.title.startsWith(ctx.a.marker)),
    );

    const tasksB = toolJson(await mcpB.callTool({ name: "list_tasks", arguments: {} }));
    check(
      "MCP as B lists exactly B's tasks",
      Array.isArray(tasksB) &&
        tasksB.length === 2 &&
        tasksB.every((t) => t.title.startsWith(ctx.b.marker)),
    );

    // B leaves a real pending proposal for A to try to steal, and vice versa.
    const bProposal = toolJson(
      await mcpB.callTool({
        name: "create_task",
        arguments: { title: `${ctx.b.marker}-proposed-task` },
      }),
    );
    check("B can propose a write over MCP", typeof bProposal?.proposalId === "string");
    ctx.b.proposalId = bProposal.proposalId;

    const aProposal = toolJson(
      await mcpA.callTool({
        name: "create_task",
        arguments: { title: `${ctx.a.marker}-proposed-task` },
      }),
    );
    ctx.a.proposalId = aProposal.proposalId;

    // Freeze B's world here: everything after this point is A attacking, and
    // nothing of B's may move.
    const before = await snapshotTenant(admin, b.id);

    const exercised = await runToolMatrix({ mcpA, ctx, reporter });

    reporter.section("post-sweep: nothing of B's changed");
    const after = await snapshotTenant(admin, b.id);
    const changed = diffSnapshots(before, after);
    check(
      "every row B owns is byte-identical after A's full attack sweep",
      changed.length === 0,
      changed.join("; "),
    );

    reporter.section("propose → confirm across the boundary, both directions");
    const bConfirmsA = await mcpB.callTool({
      name: "confirm_action",
      arguments: { proposalId: ctx.a.proposalId },
    });
    check("B confirming A's proposal fails", bConfirmsA.isError === true);

    const bCancelsA = await mcpB.callTool({
      name: "cancel_action",
      arguments: { proposalId: ctx.a.proposalId },
    });
    check("B cancelling A's proposal fails", bCancelsA.isError === true);

    const aCancelsOwn = await mcpA.callTool({
      name: "cancel_action",
      arguments: { proposalId: ctx.a.proposalId },
    });
    check("A can still cancel their own proposal afterwards", aCancelsOwn.isError !== true);

    const bProposals = toolJson(
      await mcpB.callTool({ name: "list_proposals", arguments: { limit: 100 } }),
    );
    check(
      "B's list_proposals never shows A's rows",
      Array.isArray(bProposals) && bProposals.every((p) => !p.summary?.includes(ctx.a.marker)),
    );

    reporter.section("token handling");
    const badTransport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: {
        headers: { authorization: "Bearer mbp_not_a_real_token_aaaaaaaaaaaaaaaaaaaaaaa" },
      },
    });
    const badClient = new Client({ name: "isolation-proof-bad", version: "1.0.0" });
    let badRejected = false;
    try {
      await badClient.connect(badTransport);
    } catch {
      badRejected = true;
    }
    check("an invalid PAT is rejected outright", badRejected);

    const noAuthTransport = new StreamableHTTPClientTransport(new URL(MCP_URL));
    const noAuthClient = new Client({ name: "isolation-proof-anon", version: "1.0.0" });
    let anonRejected = false;
    try {
      await noAuthClient.connect(noAuthTransport);
    } catch {
      anonRejected = true;
    }
    check("an unauthenticated connection is rejected outright", anonRejected);

    if (env.MCP_BEARER_TOKEN && env.MINDBOARD_OWNER_USER_ID) {
      const mcpOwner = await mcpClient(env.MCP_BEARER_TOKEN, "isolation-proof-owner");
      const ownerTasks = toolJson(await mcpOwner.callTool({ name: "list_tasks", arguments: {} }));
      const titles = (ownerTasks ?? []).map((t) => t.title ?? "");
      check(
        "legacy static token still works and maps to the owner, not to a probe tenant",
        Array.isArray(ownerTasks) && !titles.some((t) => t.includes(`zzp${RUN}`)),
      );
      await mcpOwner.close();
    }

    await reportCoverage({ mcpA, exercised, reporter });

    // ---------------- oauth over real HTTP ----------------
    const origin = new URL(MCP_URL).origin;
    await runOauthProbe({
      origin,
      sessionA: a.session,
      sessionB: b.session,
      reporter,
      mcpProbeAs: async (accessToken) => {
        const oauthClient = await mcpClient(accessToken, "isolation-proof-oauth");
        const seen = toolJson(await oauthClient.callTool({ name: "list_tasks", arguments: {} }));
        check(
          "an OAuth access token resolves to the consenting user and only their data",
          Array.isArray(seen) &&
            seen.length > 0 &&
            seen.every((t) => (t.title ?? "").startsWith(ctx.a.marker)),
        );
        await oauthClient.close();
      },
    });
  }
} catch (e) {
  reporter.fail("probe aborted", e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
} finally {
  for (const client of [mcpA, mcpB]) {
    if (client) await client.close().catch(() => {});
  }

  reporter.section("cleanup");
  for (const u of [a, b]) {
    if (!u) continue;
    const { error } = await admin.auth.admin.deleteUser(u.id);
    check(`deleted throwaway user ${u.id}`, !error, error?.message);
    const { data: stillThere } = await admin.auth.admin.getUserById(u.id);
    check(`user ${u.id} is really gone from auth`, !stillThere?.user);
    const { data: orphans } = await admin.from("tasks").select("id").eq("user_id", u.id);
    check(`user ${u.id}'s rows cascaded away`, (orphans ?? []).length === 0);
  }
}

console.log(
  reporter.state.failures === 0
    ? `\nALL ${reporter.state.passes} CHECKS PASSED`
    : `\n${reporter.state.failures} CHECK(S) FAILED of ${reporter.state.passes + reporter.state.failures}`,
);
if (reporter.state.failures > 0) {
  console.log("\nfailed checks:");
  for (const note of reporter.state.notes) console.log(`  - ${note}`);
}
process.exit(reporter.state.failures === 0 ? 0 : 1);
