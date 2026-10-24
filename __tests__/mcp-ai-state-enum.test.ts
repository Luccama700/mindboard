// The MCP-exposed ai_state enums vs. the canonical AI_STATES list.
//
// Migration 0052 (2026-09-09) added 'declined' and validate.ts accepted it, but
// the zod enum registered for the update_task tool was a hand-copied
// ["planned","building","built","failed"]. Every nightly life-triage
// update_task call carrying aiState:'declined' was therefore rejected with
// invalid_enum_value — and because run.mjs sends the verdict notes in the SAME
// call, the decline reason was dropped too and the task was re-triaged the next
// night. The existing mcp-validate tests only exercised validateUpdateTask, so
// they never saw it.
//
// These tests therefore go through the real zod input schemas the MCP route
// registers: `mcp-handler` is faked so route.ts's registration callback can be
// replayed against a recording server. Anything that re-hard-codes a state list
// in route.ts, or adds a state to the DB constraint without plumbing it
// through, fails here.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test, vi } from "vitest";

import {
  AGENT_AI_STATES,
  AI_STATES,
  AI_STATE_FILTERS,
  validateUpdateTask,
} from "@/app/lib/mcp/validate";

type ParsedSchema = { safeParse: (value: unknown) => { success: boolean } };
type ToolConfig = { inputSchema?: Record<string, unknown> };

const mocks = vi.hoisted(() => ({
  init: null as ((server: unknown) => void) | null,
}));

// createMcpHandler only stores the callback; replaying it ourselves is how we
// reach the per-tool inputSchema objects without standing up a transport.
vi.mock("mcp-handler", () => ({
  createMcpHandler: (init: (server: unknown) => void) => {
    mocks.init = init;
    return () => new Response("stub");
  },
  withMcpAuth: (handler: unknown) => handler,
}));

const tools = new Map<string, ToolConfig>();

beforeAll(async () => {
  await import("@/app/api/mcp/[transport]/route");
  if (!mocks.init) throw new Error("route.ts did not call createMcpHandler");
  mocks.init({
    registerTool: (name: string, config: ToolConfig) => {
      tools.set(name, config);
    },
  });
});

function aiStateSchema(tool: string): ParsedSchema {
  const config = tools.get(tool);
  if (!config) throw new Error(`${tool} is not registered on the MCP server`);
  const schema = config.inputSchema?.aiState;
  if (!schema || typeof (schema as ParsedSchema).safeParse !== "function") {
    throw new Error(`${tool} has no aiState field in its input schema`);
  }
  return schema as ParsedSchema;
}

function accepts(schema: ParsedSchema, value: unknown): boolean {
  return schema.safeParse(value).success;
}

describe("update_task's aiState schema", () => {
  test("accepts every agent-settable state, including 'declined'", () => {
    const schema = aiStateSchema("update_task");
    for (const state of AGENT_AI_STATES) {
      expect(accepts(schema, state), `update_task should accept ${state}`).toBe(true);
    }
    // The regression itself, spelled out so a reader sees the bug.
    expect(accepts(schema, "declined")).toBe(true);
  });

  test("still refuses 'approved' — the user-only approval gate", () => {
    const schema = aiStateSchema("update_task");
    expect(accepts(schema, "approved")).toBe(false);
    expect(AGENT_AI_STATES).not.toContain("approved");
  });

  test("the exposed enum is AI_STATES minus the deliberate 'approved' exclusion", () => {
    const schema = aiStateSchema("update_task");
    const exposed = AI_STATES.filter((state) => accepts(schema, state));
    expect([...exposed]).toEqual(AI_STATES.filter((state) => state !== "approved"));
  });

  test("null clears the state; junk is rejected", () => {
    const schema = aiStateSchema("update_task");
    expect(accepts(schema, null)).toBe(true);
    expect(accepts(schema, undefined)).toBe(true);
    expect(accepts(schema, "shipped")).toBe(false);
    expect(accepts(schema, "")).toBe(false);
  });

  test("the schema and validateUpdateTask agree on every state", () => {
    const schema = aiStateSchema("update_task");
    for (const state of AI_STATES) {
      expect(
        accepts(schema, state),
        `schema and validator disagree on ${state}`,
      ).toBe(validateUpdateTask({ taskId: "t1", aiState: state }).ok);
    }
  });
});

describe("list_code_tasks' aiState filter", () => {
  test("can filter on every lifecycle state plus 'none'", () => {
    const schema = aiStateSchema("list_code_tasks");
    for (const value of AI_STATE_FILTERS) {
      expect(accepts(schema, value), `filter should accept ${value}`).toBe(true);
    }
    // 'declined' tasks were invisible to the agent's own feed too.
    expect(accepts(schema, "declined")).toBe(true);
    expect(accepts(schema, "shipped")).toBe(false);
  });

  test("exposes exactly 'none' plus the canonical states", () => {
    const schema = aiStateSchema("list_code_tasks");
    const exposed = ["none", ...AI_STATES, "shipped"].filter((value) =>
      accepts(schema, value),
    );
    expect(exposed).toEqual(["none", ...AI_STATES]);
  });

  test("the tool description names the states it accepts", () => {
    const description = (tools.get("list_code_tasks") as { description?: string })
      .description;
    for (const state of AI_STATES) {
      expect(description, `description should mention ${state}`).toContain(state);
    }
  });
});

describe("AI_STATES vs. the tasks_ai_state_check constraint", () => {
  // The constraint is the real gate: a state the app allows but Postgres
  // rejects fails at write time, which is how this defect class hides.
  const migrationsDir = join(import.meta.dirname, "..", "supabase", "migrations");

  test("matches the latest migration that defines ai_state", () => {
    const candidates = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => ({ name, sql: readFileSync(join(migrationsDir, name), "utf8") }))
      .filter(({ sql }) => /ai_state\s+in\s*\(/i.test(sql));

    expect(candidates.length, "no migration defines an ai_state check").toBeGreaterThan(0);

    const latest = candidates[candidates.length - 1];
    const list = /ai_state\s+in\s*\(([^)]*)\)/i.exec(latest.sql)?.[1] ?? "";
    const constraintStates = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

    expect(constraintStates.length, `could not parse states out of ${latest.name}`)
      .toBeGreaterThan(0);
    expect([...constraintStates].sort()).toEqual([...AI_STATES].sort());
  });
});
