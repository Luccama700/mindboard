import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// The static half of audit M4. The two-tenant probe
// (test/isolation-proof.mjs) is the real net, but it needs a database, a dev
// server and two throwaway tenants — so it cannot gate a PR. This can: it reads
// the source, finds every query chain that runs on a client which may be the
// RLS-BYPASSING service client, and fails on any that carries no `user_id`
// filter and no `user_id` insert payload.
//
// It is a LINTER, not a proof. It cannot follow dataflow, so a `user_id`
// resolved three frames up is invisible to it, and a chain whose filter is
// added in a later statement reads as unscoped. Both of those are what the
// allowlist is for, and every entry has to say why. What it does buy is the one
// thing review keeps missing: a brand-new `.from("x").select(...)` with no
// filter at all, in the trees where RLS is not the boundary, goes red the first
// time anyone runs `npm run test`.
//
// Derived from the sweep script the 2026-10-26 auditor used by hand; this is
// that idea, wired to the gate.

const ROOT = path.resolve(__dirname, "..");

// The trees whose code may run on the service client. app/lib/data/* is
// deliberately absent: it is cookie-client only (RLS is its boundary), and the
// MCP/assistant paths that share its logic go through planning-read.ts and
// forecast.ts, which are in scope below.
const SCOPED_DIRS = [
  "app/lib/mcp",
  "app/lib/urc",
  "app/lib/learn",
  "app/lib/people",
  "app/lib/watch",
  "app/lib/mindspace",
  "app/lib/snapshots",
  "app/lib/finance",
  "app/lib/shopping",
  "app/api",
];

const SERVICE_IMPORT = "utils/supabase/service";
const COOKIE_IMPORT = "utils/supabase/server";

type Chain = {
  file: string;
  line: number;
  table: string;
  verb: string;
  kind: "table" | "rpc" | "storage";
  text: string;
};

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const dir of SCOPED_DIRS) {
    const full = path.join(ROOT, dir);
    try {
      if (statSync(full).isFile()) files.push(full);
      else walk(full, files);
    } catch {
      // A renamed tree must not silently shrink the scan; asserted below.
    }
  }
  return files;
}

// A file is out of scope only when it can PROVABLY never hold a service
// client: it reads the cookie client and never imports the service factory.
// There RLS is the boundary and an id-only filter is correct by construction
// (/api/assistant and /api/course-chat are the two live examples).
//
// Everything else is in scope — including the client-agnostic libraries that
// take `supabase: SupabaseClient` as a parameter, because the MCP route hands
// those the service client.
function inScope(src: string): boolean {
  const usesService = src.includes(SERVICE_IMPORT);
  const usesCookie = src.includes(COOKIE_IMPORT);
  return usesService || !usesCookie;
}

// Everything that counts as scoping the chain to one tenant.
//
// `.match(` counts ONLY when it names user_id: `.match({ id, rule_id })` is a
// composite-key lookup, not a tenant filter, and treating every .match() as
// scoped is how a detector like this goes quietly blind.
const USER_FILTER =
  /\.(eq|neq|in|is|not|gt|gte|lt|lte|like|ilike|filter)\(\s*["'`]user_id["'`]/;
const USER_MATCH = /\.match\(\s*\{[^}]*user_id/;
// For insert/upsert the tenant is named in the payload, not in a filter.
const USER_PAYLOAD = /user_id\s*:/;
// For storage the tenant is the first path segment, so the path expression has
// to be built from the caller's id.
const STORAGE_SCOPE = /userId|user_id|ownerId|\$\{uid/;

const WRITE_VERBS = new Set(["insert", "upsert"]);

// Literal table/bucket/function names only. `Buffer.from(…)` is the same four
// characters and appears all over the auth code, so matching a bare identifier
// turns this file into a wall of noise about constant-time compares. The ONE
// dynamic `.from(table)` in the codebase (ownsRow) gets its own assertion at
// the bottom of this file, because a hand-checked call site is only
// hand-checked until someone adds a second one.
function extractChains(file: string, src: string): Chain[] {
  const out: Chain[] = [];
  const starts = /\.(from|rpc)\(\s*["'`]([A-Za-z0-9_-]+)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = starts.exec(src))) {
    // Cut at the statement end, then at the next query start — so a sibling in
    // a Promise.all cannot lend its filter to its neighbour.
    let end = src.indexOf(";", m.index);
    if (end < 0) end = src.length;
    const next = /\.(from|rpc)\(/g;
    next.lastIndex = m.index + 5;
    const n2 = next.exec(src);
    if (n2 && n2.index < end) end = n2.index;

    const text = src.slice(m.index, end);
    const before = src.slice(Math.max(0, m.index - 80), m.index);
    const isStorage = /storage\s*$|storage\s*\n?\s*$/.test(before.replace(/\s+$/, "$&"))
      ? true
      : /\.storage\b[^;]*$/.test(before);
    const verbMatch = text.match(
      /\.(select|insert|update|upsert|delete|createSignedUrl|createSignedUploadUrl|upload|download|remove|list|copy|move)\(/,
    );
    out.push({
      file,
      line: src.slice(0, m.index).split("\n").length,
      table: m[2],
      verb: verbMatch ? verbMatch[1] : m[1],
      kind: isStorage ? "storage" : m[1] === "rpc" ? "rpc" : "table",
      text: text.replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

function isScoped(chain: Chain): boolean {
  if (chain.kind === "storage") return STORAGE_SCOPE.test(chain.text);
  if (chain.kind === "rpc") return false; // RPCs scope inside the function; allowlist each.
  if (USER_FILTER.test(chain.text) || USER_MATCH.test(chain.text)) return true;
  if (WRITE_VERBS.has(chain.verb) && USER_PAYLOAD.test(chain.text)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// The allowlist. Every entry is a chain that carries no user_id filter and is
// CORRECT anyway, or a chain that is a known open finding. Matching is by file
// + table + a disambiguating substring + an exact count, so a line shift does
// not break an entry but a NEW unscoped chain on the same table does.
//
// Adding an entry here is a security decision. Say why, in a sentence someone
// can check.
// ---------------------------------------------------------------------------
type Allow = {
  file: string;
  table: string;
  contains: string;
  count: number;
  why: string;
};

const ALLOWLIST: Allow[] = [
  {
    file: "app/lib/mcp/pat.ts",
    table: "user_settings",
    contains: "mcp_token_hash",
    count: 1,
    why:
      "This IS the identity lookup. A presented mbp_ token is hashed and the row it matches " +
      "defines who the caller is, so there is no user_id to filter by yet — filtering would " +
      "be circular. mcp_token_hash is unique, and the hash is compared, never the token.",
  },
  {
    file: "app/lib/urc/device.ts",
    table: "urc_devices",
    contains: "token_hash",
    count: 1,
    why:
      "Same shape as the PAT lookup: the device token resolves WHICH device (and so which " +
      "user) is calling /api/urc/device. token_hash is unique and compared with " +
      "timingSafeEqual. urc_devices has RLS on with no policies, so only this path reads it.",
  },
  {
    file: "app/lib/urc/device.ts",
    table: "claim_urc_job",
    contains: "p_device",
    count: 1,
    why:
      "Scoped by device, not by user, and only reachable after the device token above " +
      "resolved. The RPC itself constrains every row to `user_id = (select user_id from " +
      "urc_devices where id = p_device)` (0054_urc.sql), so the tenant filter is inside the " +
      "function. It is not executable by anon or authenticated.",
  },
  {
    file: "app/api/worker/route.ts",
    table: "claim_next_job",
    contains: "allowed_users",
    count: 1,
    why:
      "The home worker's claim. It is deliberately NOT per-caller: the worker claims on " +
      "behalf of an allowlist, which is passed as allowed_users and applied inside the " +
      "SECURITY DEFINER function (0035_multi_tenant_mcp.sql). Service-role only, and not " +
      "executable by anon or authenticated.",
  },
  {
    file: "app/lib/people/sync.ts",
    table: "people",
    contains: "upsert(rows,",
    count: 1,
    why:
      "`rows` is PeopleInsert[], and PeopleInsert declares `user_id: string` as required " +
      "(sync.ts:45), so tsc enforces what this regex cannot see. onConflict is " +
      "\"user_id,vault_path\", which keeps the arbiter per-tenant too.",
  },
  {
    file: "app/lib/people/sync.ts",
    table: "people",
    contains: "upsert([row],",
    count: 1,
    why:
      "The row-by-row retry after a name collision, re-upserting one element of the same " +
      "PeopleInsert[] — same compiler guarantee as the batch above.",
  },
  {
    file: "app/lib/mindspace/sessions.ts",
    table: "mindspace_sessions",
    contains: "upsert(rows,",
    count: 1,
    why:
      "Every element of `rows` is built with `user_id: userId` ~25 lines above, in the same " +
      "function, and onConflict is \"user_id,provider,session_ref\" so a re-sent ref can only " +
      "ever update the caller's own row.",
  },
  {
    file: "app/lib/learn/artifacts.ts",
    table: "course_cards",
    contains: "insert(rows)",
    count: 1,
    why:
      "Every row in `rows` is built with `user_id: userId` a few lines above; the payload is " +
      "a variable, which is the one thing this detector cannot see through.",
  },
  {
    file: "app/lib/learn/convert.ts",
    table: "course-files",
    contains: "source.storage_path",
    count: 1,
    why:
      "The source row was read with `.eq(\"user_id\", userId)` immediately above, so the path " +
      "belongs to the caller. (That storage_path is user-WRITABLE over RLS is audit F3 — a " +
      "path-shape finding, not a missing tenant filter, and it is tracked separately.)",
  },
  {
    file: "app/lib/learn/episodes.ts",
    table: "course-audio",
    contains: "upload(storagePath",
    count: 1,
    why:
      "storagePath is `${userId}/${episodeId}.wav`, built on the line above from the caller's " +
      "id. The literal is in a variable, so only the name reaches this chain.",
  },
  {
    file: "app/lib/mindspace/pipeline.ts",
    table: "mindspace_labels",
    contains: 'delete().eq("item_id"',
    count: 1,
    why:
      "item_id comes from the `.select(\"id\").single()` of a user-scoped upsert in the same " +
      "loop iteration, so it can only ever be the caller's own item.",
  },
  // ---- OAuth bookkeeping with no user column ----
  {
    file: "app/lib/mcp/oauth-store.ts",
    table: "oauth_used_codes",
    contains: "insert({ code_hash",
    count: 1,
    why:
      "oauth_used_codes records spent authorization-code hashes; it has no user column by " +
      "design (a code is single-use globally, whoever it belonged to). Service-role only, no " +
      "client policy (0059).",
  },
  {
    file: "app/lib/mcp/oauth-store.ts",
    table: "oauth_used_codes",
    contains: '.lt("expires_at"',
    count: 1,
    why: "Garbage-collects expired code hashes across all users; the table holds no user data.",
  },
  // ---- worker storage ----
  {
    file: "app/api/worker/route.ts",
    table: "course-files",
    contains: "createSignedUrl(source.storage_path",
    count: 1,
    why:
      "The source row was read with `.eq(\"user_id\", job.user_id)` directly above. The " +
      "path-shape half is audit F3, tracked separately.",
  },
  {
    file: "app/api/worker/route.ts",
    table: "course-audio",
    contains: "createSignedUploadUrl(audioPath",
    count: 1,
    why: "audioPath is rebuilt server-side as `${job.user_id}/${episodeId}.wav`, never taken from the worker.",
  },
  {
    file: "app/api/worker/route.ts",
    table: "course-audio",
    contains: "createSignedUrl(audioPath",
    count: 1,
    why: "Same rebuilt `${job.user_id}/…` path, read back to confirm the upload landed.",
  },
];

function allowKey(a: Allow) {
  return `${a.file} :: ${a.table} :: ${a.contains}`;
}

function matches(a: Allow, c: Chain) {
  return (
    c.file.replace(/\\/g, "/").endsWith(a.file) &&
    c.table === a.table &&
    c.text.includes(a.contains)
  );
}

const files = sourceFiles();
const scanned = files.filter((f) => inScope(readFileSync(f, "utf8")));
const chains = scanned.flatMap((f) => extractChains(f, readFileSync(f, "utf8")));
const unscoped = chains.filter((c) => !isScoped(c));

describe("tenant-scope invariant (static)", () => {
  it("actually scanned the trees it claims to", () => {
    // Without this, a renamed directory turns the whole file into a no-op that
    // reports zero violations and passes forever.
    expect(files.length, "no source files found — SCOPED_DIRS is stale").toBeGreaterThan(40);
    expect(scanned.length, "every scanned file was excluded as cookie-client-only").toBeGreaterThan(
      25,
    );
    expect(chains.length, "no query chains parsed — the extractor is broken").toBeGreaterThan(200);
  });

  it("excludes only the files where RLS is provably the boundary", () => {
    const excluded = files
      .filter((f) => !inScope(readFileSync(f, "utf8")))
      .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"))
      .sort();
    // These read the cookie client and never import the service factory, so
    // every statement they issue runs under the caller's own JWT. If a file
    // leaves this list it has started using the service client and its chains
    // are now checked — which is the point.
    expect(excluded).toEqual([
      "app/api/account/export/route.ts",
      "app/api/assistant/route.ts",
      "app/api/course-chat/route.ts",
      "app/api/mcp/oauth/authorize/route.ts",
      "app/lib/mindspace/read.ts",
      "app/lib/mindspace/share-bar.ts",
      "app/lib/people/suggest-groups.ts",
    ]);
  });

  // The one query in these trees whose table is a variable. ownsRow is the
  // ownership primitive a dozen executors call, so it is also the single most
  // load-bearing `.eq("user_id")` in the codebase — and the chain extractor
  // above deliberately cannot see it.
  it("checks the one dynamic-table query by hand, and stays the only one", () => {
    const writes = readFileSync(path.join(ROOT, "app/lib/mcp/writes.ts"), "utf8");
    const chain = writes.slice(writes.indexOf("async function ownsRow"));
    const body = chain.slice(0, chain.indexOf("\n}"));
    expect(body).toContain(".from(table)");
    expect(body).toContain('.eq("id", id)');
    expect(body).toContain('.eq("user_id", ownerId)');

    // Filter on the RECEIVER, not the argument: `Buffer.from(token)` is not a
    // query, and the auth code is full of it.
    const NOT_A_CLIENT = /^(Buffer|Array|Object|String|Uint8Array|Int8Array|Float32Array)$/;
    const dynamic = scanned.flatMap((f) => {
      const src = readFileSync(f, "utf8");
      return [
        ...src.matchAll(
          /([A-Za-z_$][A-Za-z0-9_$]*)\s*\.(from|rpc)\(\s*([A-Za-z_$][A-Za-z0-9_$.]*)\s*[,)]/g,
        ),
      ]
        .filter(([, receiver]) => !NOT_A_CLIENT.test(receiver))
        .map(() => path.relative(ROOT, f).replace(/\\/g, "/"));
    });
    expect([...new Set(dynamic)].sort(), "a new dynamic-table query needs its own check").toEqual([
      "app/lib/mcp/writes.ts",
    ]);
  });

  it("files every query chain by a user_id filter, a user_id payload, or the allowlist", () => {
    const leftover = unscoped.filter((c) => !ALLOWLIST.some((a) => matches(a, c)));
    const report = leftover.map(
      (c) =>
        `${path.relative(ROOT, c.file).replace(/\\/g, "/")}:${c.line}  ${c.table}.${c.verb}\n` +
        `      ${c.text.slice(0, 180)}`,
    );
    expect(
      report,
      "Service-client query chains with no tenant filter. Add `.eq(\"user_id\", …)`, or — " +
        "if it is genuinely unscoped by design — add an ALLOWLIST entry in this file saying why.",
    ).toEqual([]);
  });

  it("has no stale allowlist entry", () => {
    // A stale allowlist is silent rot: the chain it excused is gone (or was
    // fixed), and the entry now excuses whatever moves into its place.
    const stale = ALLOWLIST.filter(
      (a) => !unscoped.some((c) => matches(a, c)),
    ).map(allowKey);
    expect(stale, "allowlist entries that no longer match any unscoped chain — delete them").toEqual(
      [],
    );
  });

  it("holds every allowlist entry to its exact count", () => {
    // The count is what stops an entry from quietly widening: a second
    // unscoped `jobs` update in the worker route would otherwise be covered by
    // the first one's reason.
    const drifted = ALLOWLIST.filter(
      (a) => unscoped.filter((c) => matches(a, c)).length !== a.count,
    ).map((a) => `${allowKey(a)} — expected ${a.count}, found ${unscoped.filter((c) => matches(a, c)).length}`);
    expect(drifted).toEqual([]);
  });

  it("gives every allowlist entry a reason, and no duplicates", () => {
    for (const a of ALLOWLIST) {
      expect(a.why.length, `${allowKey(a)} needs a real reason`).toBeGreaterThan(60);
    }
    const keys = ALLOWLIST.map(allowKey);
    expect(new Set(keys).size, "duplicate allowlist entry").toBe(keys.length);
  });

  it("counts .match() as scoping only when it names user_id", () => {
    const probe = (text: string): boolean =>
      isScoped({
        file: "x.ts",
        line: 1,
        table: "tasks",
        verb: "update",
        kind: "table",
        text,
      });
    expect(probe('.from("tasks").update(p).match({ user_id: uid, id })')).toBe(true);
    expect(probe('.from("tasks").update(p).match({ rule_id: r, occurred_on: d })')).toBe(false);
    // A user_id in a SELECT list is a column, not a filter — this is exactly
    // the shape of the worker's loadJob, which must stay visible.
    expect(probe('.from("jobs").select("id, user_id, kind").eq("id", jobId)')).toBe(false);
    expect(probe('.from("jobs").select("id").eq("user_id", uid)')).toBe(true);
    // An insert is scoped by its payload, an update is not.
    expect(probe('.from("tasks").insert({ user_id: uid, title })')).toBe(false);
    expect(
      isScoped({
        file: "x.ts",
        line: 1,
        table: "tasks",
        verb: "insert",
        kind: "table",
        text: '.from("tasks").insert({ user_id: uid, title })',
      }),
    ).toBe(true);
  });
});
