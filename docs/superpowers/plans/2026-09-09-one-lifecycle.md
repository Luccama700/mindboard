# One Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Approving a plan makes the PC act within its 5-minute poll, and a task the overnight triage won't take says so in the app (`✦ not taken` + reason) with the follow-up composer already open.

**Architecture:** One new `ai_state` value, `declined`, written by the orchestrator's triage instead of a silent on-disk cache; the task edit panel reads the reason back out of the notes with a pure helper and pre-opens the follow-up composer. `setTaskAiState("approved")` reuses `requestAgentRun`'s stamp so the existing poll picks the task up. No new tables, no new executors.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, Vitest + Testing Library, Supabase Postgres, the Node orchestrator `overnight/run.mjs` + `overnight/lib.mjs` (plain ESM, unit-tested via `__tests__/overnight-lib.test.ts`).

**Spec:** `docs/superpowers/specs/2026-09-09-agent-handoff-design.md` — sub-project 2.

## Global Constraints

- Starts after the dispatch-on-main plan has merged. Branch: `git checkout -b one-lifecycle origin/main` in `/Users/luccama/Documents/mindboard`.
- No new dependencies; lowercase copy; `✦` glyph for agent affordances.
- Next free migration number is **0052**. The live check constraint is named `tasks_ai_state_check` (verified 2026-09-09).
- `approved` stays user-only: `validateUpdateTask` must keep rejecting `aiState: "approved"` from every MCP client.
- Stamping the run request stays **owner-gated** (`ownerUserId() === user.id`), never the allowlist: the poll claims it over the owner's personal MCP token.
- Gate before declaring done: `npm run lint && npm run test && npm run build` (2 pre-existing lint warnings, 0 errors). `node --check overnight/run.mjs overnight/lib.mjs` for the orchestrator.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; never force-push; never `git add -A`.

---

### Task 1: `declined` in the schema, the type, and the validator

**Files:**
- Create: `supabase/migrations/0052_ai_state_declined.sql`
- Modify: `app/_components/types.ts:11`, `app/lib/mcp/validate.ts:273`
- Test: `__tests__/mcp-validate.test.ts:289-297`

**Interfaces:**
- Produces: `Task["ai_state"]` now includes `"declined"`; `AI_STATES` includes `"declined"`; `validateUpdateTask({ aiState: "declined" })` is accepted.

- [ ] **Step 1: Extend the validator test (fails first)**

In `__tests__/mcp-validate.test.ts`, inside the test `"aiState: agent states pass, 'approved' is user-only, junk rejected"`, after the `aiState: "built"` expectation add:

```ts
    expect(validateUpdateTask({ taskId: "t1", aiState: "declined" }).ok).toBe(true);
```

Run: `npx vitest run __tests__/mcp-validate.test.ts 2>&1 | grep -E "×|✓ .*aiState|Tests  "`
Expected: that test fails ("expected false to be true").

- [ ] **Step 2: Widen `AI_STATES` and the type**

`app/lib/mcp/validate.ts` line 273:

```ts
export const AI_STATES = ["planned", "approved", "building", "built", "failed", "declined"] as const;
```

`app/_components/types.ts` line 11:

```ts
  ai_state: "planned" | "approved" | "building" | "built" | "failed" | "declined" | null;
```

- [ ] **Step 3: Run the validator test**

Run: `npx vitest run __tests__/mcp-validate.test.ts 2>&1 | grep -E "Tests  |FAIL"`
Expected: all pass (the `approved` rejection case in the same test still holds).

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/0052_ai_state_declined.sql`:

```sql
-- 'declined': the overnight triage judged the task infeasible for the agent
-- (docs/superpowers/specs/2026-09-09-agent-handoff-design.md). The reason
-- lands in tasks.notes under "## AI triage — <date>"; the app shows
-- ✦ not taken and pre-opens ✦ follow up. Clearing the badge (ai_state back
-- to null) re-triages on the next run — the DB state replaces the old
-- overnight/state.json infeasible cache as the skip signal.
alter table public.tasks drop constraint tasks_ai_state_check;
alter table public.tasks add constraint tasks_ai_state_check check (
  ai_state in ('planned', 'approved', 'building', 'built', 'failed', 'declined')
);
```

- [ ] **Step 5: Type-check and commit**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v "^__tests__/inventory-ops\|^__tests__/quick-note\|^  "`
Expected: no output. (`AI_BADGE` in `task-row.tsx` is `Record<NonNullable<Task["ai_state"]>, …>`, so `tsc` will complain there until Task 3 — if it does, note it and continue; Task 3 fixes it. If you prefer green at every commit, add `declined: { label: "✦ not taken", tone: "text-muted" },` to `AI_BADGE` now and keep it in Task 3.)

```bash
git add supabase/migrations/0052_ai_state_declined.sql app/_components/types.ts app/lib/mcp/validate.ts __tests__/mcp-validate.test.ts
git commit -m "db: tasks.ai_state gains 'declined' (migration 0052) + type/validator

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `latestSection` / `firstLine` note helpers

**Files:**
- Create: `app/_components/notes-sections.ts`
- Test: `__tests__/notes-sections.test.ts`

**Interfaces:**
- Produces: `latestSection(notes: string | null | undefined, heading: string): string | null` — body of the LAST `## <heading>…` section (heading prefix match, so `## AI triage — 2026-09-09` matches `"AI triage"`), stopping at the next `## ` heading or a `---` rule; `firstLine(text: string | null | undefined, max = 140): string | null` — first non-empty line, clipped with `…`.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/notes-sections.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { firstLine, latestSection } from "@/app/_components/notes-sections";

const NOTES = [
  "call the landlord about the lease",
  "",
  "---",
  "",
  "## AI approach — 2026-09-01",
  "",
  "draft the email for you",
  "",
  "---",
  "",
  "## AI triage — 2026-09-09",
  "",
  "needs a phone call, which I can't make",
  "",
  "*✦ follow up or ✦ do it if you want the PC to try anyway.*",
].join("\n");

describe("latestSection", () => {
  it("returns the body of the last section whose heading starts with the name", () => {
    expect(latestSection(NOTES, "AI triage")).toBe(
      "needs a phone call, which I can't make\n\n*✦ follow up or ✦ do it if you want the PC to try anyway.*",
    );
  });

  it("matches the heading prefix, ignoring the date suffix", () => {
    expect(latestSection(NOTES, "AI approach")).toBe("draft the email for you");
  });

  it("picks the LAST matching section when there are several", () => {
    const twice = `${NOTES}\n\n---\n\n## AI triage — 2026-09-10\n\nstill a phone call`;
    expect(latestSection(twice, "AI triage")).toBe("still a phone call");
  });

  it("returns null when the section is absent or the notes are empty", () => {
    expect(latestSection(NOTES, "AI result")).toBeNull();
    expect(latestSection(null, "AI triage")).toBeNull();
    expect(latestSection("", "AI triage")).toBeNull();
  });
});

describe("firstLine", () => {
  it("returns the first non-empty line, clipped with an ellipsis", () => {
    expect(firstLine("needs a phone call\n\nmore")).toBe("needs a phone call");
    expect(firstLine("x".repeat(200), 20)).toBe(`${"x".repeat(19)}…`);
    expect(firstLine(null)).toBeNull();
    expect(firstLine("   ")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run __tests__/notes-sections.test.ts 2>&1 | grep -E "Failed to resolve|Tests  "`
Expected: fails with "Failed to resolve import".

- [ ] **Step 3: Implement**

Create `app/_components/notes-sections.ts`:

```ts
// Read-side helpers for the "## Heading — <date>" sections the overnight
// agent appends to task notes (appendSection in overnight/lib.mjs separates
// sections with a "---" rule). Pure; used by the task edit panel to surface
// the latest triage reason without parsing markdown.

export function latestSection(
  notes: string | null | undefined,
  heading: string,
): string | null {
  if (!notes) return null;
  const lines = notes.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("## ") && line.slice(3).trim().startsWith(heading)) {
      start = i;
    }
  }
  if (start === -1) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("## ") || trimmed === "---") break;
    body.push(line);
  }
  const text = body.join("\n").trim();
  return text.length > 0 ? text : null;
}

export function firstLine(
  text: string | null | undefined,
  max = 140,
): string | null {
  if (!text) return null;
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run __tests__/notes-sections.test.ts 2>&1 | grep -E "Tests  |FAIL"`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add app/_components/notes-sections.ts __tests__/notes-sections.test.ts
git commit -m "notes: latestSection/firstLine helpers for agent-written sections

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `✦ not taken` in the task edit panel

**Files:**
- Create: `__tests__/task-row-declined.test.tsx`
- Modify: `app/_components/task-row.tsx` (imports; `AI_BADGE` near line 15; `EditPanel` state near line 263; the badge block near line 632; the follow-up textarea placeholder near line 600)

**Interfaces:**
- Consumes: `latestSection`, `firstLine` (Task 2); `setTaskAiState(id, null)` (existing).
- Produces: `AI_BADGE.declined = { label: "✦ not taken", tone: "text-muted" }` (the stream card imports `AI_BADGE`, so cards get the badge for free).

- [ ] **Step 1: Write the failing test**

Create `__tests__/task-row-declined.test.tsx`:

```tsx
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  setTaskAiState: vi.fn(async () => ({ error: null, stamped: false, stampError: null })),
}));

vi.mock("@/app/actions/tasks", () => ({
  pushTaskToCalendar: vi.fn(),
  queueTaskFollowup: vi.fn(),
  requestTaskDispatch: vi.fn(),
  setTaskAiState: mocks.setTaskAiState,
}));

import { TaskRow } from "@/app/_components/task-row";
import type { Task } from "@/app/_components/types";

const DECLINED_NOTES = [
  "ask the landlord about the lease",
  "",
  "---",
  "",
  "## AI triage — 2026-09-09",
  "",
  "needs a phone call, which I can't make",
  "",
  "*✦ follow up or ✦ do it if you want the PC to try anyway.*",
].join("\n");

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    group_id: null,
    title: "lease renewal",
    due_date: null,
    due_time: null,
    status: "todo",
    priority: "med",
    notes: null,
    estimated_minutes: null,
    ai_state: null,
    created_at: "2026-09-01T00:00:00.000Z",
    completed_at: null,
    missed_at: null,
    ...overrides,
  } as Task;
}

function renderOpenRow(t: Task) {
  return render(
    <TaskRow
      task={t}
      today="2026-09-09"
      groups={[]}
      onToggle={() => {}}
      onDelete={() => {}}
      onUpdate={() => {}}
      open
    />,
  );
}

afterEach(() => {
  cleanup();
  mocks.setTaskAiState.mockClear();
});

describe("a declined task", () => {
  test("shows ✦ not taken with the triage reason and the follow-up box already open", () => {
    renderOpenRow(task({ ai_state: "declined", notes: DECLINED_NOTES }));
    expect(screen.getByText("✦ not taken")).toBeTruthy();
    expect(screen.getByText("needs a phone call, which I can't make")).toBeTruthy();
    expect(screen.getByLabelText("follow-up instruction")).toBeTruthy();
    expect(screen.getByRole("button", { name: "✦ do it" })).toBeTruthy();
  });

  test("falls back to 'see the notes' when no triage section exists", () => {
    renderOpenRow(task({ ai_state: "declined", notes: "plain notes" }));
    expect(screen.getByText("see the notes")).toBeTruthy();
  });

  test("clear sends the state back to null", () => {
    renderOpenRow(task({ ai_state: "declined", notes: DECLINED_NOTES }));
    fireEvent.click(screen.getByRole("button", { name: "clear" }));
    expect(mocks.setTaskAiState).toHaveBeenCalledWith("t1", null);
  });
});

describe("a planned task", () => {
  test("does not pre-open the follow-up box", () => {
    renderOpenRow(task({ ai_state: "planned", notes: "## AI plan — 2026-09-09\n\ndo x" }));
    expect(screen.queryByLabelText("follow-up instruction")).toBeNull();
    expect(screen.getByText("✦ plan ready")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run __tests__/task-row-declined.test.tsx 2>&1 | grep -E "×|✓|Tests  "`
Expected: the three "declined" tests fail (no `✦ not taken` text); the "planned" test passes.

- [ ] **Step 3: Implement**

In `app/_components/task-row.tsx`:

Import after the `formatDue` import:

```ts
import { firstLine, latestSection } from "./notes-sections";
```

`AI_BADGE` gains a row after `failed`:

```ts
  declined: { label: "✦ not taken", tone: "text-muted" },
```

In `EditPanel`, change the composer's initial state and derive the reason (replace `const [followupOpen, setFollowupOpen] = useState(false);`):

```ts
  // A declined task opens with the follow-up composer ready: the triage said
  // no, and follow-up is the fallback the spec names for exactly that.
  const [followupOpen, setFollowupOpen] = useState(task.ai_state === "declined");
```

After `const canFollowup = …;` add:

```ts
  const declineReason =
    aiState === "declined"
      ? (firstLine(latestSection(notesDraft, "AI triage")) ?? "see the notes")
      : null;
```

In the badge block, after the `{aiState === "failed" && ( … )}` branch and before the `{(aiState === "built" || …` branch, add:

```tsx
          {aiState === "declined" && (
            <>
              <span className="text-[10px] text-muted normal-case tracking-normal">
                {declineReason}
              </span>
              <button
                type="button"
                disabled={aiPending}
                onClick={() => changeAiState(null)}
                className="text-[10px] tracking-widest uppercase px-2.5 py-1.5 border rounded-full border-line-strong text-muted hover:border-fg hover:text-fg transition-colors disabled:opacity-50"
              >
                clear
              </button>
            </>
          )}
```

Change the follow-up textarea `placeholder` to:

```tsx
                placeholder={
                  aiState === "declined"
                    ? "tell the pc what to look into instead — it adds one follow-up task here, same group, same due date."
                    : "what should claude look into? it adds one follow-up task here, same group, same due date."
                }
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run __tests__/task-row-declined.test.tsx __tests__/task-row-dispatch.test.tsx __tests__/timezone-write-paths.test.tsx 2>&1 | grep -E "Test Files|Tests  |FAIL"`
Expected: 3 files passed.

- [ ] **Step 5: Commit**

```bash
git add __tests__/task-row-declined.test.tsx app/_components/task-row.tsx
git commit -m "tasks: ✦ not taken — declined tasks show the triage reason and pre-open ✦ follow up

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Approve stamps the run request

**Files:**
- Create: `__tests__/tasks-ai-state-action.test.ts`, `__tests__/task-row-approve.test.tsx`
- Modify: `app/actions/tasks.ts` (`setTaskAiState` near line 337, `requestAgentRun` near line 392), `app/_components/task-row.tsx` (`changeAiState` near line 317 and the badge row)

**Interfaces:**
- Produces: `setTaskAiState(id, state): Promise<{ error: string | null; stamped: boolean; stampError: string | null }>`; module-private `servesAgentRuns(userId): Promise<boolean>` and `stampAgentRun(supabase, userId): Promise<string | null>` (returns the upsert error message or null).

- [ ] **Step 1: Write the failing action test**

Create `__tests__/tasks-ai-state-action.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authGetUser: vi.fn(),
  from: vi.fn(),
  revalidatePath: vi.fn(),
  ownerUserId: vi.fn(),
}));

vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.authGetUser },
    from: mocks.from,
  })),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/utils/google/calendar", () => ({ createEvent: vi.fn(), updateEvent: vi.fn() }));
vi.mock("@/app/lib/data/settings", () => ({
  getUserPreferences: vi.fn(async () => ({ timezone: "UTC" })),
}));
vi.mock("@/app/lib/mcp/config", () => ({
  ownerUserId: mocks.ownerUserId,
  workerAllowedUserIds: vi.fn(() => []),
}));
vi.mock("@/app/lib/watch/followup", () => ({ queueFollowupFromWatch: vi.fn() }));

import { setTaskAiState } from "@/app/actions/tasks";

type Rec = {
  taskUpdate: Record<string, unknown> | null;
  settingsUpsert: Record<string, unknown> | null;
};

function mockTables(upsertError: { message: string } | null = null): Rec {
  const rec: Rec = { taskUpdate: null, settingsUpsert: null };
  mocks.from.mockImplementation((table: string) => {
    if (table === "tasks") {
      return {
        update: vi.fn((patch: Record<string, unknown>) => {
          rec.taskUpdate = patch;
          return { eq: vi.fn(async () => ({ error: null })) };
        }),
      };
    }
    if (table === "user_settings") {
      return {
        upsert: vi.fn(async (row: Record<string, unknown>) => {
          rec.settingsUpsert = row;
          return { error: upsertError };
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
  return rec;
}

beforeEach(() => {
  mocks.authGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
});
afterEach(() => vi.clearAllMocks());

describe("setTaskAiState", () => {
  test("approving as the owner stamps the run request", async () => {
    mocks.ownerUserId.mockReturnValue("user-1");
    const rec = mockTables();
    const result = await setTaskAiState("t1", "approved");
    expect(result).toEqual({ error: null, stamped: true, stampError: null });
    expect(rec.taskUpdate).toEqual({ ai_state: "approved" });
    expect(rec.settingsUpsert?.user_id).toBe("user-1");
    expect(typeof rec.settingsUpsert?.agent_run_requested_at).toBe("string");
  });

  test("approving as someone else changes the state but does not stamp", async () => {
    mocks.ownerUserId.mockReturnValue("owner");
    const rec = mockTables();
    const result = await setTaskAiState("t1", "approved");
    expect(result).toEqual({ error: null, stamped: false, stampError: null });
    expect(rec.taskUpdate).toEqual({ ai_state: "approved" });
    expect(rec.settingsUpsert).toBeNull();
  });

  test("a failed stamp still lands the state and reports the error", async () => {
    mocks.ownerUserId.mockReturnValue("user-1");
    const rec = mockTables({ message: "boom" });
    const result = await setTaskAiState("t1", "approved");
    expect(result).toEqual({ error: null, stamped: false, stampError: "boom" });
    expect(rec.taskUpdate).toEqual({ ai_state: "approved" });
  });

  test("other states never stamp", async () => {
    mocks.ownerUserId.mockReturnValue("user-1");
    const rec = mockTables();
    await setTaskAiState("t1", "planned");
    await setTaskAiState("t1", null);
    expect(rec.settingsUpsert).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run __tests__/tasks-ai-state-action.test.ts 2>&1 | grep -E "×|✓|Tests  "`
Expected: the first three fail (the result has no `stamped` key); the last passes.

- [ ] **Step 3: Implement the helpers and the action**

In `app/actions/tasks.ts`, add above `setTaskAiState` (the file already imports `SupabaseClient`? If not, add `import type { SupabaseClient } from "@supabase/supabase-js";` at the top):

```ts
// The PC's poll (run.mjs --if-requested) claims agent_run_requested_at over
// the OWNER's personal MCP token, which is user-scoped — so only the owner's
// stamp is ever picked up. Same gate as the stream's ✦ do it.
async function servesAgentRuns(userId: string): Promise<boolean> {
  try {
    const { ownerUserId } = await import("@/app/lib/mcp/config");
    return ownerUserId() === userId;
  } catch {
    return false;
  }
}

// Returns the upsert error message, or null when the stamp landed.
async function stampAgentRun(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { error } = await supabase.from("user_settings").upsert(
    { user_id: userId, agent_run_requested_at: new Date().toISOString() },
    { onConflict: "user_id" },
  );
  return error ? error.message : null;
}
```

Replace the body of `setTaskAiState` after the `update … eq` call:

```ts
  if (error) return { error: error.message, stamped: false, stampError: null };

  // Approve means "act on it now": stamp the run request so the 5-minute poll
  // runs a sweep (docs/superpowers/specs/2026-09-09-agent-handoff-design.md).
  // Best-effort — the state change above already landed.
  let stamped = false;
  let stampError: string | null = null;
  if (state === "approved" && (await servesAgentRuns(user.id))) {
    stampError = await stampAgentRun(supabase, user.id);
    stamped = stampError === null;
  }

  revalidatePath("/", "layout");
  return { error: null, stamped, stampError };
```

and change its return type to `Promise<{ error: string | null; stamped: boolean; stampError: string | null }>`.

Refactor `requestAgentRun` to reuse both helpers (behavior unchanged apart from one error message):

```ts
export async function requestAgentRun() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };
  if (!(await servesAgentRuns(user.id))) {
    return { error: "no agent PC serves this account" };
  }
  const stampError = await stampAgentRun(supabase, user.id);
  return { error: stampError };
}
```

- [ ] **Step 4: Run the action test**

Run: `npx vitest run __tests__/tasks-ai-state-action.test.ts 2>&1 | grep -E "Tests  |FAIL"`
Expected: 4 passed.

- [ ] **Step 5: Write the failing panel test**

Create `__tests__/task-row-approve.test.tsx`:

```tsx
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ setTaskAiState: vi.fn() }));

vi.mock("@/app/actions/tasks", () => ({
  pushTaskToCalendar: vi.fn(),
  queueTaskFollowup: vi.fn(),
  requestTaskDispatch: vi.fn(),
  setTaskAiState: mocks.setTaskAiState,
}));

import { TaskRow } from "@/app/_components/task-row";
import type { Task } from "@/app/_components/types";

function planned(): Task {
  return {
    id: "t1",
    group_id: null,
    title: "ship the thing",
    due_date: null,
    due_time: null,
    status: "todo",
    priority: "med",
    notes: "## AI plan — 2026-09-09\n\ndo x then y",
    estimated_minutes: null,
    ai_state: "planned",
    created_at: "2026-09-01T00:00:00.000Z",
    completed_at: null,
    missed_at: null,
  } as Task;
}

function renderOpenRow(t: Task) {
  return render(
    <TaskRow task={t} today="2026-09-09" groups={[]} onToggle={() => {}} onDelete={() => {}} onUpdate={() => {}} open />,
  );
}

afterEach(() => {
  cleanup();
  mocks.setTaskAiState.mockReset();
});

describe("approving a plan", () => {
  test("says the pc picks it up when the stamp landed", async () => {
    mocks.setTaskAiState.mockResolvedValue({ error: null, stamped: true, stampError: null });
    renderOpenRow(planned());
    fireEvent.click(screen.getByRole("button", { name: "approve" }));
    await waitFor(() => expect(screen.getByText("✦ queued")).toBeTruthy());
    expect(screen.getByText("the pc picks it up within ~5 min")).toBeTruthy();
  });

  test("says 4am when there is no pc for this account", async () => {
    mocks.setTaskAiState.mockResolvedValue({ error: null, stamped: false, stampError: null });
    renderOpenRow(planned());
    fireEvent.click(screen.getByRole("button", { name: "approve" }));
    await waitFor(() => expect(screen.getByText("queued for the 4am run")).toBeTruthy());
  });

  test("says it couldn't wake the pc when the stamp failed", async () => {
    mocks.setTaskAiState.mockResolvedValue({ error: null, stamped: false, stampError: "boom" });
    renderOpenRow(planned());
    fireEvent.click(screen.getByRole("button", { name: "approve" }));
    await waitFor(() => expect(screen.getByText("couldn't wake the pc — it runs at 4am")).toBeTruthy());
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run __tests__/task-row-approve.test.tsx 2>&1 | grep -E "×|✓|Tests  "`
Expected: all three fail (no note text rendered).

- [ ] **Step 7: Show the note in the panel**

In `EditPanel` (`app/_components/task-row.tsx`), add state after `const [aiPending, startAi] = useTransition();`:

```ts
  const [aiNote, setAiNote] = useState<string | null>(null);
```

Replace `changeAiState`:

```ts
  function changeAiState(next: "approved" | "planned" | null) {
    startAi(async () => {
      const result = await setTaskAiState(task.id, next);
      if (result.error) return;
      setAiState(next);
      setAiNote(
        next !== "approved"
          ? null
          : result.stamped
            ? "the pc picks it up within ~5 min"
            : result.stampError
              ? "couldn't wake the pc — it runs at 4am"
              : "queued for the 4am run",
      );
    });
  }
```

In the badge block, right after the `AI_BADGE[aiState].label` `</span>`, add:

```tsx
          {aiNote && <span className="text-[10px] text-muted">{aiNote}</span>}
```

- [ ] **Step 8: Run all the row tests**

Run: `npx vitest run __tests__/task-row-approve.test.tsx __tests__/task-row-declined.test.tsx __tests__/task-row-dispatch.test.tsx __tests__/timezone-write-paths.test.tsx __tests__/tasks-ai-state-action.test.ts 2>&1 | grep -E "Test Files|Tests  |FAIL"`
Expected: 5 files passed.

- [ ] **Step 9: Commit**

```bash
git add app/actions/tasks.ts app/_components/task-row.tsx __tests__/tasks-ai-state-action.test.ts __tests__/task-row-approve.test.tsx
git commit -m "tasks: approving a plan stamps the agent run so the poll acts within 5 min

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Orchestrator writes `declined` instead of caching silently

**Files:**
- Modify: `overnight/lib.mjs` (new export), `overnight/run.mjs` (`triagePhase` near line 596; `nightReport` near line 732; the `./lib.mjs` import list at the top)
- Test: `__tests__/overnight-lib.test.ts`

**Interfaces:**
- Produces: `declineNote(reason: string): string` in `overnight/lib.mjs`.

- [ ] **Step 1: Write the failing test**

In `__tests__/overnight-lib.test.ts`, add `declineNote` to the import list from `"../overnight/lib.mjs"` (match the existing relative path in that file) and append:

```ts
test("declineNote: reason first, then the follow-up nudge; empty reason gets a default", () => {
  const note = declineNote("needs a phone call");
  expect(note.startsWith("needs a phone call\n\n")).toBe(true);
  expect(note).toContain("✦ follow up or ✦ do it");
  expect(declineNote("").startsWith("not something I can take on from here")).toBe(true);
  expect(declineNote(" ".repeat(5) + "x".repeat(400)).length).toBeLessThan(400);
});
```

Run: `npx vitest run __tests__/overnight-lib.test.ts 2>&1 | grep -E "declineNote|Tests  "`
Expected: fails ("declineNote is not a function" or an import error).

- [ ] **Step 2: Implement `declineNote`**

Append to `overnight/lib.mjs`:

```js
// What the triage writes under "## AI triage — <date>" when it declines a
// task. First line is the reason (the app shows it beside ✦ not taken); the
// nudge names the two fallbacks the spec gives the user.
export function declineNote(reason) {
  const line = clip((reason ?? "").trim() || "not something I can take on from here", 300);
  return `${line}\n\n*✦ follow up or ✦ do it if you want the PC to try anyway.*`;
}
```

Run: `npx vitest run __tests__/overnight-lib.test.ts 2>&1 | grep -E "Tests  |FAIL"`
Expected: all pass.

- [ ] **Step 3: Write the state from `triagePhase`**

In `overnight/run.mjs`, add `declineNote` to the `./lib.mjs` import list. In `triagePhase`, replace:

```js
      if (!verdict.feasible) {
        state.infeasible[task.id] = { title: task.title, reason: verdict.reason ?? "", at: today };
        continue;
      }
```

with:

```js
      if (!verdict.feasible) {
        // The task itself carries the verdict now (ai_state 'declined' +
        // the reason in the notes) so the app can show ✦ not taken and offer
        // ✦ follow up. pickLifeTasks skips any non-null ai_state, so clearing
        // the badge in the app re-triages next run. state.infeasible is no
        // longer written; it is still read for rows declined before 0052.
        const reason = (verdict.reason ?? "").trim();
        const base = await freshNotes(task.id, task.notes);
        await updateTask(task.id, {
          notes: appendSection(base, `AI triage — ${today}`, declineNote(reason)),
          aiState: "declined",
        });
        log(`  declined: "${task.title}" — ${clip(reason || "no reason given", 120)}`);
        outcomes.push({ task, ok: true, declined: true, reason });
        continue;
      }
```

Update the comment above `triagePhase` ("infeasible ones are cached locally and left alone") to "infeasible ones are marked declined on the task with the reason in the notes".

- [ ] **Step 4: Report declines separately**

In `nightReport`, replace the `lifeProposed` line:

```js
    ...lifeProposed.map((o) =>
      o.declined
        ? `- declined: ${o.task.title} — ${clip(o.reason || "no reason given", 80)}`
        : `- approach ${o.ok ? "proposed" : "FAILED"}: ${o.task.title}`,
    ),
```

- [ ] **Step 5: Syntax-check and commit**

Run: `node --check overnight/run.mjs && node --check overnight/lib.mjs && echo ok`
Expected: `ok`

```bash
git add overnight/lib.mjs overnight/run.mjs __tests__/overnight-lib.test.ts
git commit -m "overnight: triage marks infeasible tasks declined with the reason in the notes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: What's-new and docs

**Files:**
- Modify: `app/_components/onboarding/whats-new.ts` (head of `NEWS`), `AGENTS.md` (after the "Agent hand-off" paragraph added by the dispatch plan), `overnight/README.md` (Track B bullets near the top)

- [ ] **Step 1: What's-new entry at the top of `NEWS`**

```ts
  {
    id: "2026-09-09-not-taken",
    date: "2026-09-09",
    title: "approve means now, and a straight answer when i can't",
    items: [
      "approving a plan wakes the pc: it picks the task up within about five minutes instead of waiting for 4am. the badge walks ✦ queued → ✦ working… → ✦ done.",
      "when overnight triage decides a task isn't something it can take on, the task now says so — ✦ not taken, with the reason — and the ✦ follow up box is already open so you can tell the pc what to look into instead. clear the badge and it gets a fresh look next run.",
    ],
  },
```

- [ ] **Step 2: AGENTS.md**

Directly after the "Agent hand-off (2026-09-09…)" paragraph in the Task UX section, add:

```markdown
**One lifecycle (2026-09-09).** `tasks.ai_state` gained `declined` (migration 0052): overnight triage writes it with the reason under `## AI triage — <date>` instead of only caching infeasible verdicts in `overnight/state.json`; the edit panel shows `✦ not taken` plus the reason (`latestSection`/`firstLine` in `app/_components/notes-sections.ts`) and opens the follow-up composer by default; `clear` re-triages on the next run because `pickLifeTasks` only picks null `ai_state`. Approving a plan (`setTaskAiState(id, "approved")`) also stamps `agent_run_requested_at` for the owner, so the 5-minute poll runs a sweep: `✦ queued → ✦ working… → ✦ done` without a second tap; the panel notes "the pc picks it up within ~5 min" / "queued for the 4am run" / "couldn't wake the pc — it runs at 4am".

```

- [ ] **Step 3: `overnight/README.md`**

In the Track B bullets, change "infeasible ones are cached in `state.json` (a retitle re-triages)." to "infeasible ones are marked `✦ not taken` on the task with the reason in the notes (clearing the badge in the app re-triages)." and in the "On-demand runs" section add a bullet: "**Approving a plan** stamps the same request, so an approved task starts within the poll window."

- [ ] **Step 4: Commit**

```bash
git add app/_components/onboarding/whats-new.ts AGENTS.md overnight/README.md
git commit -m "docs: one lifecycle — ✦ not taken, approve acts now

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Gate, PR, merge, apply 0052, PC pull

- [ ] **Step 1: Full gate**

Run: `npm run lint 2>&1 | tail -3; npm run test 2>&1 | grep -E "Test Files|Tests  "; npm run build 2>&1 | grep -E "Compiled successfully|Failed to compile|Type error"`
Expected: 0 errors; all files pass; "Compiled successfully".

- [ ] **Step 2: Push, PR, merge**

```bash
git push -u origin one-lifecycle
gh pr create --base main --head one-lifecycle \
  --title "tasks: one lifecycle — approve acts within 5 min, declined tasks say ✦ not taken" \
  --body "$(cat <<'EOF'
## Summary
- `tasks.ai_state` gains `declined` (migration 0052). Overnight triage writes it with the reason under `## AI triage — <date>` instead of caching silently; the edit panel shows `✦ not taken` + reason and pre-opens `✦ follow up`; `clear` re-triages next run.
- Approving a plan also stamps `agent_run_requested_at` for the owner, so the PC's 5-minute poll runs a sweep and the badge moves `✦ queued → ✦ working… → ✦ done`.
- Pure helpers `latestSection`/`firstLine` (`app/_components/notes-sections.ts`), `declineNote` (`overnight/lib.mjs`), all unit-tested; `requestAgentRun` reuses the same stamp helpers.

## Test plan
- [x] new: `notes-sections`, `task-row-declined`, `task-row-approve`, `tasks-ai-state-action`; extended: `mcp-validate`, `overnight-lib`
- [x] `npm run lint`, `npm run test`, `npm run build`; `node --check overnight/run.mjs overnight/lib.mjs`
- [ ] after merge: apply `0052_ai_state_declined.sql`; `git pull` on the PC; approve a planned task and watch it start within 5 min; run `node overnight\run.mjs --life-only --plan-only` once and check a declined task shows ✦ not taken

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
N=$(gh pr view --json number --jq .number); gh pr merge "$N" --merge --subject "Merge pull request #$N from Luccama700/one-lifecycle"
```

- [ ] **Step 3: Apply the migration**

Supabase MCP `apply_migration` with `name: "0052_ai_state_declined"` and the file's contents; then `execute_sql`:

```sql
select pg_get_constraintdef(oid) from pg_constraint where conname = 'tasks_ai_state_check';
```

Expected: the definition lists `'declined'`.

- [ ] **Step 4: Refresh and confirm the deploy**

```bash
git checkout main && git pull --ff-only && graphify update . | tail -1
SHA=$(git rev-parse origin/main); gh api "repos/Luccama700/mindboard/commits/$SHA/status" --jq '.statuses[] | select(.context|test("Vercel")) | .state'
```

Expected: `success`.

- [ ] **Step 5: PC steps (manual — Lucca)**

On the PC: `git pull` in the repo, then approve one planned task in the app and confirm the badge reaches `✦ working…` within ~5 minutes. Run `node overnight\run.mjs --life-only --plan-only` once; any task triage declines now shows `✦ not taken` in the app with the reason.
