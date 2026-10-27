import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  EXCLUDED_TABLES,
  EXPORT_TABLES,
  isSecretColumn,
  stripSecrets,
} from "../app/lib/account/export";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

// Every `create table public.X (...)` block in the migrations, with its
// column names. The export list is hand-written, so this is what stops a new
// table from quietly falling out of a tenant's copy of their own data.
function declaredTables(): Map<string, string[]> {
  let sql = "";
  for (const name of readdirSync(MIGRATIONS).sort()) {
    if (name.endsWith(".sql")) sql += `${readFileSync(join(MIGRATIONS, name), "utf8")}\n`;
  }
  const tables = new Map<string, string[]>();
  for (const match of sql.matchAll(/create table public\.(\w+)\s*\(([\s\S]*?)\n\);/g)) {
    const columns = [...match[2].matchAll(/^ {2}([a-z_]+)\s+/gm)]
      .map((m) => m[1])
      .filter(
        (name) =>
          !["primary", "unique", "constraint", "check", "foreign"].includes(name),
      );
    tables.set(match[1], columns);
  }
  return tables;
}

describe("EXPORT_TABLES", () => {
  const declared = declaredTables();

  test("the migrations parse into the 46 known tables", () => {
    expect(declared.size).toBe(46);
  });

  test("every declared table is exported or explicitly excluded", () => {
    const exported = new Set(EXPORT_TABLES.map((t) => t.table));
    const missing = [...declared.keys()].filter(
      (table) => !exported.has(table) && !(table in EXCLUDED_TABLES),
    );
    expect(missing).toEqual([]);
  });

  test("nothing is both exported and excluded, and nothing is invented", () => {
    for (const { table } of EXPORT_TABLES) {
      expect(declared.has(table), `${table} is not a real table`).toBe(true);
      expect(table in EXCLUDED_TABLES).toBe(false);
    }
    for (const table of Object.keys(EXCLUDED_TABLES)) {
      expect(declared.has(table), `${table} is not a real table`).toBe(true);
    }
  });

  test("no table is listed twice", () => {
    const names = EXPORT_TABLES.map((t) => t.table);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every order column exists on its table, so paging stays stable", () => {
    for (const { table, order } of EXPORT_TABLES) {
      expect(order.length).toBeGreaterThan(0);
      for (const column of order) {
        expect(declared.get(table), `${table}`).toContain(column);
      }
    }
  });

  test("google_tokens is excluded — it is credentials, not data", () => {
    expect(EXCLUDED_TABLES).toHaveProperty("google_tokens");
  });
});

describe("isSecretColumn", () => {
  test("catches every credential column the schema declares", () => {
    for (const column of [
      "access_token",
      "refresh_token",
      "github_token",
      "token_hash",
      "mcp_token_hash",
      "capture_token_hash",
      "anthropic_api_key",
      "google_ai_api_key",
      "openai_api_key",
      "session_url",
    ]) {
      expect(isSecretColumn(column), column).toBe(true);
    }
  });

  test("keeps ordinary columns", () => {
    for (const column of [
      "id",
      "user_id",
      "title",
      "notes",
      "fingerprint",
      "mcp_token_hint",
      "mcp_token_created_at",
      "repo",
      "branch",
      "balance",
      "occurred_at",
    ]) {
      expect(isSecretColumn(column), column).toBe(false);
    }
  });
});

describe("stripSecrets", () => {
  test("drops credential columns and keeps the rest", () => {
    expect(
      stripSecrets({
        user_id: "u1",
        repo: "me/vault",
        branch: "main",
        github_token: "ghp_secret",
      }),
    ).toEqual({ user_id: "u1", repo: "me/vault", branch: "main" });
  });

  test("keeps null and false values rather than dropping them", () => {
    expect(stripSecrets({ a: null, b: false, c: 0, d: "" })).toEqual({
      a: null,
      b: false,
      c: 0,
      d: "",
    });
  });

  test("a row that is all secrets becomes an empty object, never a leak", () => {
    expect(stripSecrets({ access_token: "a", refresh_token: "b" })).toEqual({});
  });
});
