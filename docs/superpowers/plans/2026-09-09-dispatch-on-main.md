# Dispatch on main Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land PR #1's task dispatch ("✦ do it") on today's `main` with unchanged behavior, its migration renumbered to 0051, and the button also reachable from the task edit panel beside "✦ follow up".

**Architecture:** Merge `origin/ai/task-dispatch` into the `agent-handoff` branch (which is `main` plus the spec), resolving its three known conflicts once with `git merge` rather than replaying 18 commits. Then rename the migration, add the panel button reusing PR #1's `DispatchSheet`, run the full gate, open a PR, merge, and apply the migration to the live Supabase project.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, Vitest + Testing Library (jsdom), Supabase Postgres with RLS, Supabase MCP for applying migrations, `gh` CLI for the PR.

**Spec:** `docs/superpowers/specs/2026-09-09-agent-handoff-design.md` — sub-project 1.

## Global Constraints

- No new dependencies; React built-ins and hand-rolled Tailwind only.
- User-facing copy is lowercase; agent affordances use the `✦` glyph.
- Next free migration number is **0051** (`0050_followup_jobs` is applied live). Never edit an applied migration.
- Dispatch and agent-run requests stay **owner-gated** (`ownerUserId() === user.id`): `run.mjs` claims over the owner's personal MCP token, which is user-scoped, so a row for anyone else would never be claimed. Do **not** switch them to `workerAllowedUserIds()` (that allowlist belongs to `worker.py`, which claims through the worker bearer on the service role).
- Gate before declaring done: `npm run lint && npm run test && npm run build`. Two lint warnings are pre-existing (`app/lib/mcp/quick-note.ts:113`, `test/isolation-proof.mjs:87`); 0 errors is the bar. Two `tsc` errors in `__tests__/inventory-ops.test.ts` and `__tests__/quick-note.test.ts` are pre-existing (PR #10 fixes them) and are not this plan's problem.
- Never force-push or rewrite pushed history. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Work in `/Users/luccama/Documents/mindboard` on branch `agent-handoff` (already checked out). Leave `.claude/settings.local.json` and `worker/__pycache__/` alone; never `git add -A`.

---

### Task 1: Merge PR #1 onto `agent-handoff`

**Files:**
- Modify (conflicts to resolve by hand): `app/actions/tasks.ts:5-9`, `app/_components/stream-client.tsx` (the `restMax` block near line 456), `app/_components/onboarding/whats-new.ts:15-24`
- Auto-merged from PR #1 (no edits): `app/_components/dispatch-sheet.tsx`, `app/lib/dispatch/types.ts`, `app/lib/notes.ts`, `app/lib/mcp/writes.ts`, `app/api/mcp/[transport]/route.ts`, `app/page.tsx`, `app/_components/task-row.tsx`, `overnight/run.mjs`, `overnight/lib.mjs`, `overnight/README.md`, `overnight/dispatch-capabilities.md`, `supabase/migrations/0047_task_dispatches.sql`, `docs/superpowers/{specs,plans}/2026-07-31-*`, and five test files.

**Interfaces:**
- Produces: `requestTaskDispatch({ taskId, note })` in `app/actions/tasks.ts`; `DispatchSheet({ task: { id, title }, onClose })` in `app/_components/dispatch-sheet.tsx`; exported `AI_BADGE` from `app/_components/task-row.tsx`; MCP tools `claim_task_dispatch` / `update_task_dispatch`; table `public.task_dispatches`.

- [ ] **Step 1: Confirm the starting state**

Run: `git fetch origin --quiet && git branch --show-current && git status --short`
Expected: `agent-handoff`; status shows only ` M .claude/settings.local.json` and `?? worker/__pycache__/`.

- [ ] **Step 2: Start the merge**

Run: `git merge --no-commit --no-ff origin/ai/task-dispatch 2>&1 | grep -E "CONFLICT|Automatic merge"`
Expected: exactly three `CONFLICT (content)` lines — `app/actions/tasks.ts`, `app/_components/stream-client.tsx`, `app/_components/onboarding/whats-new.ts` — and "Automatic merge failed".

- [ ] **Step 3: Resolve `app/actions/tasks.ts`**

Replace the conflict block (between `<<<<<<< HEAD` and `>>>>>>> origin/ai/task-dispatch`) with all three imports:

```ts
import { queueFollowupFromWatch } from "@/app/lib/watch/followup";
import { validateFollowup } from "@/app/lib/watch/protocol";
import { appendSection } from "@/app/lib/notes";
```

Run: `grep -c "<<<<<<<\|>>>>>>>" app/actions/tasks.ts`
Expected: `0`

- [ ] **Step 4: Resolve `app/_components/stream-client.tsx`**

Replace the conflict block with `main`'s `restMax` (it includes `titleOpen`) preceded by PR #1's badge:

```tsx
  // Where a task sits in the agent lifecycle (dispatched → working → done),
  // in the same badge language the task row uses.
  const aiBadge = cardTask?.ai_state ? AI_BADGE[cardTask.ai_state] : null;
  const aiBadgeNode = aiBadge ? (
    <span className={`text-meta shrink-0 ${aiBadge.tone}`}>{aiBadge.label}</span>
  ) : null;

  const restMax =
    isFocus || editOpen || titleOpen ? "max-h-[40rem]" : "max-h-40";
```

Run: `grep -c "<<<<<<<\|>>>>>>>" app/_components/stream-client.tsx`
Expected: `0`

- [ ] **Step 5: Resolve `app/_components/onboarding/whats-new.ts`**

The head of `NEWS` must read: PR #1's entry first with a fresh id and today's date, then `main`'s entries unchanged.

```ts
export const NEWS: NewsEntry[] = [
  {
    id: "2026-09-09-do-it",
    date: "2026-09-09",
    title: "hand a task to the agent",
    items: [
      "every open task on the day stream carries a ✦ do it now. tap it, type anything the agent should know, send — the pc picks it up within about five minutes and works it at full power.",
      "your note lands in the task's notes as an operator note, and the result comes back the same way. the card stays quiet while it waits, wears ✦ working… once the pc actually starts, then ✦ done.",
      "it researches, drafts, and builds. it never sends, signs, buys, or submits anything in your name — that part stays yours.",
    ],
  },
  {
    id: "2026-09-09-group-trim",
```

Delete the PR's original `2026-07-31-task-dispatch` entry if the merge left a second copy lower down.

Run: `grep -c "<<<<<<<\|>>>>>>>" app/_components/onboarding/whats-new.ts; grep -c "task-dispatch\"" app/_components/onboarding/whats-new.ts`
Expected: `0` then `0`.

- [ ] **Step 6: Stage and type-check**

Run: `git add app/actions/tasks.ts app/_components/stream-client.tsx app/_components/onboarding/whats-new.ts && git diff --cached --stat | tail -1 && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v "^__tests__/inventory-ops\|^__tests__/quick-note\|^  "`
Expected: "22 files changed" (or 23, the spec docs count separately); the `tsc` filter prints nothing.

- [ ] **Step 7: Run PR #1's tests on the merged tree**

Run: `npx vitest run __tests__/dispatch-sheet.test.tsx __tests__/mcp-dispatch.test.ts __tests__/notes-append.test.ts __tests__/overnight-lib.test.ts __tests__/tasks-dispatch-action.test.ts 2>&1 | grep -E "Test Files|Tests  |FAIL"`
Expected: 5 files passed, 0 failed.

- [ ] **Step 8: Commit the merge**

```bash
git commit -F - <<'EOF'
merge: task dispatch (✦ do it) from ai/task-dispatch onto main

PR #1 (2026-07-31) resolved once onto today's main: keeps both the
follow-up and notes imports in the tasks action, main's title-expand
logic plus the agent badge on stream cards, and re-dates the what's-new
entry. Behavior unchanged; migration renumbering follows.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
git log --oneline -1
```

---

### Task 2: Renumber the migration to 0051

**Files:**
- Rename: `supabase/migrations/0047_task_dispatches.sql` → `supabase/migrations/0051_task_dispatches.sql`
- Modify: `overnight/README.md:72`

**Interfaces:**
- Produces: `supabase/migrations/0051_task_dispatches.sql` (content byte-identical to PR #1's file), applied in Task 5.

- [ ] **Step 1: Rename**

Run: `git mv supabase/migrations/0047_task_dispatches.sql supabase/migrations/0051_task_dispatches.sql && ls supabase/migrations | tail -3`
Expected: `0049_people_groups.sql 0050_followup_jobs.sql 0051_task_dispatches.sql`

- [ ] **Step 2: Fix the README reference**

In `overnight/README.md` line 72 change `supabase/migrations/0047_task_dispatches.sql` to `supabase/migrations/0051_task_dispatches.sql`. Leave the July design/plan docs under `docs/superpowers/` alone (they are history).

Run: `rg -n "0047_task_dispatches" --glob '!docs/superpowers/**'`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0051_task_dispatches.sql overnight/README.md
git commit -m "db: task_dispatches migration renumbered to 0051 (0047 is taken by people)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: "✦ do it" in the task edit panel

**Files:**
- Create: `__tests__/task-row-dispatch.test.tsx`
- Modify: `app/_components/task-row.tsx` (imports at lines 3-10; `EditPanel` state near line 263; the `canFollowup` button row near line 560; sheet render after that block)
- Modify: `app/_components/onboarding/whats-new.ts` (the `2026-09-09-do-it` entry gains one item)

**Interfaces:**
- Consumes: `DispatchSheet({ task: { id: string; title: string }; onClose: () => void })` from Task 1.
- Produces: nothing new; the button is not gated client-side (like `✦ follow up`, the action reports "no agent PC serves this account" on submit).

- [ ] **Step 1: Write the failing test**

Create `__tests__/task-row-dispatch.test.tsx`:

```tsx
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/app/actions/tasks", () => ({
  pushTaskToCalendar: vi.fn(),
  queueTaskFollowup: vi.fn(),
  requestTaskDispatch: vi.fn(async () => ({ error: null, dispatchId: "d1" })),
  setTaskAiState: vi.fn(),
}));

import { TaskRow } from "@/app/_components/task-row";
import type { Task } from "@/app/_components/types";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    group_id: null,
    title: "renew the passport",
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

afterEach(cleanup);

describe("✦ do it in the task edit panel", () => {
  test("sits beside ✦ follow up and opens the dispatch sheet", () => {
    renderOpenRow(task());
    expect(screen.getByRole("button", { name: "✦ follow up" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "✦ do it" }));
    expect(screen.getByText("send to the agent")).toBeTruthy();
    expect(screen.getByLabelText("note for the agent")).toBeTruthy();
  });

  test("is hidden once the task is done", () => {
    renderOpenRow(task({ status: "done" }));
    expect(screen.queryByRole("button", { name: "✦ do it" })).toBeNull();
  });
});
```

If `screen.getByText("send to the agent")` cannot find the sheet title, use the exact query `__tests__/dispatch-sheet.test.tsx` uses for it (that file renders the same `Sheet`).

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run __tests__/task-row-dispatch.test.tsx 2>&1 | grep -E "✓|×|Unable to find|Tests  "`
Expected: the first test fails with "Unable to find role="button" and name "✦ do it""; the second passes.

- [ ] **Step 3: Add the button and the sheet**

In `app/_components/task-row.tsx`:

Add the import after the `formatDue` import:

```ts
import { DispatchSheet } from "./dispatch-sheet";
```

In `EditPanel`, after `const followupRef = useRef<HTMLTextAreaElement>(null);` add:

```ts
  const [dispatchOpen, setDispatchOpen] = useState(false);
```

Inside the `{canFollowup && (` block, directly after the `✦ follow up` `</button>` and before `{followupState && (`, add:

```tsx
            <button
              type="button"
              onClick={() => setDispatchOpen(true)}
              className="inline-flex items-center min-h-11 text-[10px] tracking-widest uppercase px-2.5 border rounded-full border-line-strong text-muted hover:border-fg hover:text-fg transition-colors"
            >
              ✦ do it
            </button>
```

Immediately after the closing `)}` of the `{canFollowup && (` block, add:

```tsx
      {dispatchOpen && (
        <DispatchSheet
          task={{ id: task.id, title: task.title }}
          onClose={() => setDispatchOpen(false)}
        />
      )}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run __tests__/task-row-dispatch.test.tsx __tests__/timezone-write-paths.test.tsx 2>&1 | grep -E "Test Files|Tests  |FAIL"`
Expected: 2 files passed (the timezone test proves the row still renders with the extra button).

- [ ] **Step 5: Mention the panel in the what's-new entry**

In `app/_components/onboarding/whats-new.ts`, append a fourth item to the `2026-09-09-do-it` entry:

```ts
      "it's in the task edit panel too, right beside ✦ follow up — follow up adds a new task for you; do it works this one.",
```

- [ ] **Step 6: Commit**

```bash
git add __tests__/task-row-dispatch.test.tsx app/_components/task-row.tsx app/_components/onboarding/whats-new.ts
git commit -m "tasks: ✦ do it beside ✦ follow up in the task edit panel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Document the hand-off in AGENTS.md

**Files:**
- Modify: `AGENTS.md` (end of the "Task UX" section, immediately before the `## Finance` heading; the "Important Files" list)

- [ ] **Step 1: Add the paragraph**

Insert before the line `## Finance` (the anchor text is `## Finance\n\n\`/finance\` is a money tracker`):

```markdown
**Agent hand-off (2026-09-09; design: `docs/superpowers/specs/2026-09-09-agent-handoff-design.md`).** Two ways to hand an open task to the home PC, both in the task edit panel: `✦ follow up` (a `followup` job → `worker.py` → one new follow-up task, same group and due date) and `✦ do it` (`app/_components/dispatch-sheet.tsx` → `requestTaskDispatch` → a `task_dispatches` row, migration 0051 → `run.mjs` Track C drains it on the 5-minute poll and writes `## Agent result` into the notes, `ai_state` building → built/failed). `✦ do it` also sits on the stream cards, where it renders only for the owner (`agentServicesUser` in `app/page.tsx`): `run.mjs` claims over the owner's personal MCP token, which is user-scoped, while follow-ups gate on `workerAllowedUserIds()` because `worker.py` claims through the worker bearer on the service role. Neither button is gated in the panel; the action answers "no agent PC serves this account". Executor guardrails: `overnight/dispatch-capabilities.md` (never submit/send/sign/purchase, never `main`, never `git push`).

```

- [ ] **Step 2: Add the file to "Important Files"**

After the line starting `- \`app/_components/event-edit-panel.tsx\`` add:

```markdown
- `app/_components/dispatch-sheet.tsx`: the `✦ do it` sheet (one note → `requestTaskDispatch`), used by stream cards and the task edit panel.
```

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: agent hand-off — ✦ do it and ✦ follow up in AGENTS.md

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Gate, PR, merge, apply the migration

**Files:** none new.

- [ ] **Step 1: Full gate**

Run: `npm run lint 2>&1 | tail -3; npm run test 2>&1 | grep -E "Test Files|Tests  "; npm run build 2>&1 | grep -E "Compiled successfully|Failed to compile|Type error"`
Expected: "0 errors, 2 warnings"; all test files pass (1337 + the new file's 2 + PR #1's tests); "Compiled successfully".

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin agent-handoff
gh pr create --base main --head agent-handoff \
  --title "tasks: ✦ do it — one-shot dispatch to the home PC (PR #1 landed on main)" \
  --body "$(cat <<'EOF'
## Summary
- Lands PR #1 (task dispatch, 2026-07-31) on today's main: merged once, three conflicts resolved (tasks action imports, stream card badge + title-expand, what's-new ordering). Behavior unchanged.
- Migration renumbered `0047` → `0051_task_dispatches.sql` (0047 is the people migration).
- `✦ do it` now also sits in the task edit panel beside `✦ follow up`, opening the same sheet.
- Design spec + implementation plans for the whole hand-off effort ride along under `docs/superpowers/`.

## Test plan
- [x] PR #1's five test files pass on the merged tree
- [x] new `__tests__/task-row-dispatch.test.tsx`
- [x] `npm run lint` (2 pre-existing warnings), `npm run test`, `npm run build`
- [ ] after merge: apply `0051_task_dispatches.sql`, `git pull` on the PC, one trivial dispatch end to end

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Merge (merge commit, keep the branch)**

Run: `N=$(gh pr view --json number --jq .number); gh pr merge "$N" --merge --subject "Merge pull request #$N from Luccama700/agent-handoff" && git fetch origin --quiet && git log --oneline -1 origin/main`
Expected: the merge commit is the tip of `origin/main`.

- [ ] **Step 4: Apply the migration to the live project**

Use the Supabase MCP `apply_migration` tool with `name: "0051_task_dispatches"` and `query:` = the full contents of `supabase/migrations/0051_task_dispatches.sql`. Then call `list_migrations`.
Expected: the list ends with `0050_followup_jobs`, `0051_task_dispatches`. Then run this read-only check with `execute_sql`:

```sql
select relname, relrowsecurity from pg_class where relname = 'task_dispatches';
```

Expected: one row, `relrowsecurity = true`.

- [ ] **Step 5: Close PR #1 and refresh the checkout**

```bash
gh pr close 1 --comment "Landed on main via the agent-handoff PR (merged once onto today's main, migration renumbered to 0051)."
git checkout main && git pull --ff-only && graphify update . | tail -1
```

- [ ] **Step 6: Confirm the deploy**

Run: `SHA=$(git rev-parse origin/main); gh api "repos/Luccama700/mindboard/commits/$SHA/status" --jq '.statuses[] | select(.context|test("Vercel")) | .state'`
Expected: `success` (retry after a minute if `pending`).

---

### Task 6: PC steps (manual — Lucca)

Nothing on the PC pulls the repo. After Task 5:

- [ ] On the PC, in `C:\Users\U\Documents\mindboard\mindboard`: `git pull`.
- [ ] Open the app, pick a harmless open task, tap `✦ do it`, note: `write hello.md in the workspace with today's date`.
- [ ] Within ~5 minutes the badge reads `✦ working…`, then `✦ done`; the task notes gain `## Agent result`; `overnight\logs\` has the run log.
- [ ] If nothing happens after 10 minutes: check the `Mindboard Agent Poll` scheduled task is enabled (`Get-ScheduledTask "Mindboard Agent Poll"`) and that `overnight\.env` still has a valid `MINDBOARD_PAT`.
