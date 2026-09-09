# Task Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the day/home stream, dispatch any open task to the home worker with a one-shot note; the worker runs it as a full-power headless session and writes the result back into the task notes.

**Architecture:** A new `task_dispatches` table is the queue (and future chat-thread root); the existing `agent_run_requested_at` stamp stays the cheap wake-up signal. A session-authed server action inserts the dispatch, appends an `## Operator note` to the task, marks it approved, and stamps the run request. Two new fenced MCP tools (`claim_task_dispatch`, `update_task_dispatch`) let `run.mjs` claim and report. `run.mjs` gains a targeted dispatch phase (Track C: full-power executor) entered from the poll or directly via `--task <id>`.

**Tech Stack:** Next 16 server actions, Supabase (RLS + service client in MCP layer), mcp-handler tools, Vitest 4 (`__tests__/*.test.ts(x)`, explicit imports), overnight harness (`run.mjs`/`lib.mjs`, plain JS `.mjs`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-31-task-dispatch-design.md`.
- **Migrations are created but NEVER applied by the agent** — flag to Lucca (house rule).
- Every MCP function takes caller `userId` as first param and filters by it (`AGENTS.md:135`).
- Server actions: `"use server"`, return `{ error: string | null }`, never throw, `revalidatePath("/", "layout")` after writes.
- `run.mjs` invariant: user text never goes into argv — prompts via stdin, files via `-F` (`run.mjs:149-151`).
- Worker guardrails (verbatim in the dispatch prompt): prepares/researches/builds/drafts only — never sends, signs, purchases, publishes, or submits anything in the operator's name; no credential handling; graded coursework submission stays a human action; code work only on `ai/*` branches, never `main`.
- Gate before finishing: `npm run lint` && `npm run test` && `npm run build`.
- Commit after each task; messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Migration + shared types

**Files:**
- Create: `supabase/migrations/0042_task_dispatches.sql`
- Create: `app/lib/dispatch/types.ts`

**Interfaces:**
- Produces: table `public.task_dispatches`; type `TaskDispatch`, `DispatchStatus`, `DISPATCH_COLUMNS`.

- [ ] **Step 1: Write the migration** (mirror RLS style of `0001_init.sql` task policies)

```sql
-- 0042_task_dispatches.sql
-- One-shot "do this now" dispatches (spec: docs/superpowers/specs/2026-07-31-task-dispatch-design.md).
-- A dispatch is the queue row AND the future chat-thread root. status flow:
-- requested -> claimed -> running -> done | failed. Stale claimed/running rows
-- (>60 min) are re-claimable.
create table public.task_dispatches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  note text not null,
  status text not null default 'requested'
    check (status in ('requested','claimed','running','done','failed')),
  result_summary text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz
);

alter table public.task_dispatches enable row level security;

create policy "task_dispatches_select_own" on public.task_dispatches
  for select using (auth.uid() = user_id);
create policy "task_dispatches_insert_own" on public.task_dispatches
  for insert with check (auth.uid() = user_id);
create policy "task_dispatches_update_own" on public.task_dispatches
  for update using (auth.uid() = user_id);

create index task_dispatches_pending_idx
  on public.task_dispatches (user_id, status, created_at);
```

- [ ] **Step 2: Write the types file**

```ts
// app/lib/dispatch/types.ts
export type DispatchStatus =
  | "requested"
  | "claimed"
  | "running"
  | "done"
  | "failed";

export type TaskDispatch = {
  id: string;
  user_id: string;
  task_id: string;
  note: string;
  status: DispatchStatus;
  result_summary: string | null;
  created_at: string;
  claimed_at: string | null;
  finished_at: string | null;
};

export const DISPATCH_COLUMNS =
  "id, user_id, task_id, note, status, result_summary, created_at, claimed_at, finished_at";
```

- [ ] **Step 3: Run `npm run lint` — expect clean. Commit** (`feat: task_dispatches migration + types` — note in commit body: MIGRATION NOT APPLIED, flag to Lucca)

---

### Task 2: TypeScript `appendSection` (port of `overnight/lib.mjs:32`)

**Files:**
- Create: `app/lib/notes.ts`
- Test: `__tests__/notes-append.test.ts`

**Interfaces:**
- Produces: `appendSection(notes: string | null, heading: string, body: string, maxLen?: number): string` — identical semantics to the `.mjs` version (new section always survives; old notes trimmed to fit; `\n\n---\n\n## <heading>\n\n<body>` joiner).

- [ ] **Step 1: Write failing tests** (mirror the cases in `__tests__/overnight-lib.test.ts` for the `.mjs` version)

```ts
import { describe, it, expect } from "vitest";
import { appendSection } from "@/app/lib/notes";

describe("appendSection", () => {
  it("appends a section to existing notes", () => {
    const out = appendSection("old notes", "Operator note (2026-07-31)", "do the thing");
    expect(out).toBe("old notes\n\n---\n\n## Operator note (2026-07-31)\n\ndo the thing");
  });
  it("handles null/empty notes", () => {
    expect(appendSection(null, "H", "b")).toBe("## H\n\nb");
    expect(appendSection("  ", "H", "b")).toBe("## H\n\nb");
  });
  it("keeps the new section when over maxLen, trimming old notes", () => {
    const out = appendSection("x".repeat(200), "H", "body", 120);
    expect(out).toContain("## H\n\nbody");
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).toContain("…");
  });
  it("clips an oversized body rather than dropping it", () => {
    const out = appendSection("", "H", "y".repeat(300), 120);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.startsWith("## H")).toBe(true);
  });
});
```

- [ ] **Step 2: Run `npx vitest run __tests__/notes-append.test.ts` — expect FAIL (module not found)**
- [ ] **Step 3: Implement** — port `clip` + `appendSection` from `overnight/lib.mjs:24-45` to TS (read the `.mjs` source first; keep trimming behavior byte-identical, `maxLen = 12000` default)
- [ ] **Step 4: Run the test — expect PASS**
- [ ] **Step 5: Commit** (`feat: TS appendSection port for task notes`)

---

### Task 3: `requestTaskDispatch` server action

**Files:**
- Modify: `app/actions/tasks.ts` (append new action; follow `requestAgentRun` at `:365` and `updateTask` at `:181`)
- Test: `__tests__/tasks-dispatch-action.test.ts` (mock pattern from `__tests__/tasks-action.test.ts`)

**Interfaces:**
- Consumes: `appendSection` (Task 2), `TaskDispatch` (Task 1).
- Produces: `requestTaskDispatch(input: { taskId: string; note: string }): Promise<{ error: string | null; dispatchId?: string }>`.

- [ ] **Step 1: Write failing tests** — cases: not authenticated → error; non-owner account (`ownerUserId()` mismatch) → `"no agent PC serves this account"`; empty note → error `"note required"`; happy path performs, in order: (a) insert into `task_dispatches` with `{ user_id, task_id, note, status: "requested" }`, (b) task update setting `notes` = appendSection(existing, `Operator note (<YYYY-MM-DD>)`, note) and `ai_state` = `"approved"`, (c) `user_settings` upsert stamping `agent_run_requested_at`, (d) returns `dispatchId`.
- [ ] **Step 2: Run — expect FAIL (action not exported)**
- [ ] **Step 3: Implement**

```ts
export async function requestTaskDispatch(input: {
  taskId: string;
  note: string;
}): Promise<{ error: string | null; dispatchId?: string }> {
  const note = input.note?.trim();
  if (!note) return { error: "note required" };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };
  try {
    const { ownerUserId } = await import("@/app/lib/mcp/config");
    if (ownerUserId() !== user.id)
      return { error: "no agent PC serves this account" };
  } catch {
    return { error: "no agent PC serves this account" };
  }
  const { data: task, error: taskErr } = await supabase
    .from("tasks")
    .select("id, notes")
    .eq("id", input.taskId)
    .single();
  if (taskErr || !task) return { error: "task not found" };

  const { data: dispatch, error: insErr } = await supabase
    .from("task_dispatches")
    .insert({ user_id: user.id, task_id: task.id, note, status: "requested" })
    .select("id")
    .single();
  if (insErr || !dispatch) return { error: "could not create dispatch" };

  const today = new Date().toISOString().slice(0, 10);
  const { error: updErr } = await supabase
    .from("tasks")
    .update({
      notes: appendSection(task.notes, `Operator note (${today})`, note),
      ai_state: "approved",
    })
    .eq("id", task.id);
  if (updErr) return { error: "could not update task" };

  await supabase.from("user_settings").upsert(
    { user_id: user.id, agent_run_requested_at: new Date().toISOString() },
    { onConflict: "user_id" },
  );
  revalidatePath("/", "layout");
  return { error: null, dispatchId: dispatch.id };
}
```

- [ ] **Step 4: Run tests — expect PASS. Run `npm run lint`.**
- [ ] **Step 5: Commit** (`feat: requestTaskDispatch server action`)

---

### Task 4: MCP tools `claim_task_dispatch` + `update_task_dispatch`

**Files:**
- Modify: `app/lib/mcp/writes.ts` (append near `claimAgentRun` at `:2826`)
- Modify: `app/api/mcp/[transport]/route.ts` (register after `claim_agent_run` at `:1334-1347`)
- Test: `__tests__/mcp-dispatch.test.ts`

**Interfaces:**
- Consumes: `TaskDispatch`, `DISPATCH_COLUMNS` (Task 1), `createServiceClient`, `Result<T>` pattern.
- Produces:
  - `claimTaskDispatch(userId: string, taskId?: string): Promise<Result<{ dispatch: (TaskDispatch & { task_title: string }) | null }>>` — atomically claims the oldest `requested` dispatch (optionally filtered to `taskId`), also reclaiming `claimed`/`running` rows whose `claimed_at` is older than 60 min. Sets `status='claimed'`, `claimed_at=now()`. After claiming, fetches `tasks.title` for the claimed row and returns it as `task_title` (worker prompt needs it).
  - `updateTaskDispatch(userId: string, input: { dispatchId: string; status: "running" | "done" | "failed"; resultSummary?: string }): Promise<Result<{ ok: true }>>` — status transition + `result_summary`, `finished_at` on done/failed.
- Both are **fenced direct writes** (comment them as such, like `writes.ts:2822-2825`) — no propose→confirm, no audit row, always filtered by `user_id`.

- [ ] **Step 1: Write failing tests** — claim returns null when empty; claim picks oldest requested; claim with `taskId` filters; stale `claimed` row (claimed_at 61 min ago) is reclaimable; fresh `claimed` row is not; `updateTaskDispatch` sets `finished_at` for done/failed but not running; both reject rows of another `user_id`. Mock the service client per existing `writes` test patterns.
- [ ] **Step 2: Run — FAIL. Step 3: Implement** (claim = `update ... set status='claimed', claimed_at=now() where id = (select id ... where user_id = $1 and (status='requested' or (status in ('claimed','running') and claimed_at < now() - interval '60 minutes')) [and task_id = $2] order by created_at limit 1) returning <DISPATCH_COLUMNS>` — via supabase: select candidate id first, then conditional update guarded on prior status+claimed_at, retry once on conflict).
- [ ] **Step 4: Register both tools in `route.ts`** — zod input schemas (`claim_task_dispatch`: `{ taskId?: string (uuid) }`; `update_task_dispatch`: `{ dispatchId: uuid, status: enum, resultSummary?: string max 4000 }`), handlers call `uid(extra)` then guard, mirroring `:1334-1347`.
- [ ] **Step 5: Run tests + `npm run lint` — PASS. Commit** (`feat: claim/update task dispatch MCP tools`)

---

### Task 5: Stream UI — `✦ do it` button, dispatch sheet, badge

**Files:**
- Create: `app/_components/dispatch-sheet.tsx`
- Modify: `app/_components/stream-client.tsx` (task actions branch `:171-317`; sheets mount `:1051-1060`; add `agentServiced` prop)
- Modify: `app/page.tsx` (compute `agentServiced` like `app/tasks/page.tsx:89-94`, thread through `StreamSection` → `StreamClient`)
- Test: `__tests__/dispatch-sheet.test.tsx`

**Interfaces:**
- Consumes: `requestTaskDispatch` (Task 3), `Sheet` (`app/_components/stream-sheets.tsx:9`), `AI_BADGE` map semantics (`app/_components/task-row.tsx:11-17`).
- Produces: `<DispatchSheet task={{ id, title }} onClose={() => void} />`; stream task rows show `✦ do it` action (when `agentServiced` and status not done/missed) and an `ai_state` badge (`✦ plan ready` / `✦ building` / `✦ built` / `✦ failed` per `AI_BADGE`).

- [ ] **Step 1: Write failing render test** — `DispatchSheet` renders task title + textarea + send; send disabled when empty; submitting calls `requestTaskDispatch` with `{ taskId, note }` (mock the action module) and shows `✦ dispatched — the pc picks it up within ~5 min`; error path renders returned error text. Follow `__tests__/stream-client-render.test.tsx` setup (jsdom, explicit vitest imports).
- [ ] **Step 2: Run — FAIL. Step 3: Implement `DispatchSheet`** — `"use client"`, local `useState<"idle" | "sent" | "error">`, `useTransition`, textarea placeholder "anything the agent should know or do?", copy style matching `agent-run-button.tsx:23,35`.
- [ ] **Step 4: Wire the stream** — in the task actions array (after the `schedule ▾` button, `stream-client.tsx:263`): when `props.agentServiced && card.entity.kind === "task"`, push a `✦ do it` button setting `dispatchTask` state; mount `{dispatchTask && <DispatchSheet task={dispatchTask} onClose={...} />}` next to the other sheets (`:1051-1060`). Add the ai_state badge span beside `card.meta` (`:530`) reusing the `AI_BADGE` labels (import the map — export it from `task-row.tsx` if not already). Thread `agentServiced` from `app/page.tsx` (try/catch `ownerUserId()`).
- [ ] **Step 5: Run tests + `npm run lint` + `npm run build` — PASS. Commit** (`feat: dispatch sheet + do-it button on day stream`)

---

### Task 6: Worker — `--task` flag, dispatch phase, Track C executor

**Files:**
- Modify: `overnight/run.mjs` (flags `:112-113`, CONFIG `:75-110`, poll branch `:768-789`, new `dispatchPhase`)
- Modify: `overnight/lib.mjs` (add `argValue`, `dispatchPrompt`)
- Modify: `overnight/README.md` (document `--task`, `OVERNIGHT_DISPATCH_*`)
- Test: `__tests__/overnight-lib.test.ts` (extend)

**Interfaces:**
- Consumes: MCP tools from Task 4 (`claim_task_dispatch`, `update_task_dispatch`), `runClaude` (`run.mjs:169`), `appendSection`/`extractSection` (`lib.mjs`), `updateTask` propose→confirm helper (`run.mjs:231`).
- Produces:
  - `argValue(argv: string[], flag: string): string | null` (in `lib.mjs`; `["--task","123"]` → `"123"`; missing → null).
  - `dispatchPrompt(task, note, manifest): string` (in `lib.mjs`) — includes task title/notes/operator note/capabilities manifest and the verbatim guardrail block from Global Constraints.
  - CONFIG keys: `dispatchBudgetUsd` (`OVERNIGHT_DISPATCH_BUDGET_USD`, default `"10"`), `dispatchTimeoutMs` (`OVERNIGHT_DISPATCH_TIMEOUT_MIN`, default 45 min).
  - run.mjs behavior: poll (`--if-requested`) claims run request, then `claim_task_dispatch`; a returned dispatch routes to `dispatchPhase(dispatch)` (targeted, then exit) instead of the full sweep. Direct `--task <id>` claims that task's dispatch (`claim_task_dispatch { taskId }`); if none, log and exit 0.

- [ ] **Step 1: Write failing tests** for `argValue` and `dispatchPrompt` (prompt contains task title, operator note text, the string `never submit`, and the capabilities manifest marker).
- [ ] **Step 2: Run — FAIL. Step 3: Implement `argValue` + `dispatchPrompt`** in `lib.mjs` (style-match `execPrompt` at `:288`).
- [ ] **Step 4: Wire run.mjs** —

```js
// dispatchPhase(dispatch): Track C — full-power targeted executor.
async function dispatchPhase(dispatch) {
  await tool("update_task_dispatch", { dispatchId: dispatch.id, status: "running" });
  const notes = await freshNotes(dispatch.task_id, "");
  const task = { id: dispatch.task_id, title: dispatch.task_title ?? dispatch.task_id, notes };
  const manifest = readFileSync(join(HERE, "capabilities.md"), "utf8");
  const result = runClaude({
    prompt: dispatchPrompt(task, dispatch.note, manifest),
    cwd: CONFIG.workspace,
    permissionMode: "acceptEdits",
    engine: ENGINES.build,
    budgetUsd: CONFIG.dispatchBudgetUsd,
    maxTurns: 120,
    timeoutMs: CONFIG.dispatchTimeoutMs,
  });
  const today = new Date().toISOString().slice(0, 10);
  if (result.ok) {
    await updateTask(dispatch.task_id, {
      notes: appendSection(await freshNotes(dispatch.task_id, notes),
        `Agent result — ${today}`, clip(result.text, 6000)),
      aiState: "built",
    });
    await tool("update_task_dispatch", {
      dispatchId: dispatch.id, status: "done",
      resultSummary: clip(result.text, 1000),
    });
  } else {
    await updateTask(dispatch.task_id, {
      notes: appendSection(await freshNotes(dispatch.task_id, notes),
        `Agent result — failed — ${today}`,
        clip(result.text || "run failed; see overnight/logs", 2000)),
      aiState: "failed",
    });
    await tool("update_task_dispatch", {
      dispatchId: dispatch.id, status: "failed",
      resultSummary: clip(result.text || "failed", 1000),
    });
  }
}
```

Poll branch: after the existing `claim_agent_run` success, `const c = await tool("claim_task_dispatch", {}); if (c.dispatch) { await dispatchPhase(c.dispatch); return; }` — falls through to the normal sweep when no dispatch. Direct mode near the top of `main()`: `const taskId = argValue(process.argv.slice(2), "--task"); if (taskId) { ... claim with { taskId }, dispatchPhase or log "no pending dispatch", return; }`. `--dry` with `--task` prints the composed prompt and exits without claiming (the spec's dry-run integration check). No user text in argv — taskId is a uuid, validated with a regex before use.

- [ ] **Step 5: Run `npm run test` + `npm run lint` — PASS.**
- [ ] **Step 6: Manual e2e (documented, run by operator):** apply migration (Lucca), create sandbox task, dispatch "write hello.md in the agent workspace", run `node overnight/run.mjs --task <id>`, verify notes + dispatch row + file.
- [ ] **Step 7: Update `overnight/README.md` + commit** (`feat: dispatch phase + --task targeted runs`)
