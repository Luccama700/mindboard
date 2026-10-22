// Multi-tenant isolation proof. Creates two throwaway auth users, verifies
// that neither can read or write the other's rows through (1) the app path
// (anon-key session clients, where RLS is the boundary) and (2) the MCP server
// (per-user PATs against a running dev server, where explicit user scoping is
// the boundary), then deletes both users (rows cascade).
//
// Usage:  node test/isolation-proof.mjs            # RLS checks only
//         MCP_URL=http://localhost:3000/api/mcp/mcp node test/isolation-proof.mjs
//
// Reads NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and
// SUPABASE_SERVICE_ROLE_KEY from .env.local. Never prints real user data —
// only ids it created itself and pass/fail lines.

import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const MCP_URL = process.env.MCP_URL ?? null;
if (!URL_ || !ANON || !SERVICE) {
  console.error("missing supabase env in .env.local");
  process.exit(1);
}

const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "  PASS" : "! FAIL"}  ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function makeUser(tag) {
  const email = `isolation-${tag}-${Date.now()}@mindboard-test.invalid`;
  const password = randomBytes(24).toString("base64url");
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${tag}): ${error.message}`);
  const client = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn(${tag}): ${signInError.message}`);
  return { id: data.user.id, email, client };
}

function patFor() {
  const token = `mbp_${randomBytes(32).toString("base64url")}`;
  return { token, hash: createHash("sha256").update(token, "utf8").digest("hex") };
}

async function mcpClient(bearer) {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: "isolation-proof", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function toolJson(result) {
  const text = result?.content?.find((c) => c.type === "text")?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

let a = null;
let b = null;

try {
  console.log("== setup: two throwaway users ==");
  a = await makeUser("a");
  b = await makeUser("b");
  console.log(`  user A ${a.id}`);
  console.log(`  user B ${b.id}`);

  const { data: taskA, error: seedAErr } = await a.client
    .from("tasks").insert({ user_id: a.id, title: "A secret task" }).select("id").single();
  const { data: taskB, error: seedBErr } = await b.client
    .from("tasks").insert({ user_id: b.id, title: "B secret task" }).select("id").single();
  check("each user can insert their own task (RLS with check)", !seedAErr && !seedBErr,
    seedAErr?.message ?? seedBErr?.message);

  console.log("\n== app path: RLS is the boundary ==");
  const { data: aSees } = await a.client.from("tasks").select("id, user_id");
  check("A's unfiltered select returns only A's rows",
    (aSees ?? []).length === 1 && aSees.every((r) => r.user_id === a.id));

  const { data: aReadsB } = await a.client.from("tasks").select("id").eq("id", taskB.id);
  check("A selecting B's task by id gets nothing", (aReadsB ?? []).length === 0);

  const { error: aForges } = await a.client
    .from("tasks").insert({ user_id: b.id, title: "forged into B" });
  check("A inserting a row with user_id=B is rejected", Boolean(aForges));

  const { data: aUpdatesB } = await a.client
    .from("tasks").update({ title: "A vandalized this" }).eq("id", taskB.id).select("id");
  check("A updating B's task affects 0 rows", (aUpdatesB ?? []).length === 0);

  const { data: aDeletesB } = await a.client
    .from("tasks").delete().eq("id", taskB.id).select("id");
  check("A deleting B's task affects 0 rows", (aDeletesB ?? []).length === 0);

  const { data: bStill } = await b.client.from("tasks").select("title").eq("id", taskB.id).single();
  check("B's task is intact afterwards", bStill?.title === "B secret task");

  const { data: aSettings } = await a.client.from("user_settings").select("user_id");
  check("A's user_settings view is limited to A", (aSettings ?? []).every((r) => r.user_id === a.id));

  // ---- URC (migration 0054): service-role-only tables + read-own log ----
  // urc_devices/urc_jobs have RLS enabled with NO policies, so a session
  // client reaches nothing at all — not even its own rows. urc_log is
  // select-own and append-only to clients.
  console.log("\n== urc path: service-role-only tables ==");
  const { error: urcProbe } = await admin.from("urc_devices").select("id").limit(1);
  if (urcProbe) {
    console.log(`  SKIP  urc checks — urc tables not present yet (${urcProbe.message})`);
    console.log("        apply supabase/migrations/0054_urc.sql first");
  } else {
    const { data: deviceA, error: deviceErr } = await admin
      .from("urc_devices")
      .insert({
        user_id: a.id,
        name: "isolation-proof-a",
        token_hash: createHash("sha256").update(randomBytes(32)).digest("hex"),
        folder_keys: ["proof"],
      })
      .select("id")
      .single();
    if (deviceErr) throw new Error(`seed urc device: ${deviceErr.message}`);

    const { data: jobA, error: jobErr } = await admin
      .from("urc_jobs")
      .insert({
        user_id: a.id,
        device_id: deviceA.id,
        folder_key: "proof",
        confirmed_auth: "pat",
      })
      .select("id")
      .single();
    if (jobErr) throw new Error(`seed urc job: ${jobErr.message}`);

    const { error: logErr } = await admin.from("urc_log").insert({
      user_id: a.id,
      job_id: jobA.id,
      event: "spawn_confirmed",
      folder_key: "proof",
      confirmed_auth: "pat",
    });
    if (logErr) throw new Error(`seed urc log: ${logErr.message}`);

    const { data: bDevices } = await b.client.from("urc_devices").select("id, token_hash");
    check("B cannot read urc_devices at all (no policy)", (bDevices ?? []).length === 0);

    const { data: aDevices } = await a.client.from("urc_devices").select("id");
    check("not even the device's own user can read urc_devices", (aDevices ?? []).length === 0);

    const { data: bJobs } = await b.client.from("urc_jobs").select("id, session_url");
    check("B cannot read urc_jobs at all (no policy)", (bJobs ?? []).length === 0);

    const { data: aJobs } = await a.client.from("urc_jobs").select("id");
    check("not even the job's own user can read urc_jobs", (aJobs ?? []).length === 0);

    const { data: bQueues, error: bQueueErr } = await b.client
      .from("urc_jobs")
      .insert({ user_id: b.id, device_id: deviceA.id, folder_key: "proof", confirmed_auth: "pat" })
      .select("id");
    check("B cannot queue a urc job", Boolean(bQueueErr) || (bQueues ?? []).length === 0);

    const { data: bHijack } = await b.client
      .from("urc_jobs")
      .update({ session_url: "https://claude.ai/code/session_hijacked" })
      .eq("id", jobA.id)
      .select("id");
    check("B updating A's urc job affects 0 rows", (bHijack ?? []).length === 0);

    const { data: bReadsLog } = await b.client.from("urc_log").select("id, user_id");
    check("B's urc_log view is empty (A's rows are invisible)", (bReadsLog ?? []).length === 0);

    const { data: aReadsLog } = await a.client.from("urc_log").select("id, user_id");
    check(
      "A can read A's own urc_log rows",
      (aReadsLog ?? []).length === 1 && aReadsLog.every((r) => r.user_id === a.id),
    );

    const { data: bWritesLog, error: bWriteLogErr } = await b.client
      .from("urc_log")
      .insert({ user_id: b.id, event: "started" })
      .select("id");
    check(
      "urc_log is append-only to clients (B's insert is rejected)",
      Boolean(bWriteLogErr) || (bWritesLog ?? []).length === 0,
    );

    const { error: bClaimErr } = await b.client.rpc("claim_urc_job", { p_device: deviceA.id });
    check("B cannot call claim_urc_job", Boolean(bClaimErr), "the RPC answered a session client");

    const { error: aClaimErr } = await a.client.rpc("claim_urc_job", { p_device: deviceA.id });
    check("not even the device's own user can call claim_urc_job", Boolean(aClaimErr));
  }

  if (MCP_URL) {
    console.log("\n== mcp path: per-user tokens against " + MCP_URL + " ==");
    const patA = patFor();
    const patB = patFor();
    for (const [u, pat] of [[a, patA], [b, patB]]) {
      const { error } = await admin.from("user_settings").upsert(
        { user_id: u.id, mcp_token_hash: pat.hash, mcp_token_hint: pat.token.slice(-4) },
        { onConflict: "user_id" },
      );
      if (error) throw new Error(`seed PAT: ${error.message}`);
    }

    const mcpA = await mcpClient(patA.token);
    const mcpB = await mcpClient(patB.token);

    const tasksA = toolJson(await mcpA.callTool({ name: "list_tasks", arguments: {} }));
    check("MCP as A lists exactly A's task",
      Array.isArray(tasksA) && tasksA.length === 1 && tasksA[0].title === "A secret task");

    const tasksB = toolJson(await mcpB.callTool({ name: "list_tasks", arguments: {} }));
    check("MCP as B lists exactly B's task",
      Array.isArray(tasksB) && tasksB.length === 1 && tasksB[0].title === "B secret task");

    const proposal = toolJson(await mcpA.callTool({
      name: "create_task", arguments: { title: "A proposed task" },
    }));
    check("A can propose a write over MCP", typeof proposal?.proposalId === "string");

    const bConfirms = await mcpB.callTool({
      name: "confirm_action", arguments: { proposalId: proposal.proposalId },
    });
    check("B confirming A's proposal fails", bConfirms.isError === true);

    const aCancels = await mcpA.callTool({
      name: "cancel_action", arguments: { proposalId: proposal.proposalId },
    });
    check("A can cancel their own proposal", aCancels.isError !== true);

    const badTransport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { authorization: "Bearer mbp_not_a_real_token_aaaaaaaaaaaaaaaaaaaaaaa" } },
    });
    const badClient = new Client({ name: "isolation-proof-bad", version: "1.0.0" });
    let badRejected = false;
    try {
      await badClient.connect(badTransport);
    } catch {
      badRejected = true;
    }
    check("an invalid PAT is rejected outright", badRejected);

    // ---- URC tools over MCP: owner-only, and never the static bearer ----
    const toolNames = new Set((await mcpB.listTools()).tools.map((t) => t.name));
    if (!toolNames.has("spawn_urc")) {
      console.log("  SKIP  urc tool checks — spawn_urc is not registered (URC_OWNER_USER_ID unset)");
    } else {
      const bSpawns = await mcpB.callTool({
        name: "spawn_urc",
        arguments: { folder: "proof" },
      });
      check("B's PAT is refused by spawn_urc", bSpawns.isError === true);

      const bLists = await mcpB.callTool({ name: "list_urc_sessions", arguments: {} });
      check("B's PAT is refused by list_urc_sessions", bLists.isError === true);

      if (env.MCP_BEARER_TOKEN) {
        // The static bearer maps to the owner, so this is the check that URC's
        // credential gate is real and not just an ownership check: every URC
        // tool, AND confirm_action on a URC proposal, must refuse it.
        const mcpStatic = await mcpClient(env.MCP_BEARER_TOKEN);
        const someJobId = "00000000-0000-4000-8000-000000000000";
        const staticCalls = [
          ["spawn_urc", { folder: "proof" }],
          ["list_urc_sessions", {}],
          ["get_urc_status", { jobId: someJobId }],
          ["stop_urc", { jobId: someJobId }],
        ];
        for (const [name, args] of staticCalls) {
          const result = await mcpStatic.callTool({ name, arguments: args });
          check(`the static bearer is refused by ${name} even as the owner`, result.isError === true);
        }

        // A spawn_urc proposal the owner could legitimately have made: planted
        // directly (service role) because the static bearer cannot propose one.
        if (env.MINDBOARD_OWNER_USER_ID) {
          const { data: planted, error: plantErr } = await admin
            .from("ai_audit_log")
            .insert({
              user_id: env.MINDBOARD_OWNER_USER_ID,
              source: "mcp",
              status: "proposed",
              tool_name: "spawn_urc",
              input: { folder: "proof" },
              summary: "isolation-proof: static bearer must not confirm this",
            })
            .select("id")
            .single();
          if (plantErr) {
            check("could plant a spawn_urc proposal for the confirm check", false, plantErr.message);
          } else {
            const staticConfirm = await mcpStatic.callTool({
              name: "confirm_action",
              arguments: { proposalId: planted.id },
            });
            check(
              "the static bearer is refused by confirm_action on a URC proposal",
              staticConfirm.isError === true,
            );
            const { data: after } = await admin
              .from("ai_audit_log")
              .select("status")
              .eq("id", planted.id)
              .maybeSingle();
            check(
              "the refused confirm started no session",
              after?.status !== "executed",
              `proposal ended as ${after?.status}`,
            );
            await admin.from("ai_audit_log").delete().eq("id", planted.id);
          }
        }
        await mcpStatic.close();
      }
    }

    if (env.MCP_BEARER_TOKEN && env.MINDBOARD_OWNER_USER_ID) {
      const mcpOwner = await mcpClient(env.MCP_BEARER_TOKEN);
      const ownerTasks = toolJson(await mcpOwner.callTool({ name: "list_tasks", arguments: {} }));
      const titles = new Set((ownerTasks ?? []).map((t) => t.title));
      check("legacy static token still works and maps to the owner",
        Array.isArray(ownerTasks) && !titles.has("A secret task") && !titles.has("B secret task"));
      await mcpOwner.close();
    }

    await mcpA.close();
    await mcpB.close();
  } else {
    console.log("\n(mcp checks skipped — set MCP_URL to a running server to include them)");
  }
} catch (e) {
  failures += 1;
  console.error("! ERROR ", e instanceof Error ? e.message : e);
} finally {
  console.log("\n== cleanup ==");
  for (const u of [a, b]) {
    if (!u) continue;
    const { error } = await admin.auth.admin.deleteUser(u.id);
    console.log(error ? `! FAIL  delete ${u.id}: ${error.message}` : `  PASS  deleted ${u.id} (rows cascade)`);
    if (error) failures += 1;
  }
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
