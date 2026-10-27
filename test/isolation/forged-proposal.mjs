// Reaches the DB-mutating executors across the tenant boundary.
//
// Why this exists: the attack table can only prove that propose-time resolution
// refuses a cross-tenant id. It can never reach `confirm_action`'s executor,
// because a cross-tenant propose never yields a proposalId to confirm — so the
// executors' own `.eq("user_id", ownerId)` guards, the second line of defence,
// were entirely unverified.
//
// So the probe forges the missing step: it writes an ai_audit_log row OWNED BY
// A whose stored input points at B's rows (the admin client bypasses the
// propose-time check the same way a resolution bug would), then has A confirm
// it over MCP. That drives the real executor with A's ownerId and B's object
// ids — exactly the shape a future propose-time regression would produce.
//
// EVERY entry is paired with a CONTROL: the same forged input shape, pointed at
// a purpose-built row of A's own, which must reach the executor and APPLY.
// Without it a refusal is not evidence of anything — a forged input whose shape
// has drifted from the executor's validator fails schema validation *before*
// any ownership check and still looks like a refusal. That is not hypothetical:
// this file originally forged update_finance's remove op as
// `{kind, changeId, summary}` when the executor requires
// `{kind, changeId, accountId, label}`, so the op was rejected as "malformed
// remove operation" and the ownership guard was never exercised. The control
// turns that class of silent vacuity into a red check naming the executor.
//
// Controls mutate only their own scratch rows, so nothing a later assertion
// depends on is disturbed. Scratch rows cascade away with the tenant.

import { createHash } from "node:crypto";

import { todayKey } from "./harness.mjs";

// ---------------------------------------------------------------------------
// Outcome vocabulary. Not every executor can be proved the same way, and
// pretending otherwise is how a control stops meaning anything.
//
//   "applies"           The control must reach the executor AND mutate A's own
//                       scratch row (verifyControl). The strongest shape, and
//                       the default — use it unless the executor genuinely
//                       cannot succeed for a throwaway tenant.
//
//   { reaches: RegExp } The control must FAIL, with a message raised only
//                       AFTER the ownership resolution the victim must not
//                       survive. A missing Anthropic key or an unconverted
//                       source is such a message: reaching it proves the
//                       stored shape passed validation and the caller's own
//                       row was found. The victim must NOT produce it.
//
//   { gate: RegExp }    A gate fires BEFORE any row is resolved, so victim and
//                       control are refused identically and no ownership check
//                       is reached at all. The claim is then about the gate —
//                       that it reads the CALLER, never the stored input — and
//                       the pair asserts exactly that and nothing more. Use it
//                       only where there is no row to own (URC's owner gate;
//                       the Google-credential tools, whose isolation boundary
//                       is the caller's own token).
//
// `victimError` optionally pins the victim's refusal, so "refused" cannot
// quietly become "refused for an unrelated reason" (a drifted shape failing
// validation reads identically to an ownership refusal — the exact rot these
// controls exist to catch).
//
// `noForeignRef` marks the two executors that take no foreign id at all
// (log_daily, update_settings): they upsert on `user_id: ownerId`, so the
// shape under test is "it lands on the CALLER's row", and the victim check is
// that the other tenant's same-day log / settings row never moved.
// ---------------------------------------------------------------------------

// Purpose-built rows of A's own for the controls to mutate. Each executor gets
// its own row so a destructive control (delete_task, update_finance remove)
// cannot disturb another control or a later assertion.
export async function seedControlFixtures(admin, userId, marker) {
  const s = { marker };
  const one = async (table, row) => {
    const { data, error } = await admin.from(table).insert(row).select("id").single();
    if (error) throw new Error(`control fixture ${table}: ${error.message}`);
    return data.id;
  };

  for (const key of ["taskComplete", "taskMiss", "taskUpdate", "taskDelete"]) {
    s[key] = await one("tasks", {
      user_id: userId,
      title: `${marker}-ctl-${key}`,
      status: "todo",
    });
  }

  s.goalId = await one("goals", {
    user_id: userId,
    title: `${marker}-ctl-goal`,
    horizon: "month",
    status: "active",
  });
  s.groupId = await one("groups", {
    user_id: userId,
    name: `${marker}-ctl-group`,
    type: "project",
    color: "#222222",
  });
  // create_task / create_recurring_task write INTO a group, so they need one
  // that no other control archives or renames underneath them.
  s.createGroupId = await one("groups", {
    user_id: userId,
    name: `${marker}-ctl-create-group`,
    type: "project",
    color: "#333333",
  });
  s.recurringTaskId = await one("recurring_tasks", {
    user_id: userId,
    title: `${marker}-ctl-habit`,
    frequency: "daily",
  });
  // One rule per recurring executor: archive_recurring_task's control archives
  // its rule, and an archived rule is not a clean subject for the others.
  s.recurringUpdateId = await one("recurring_tasks", {
    user_id: userId,
    title: `${marker}-ctl-habit-update`,
    frequency: "daily",
  });
  s.recurringCompleteId = await one("recurring_tasks", {
    user_id: userId,
    title: `${marker}-ctl-habit-complete`,
    frequency: "daily",
  });
  // 'overall' scope so it cannot collide with the tenant's category-scoped limit.
  s.spendLimitId = await one("spend_limits", {
    user_id: userId,
    scope: "overall",
    period: "monthly",
    amount: 500,
  });
  // set_spend_limit upserts one limit per category, so it needs a category
  // nothing else has capped.
  s.limitCategoryId = await one("spending_categories", {
    user_id: userId,
    name: `${marker}-ctl-limit-category`,
    color: "#444444",
  });
  s.adminAccountName = `${marker}-ctl-admin-account`;
  s.adminAccountId = await one("accounts", {
    user_id: userId,
    name: s.adminAccountName,
    type: "checking",
    balance: 50,
    currency: "CAD",
  });
  s.personName = `${marker}-ctl-person`;
  s.personId = await one("people", {
    user_id: userId,
    name: s.personName,
  });
  // generate_audio_overview's control must get PAST course resolution and die
  // at "no converted sources", which is the proof it resolved A's own course.
  // An empty course is exactly right for that: no episode is ever generated,
  // so the control spends nothing.
  s.courseName = `${marker}-ctl-course`;
  s.courseId = await one("courses", {
    user_id: userId,
    name: s.courseName,
    color: "#555555",
  });
  // A device of A's own, so spawn_urc's control is shape-identical to its
  // victim. Neither reaches the device: the owner gate refuses both first,
  // which is the whole point of that pair.
  s.urcFolderKey = "probe";
  s.urcDeviceId = await one("urc_devices", {
    user_id: userId,
    name: `${marker}-ctl-pc`,
    // token_hash is UNIQUE; the token itself is never presented anywhere.
    token_hash: createHash("sha256").update(`${marker}-ctl-device`, "utf8").digest("hex"),
    folder_keys: [s.urcFolderKey],
  });

  // Two accounts: log_spend ADDS a row to one, update_finance REMOVES the only
  // row from the other, so each control's verification is an exact count.
  s.logAccountId = await one("accounts", {
    user_id: userId,
    name: `${marker}-ctl-log-account`,
    type: "checking",
    balance: 100,
    currency: "CAD",
  });
  s.removeAccountId = await one("accounts", {
    user_id: userId,
    name: `${marker}-ctl-remove-account`,
    type: "checking",
    balance: 100,
    currency: "CAD",
  });
  s.removeChangeId = await one("balance_changes", {
    user_id: userId,
    account_id: s.removeAccountId,
    direction: "out",
    amount: 9.5,
    occurred_at: new Date().toISOString().slice(0, 10),
    note: `${marker}-ctl-change`,
    source: "manual",
  });

  s.itemName = `${marker}-ctl-item`;
  s.itemId = await one("inventory_items", {
    user_id: userId,
    name: s.itemName,
    quantity: 4,
    unit: "packs",
  });

  return s;
}

// Each entry pairs the cross-tenant input (victim) with an identically-shaped
// input aimed at A's own scratch row (control). Both are required — the
// structural test in __tests__/isolation-probe.test.ts fails if any field is
// missing, so a new executor cannot be added here without its control.
export const FORGERIES = [
  {
    tool: "complete_task",
    outcome: "applies",
    what: "complete B's task",
    victim: (ctx) => ({ taskId: ctx.b.taskId }),
    verifyVictim: async (admin, ctx) => {
      const { data } = await admin.from("tasks").select("status").eq("id", ctx.b.taskId).maybeSingle();
      return { ok: data?.status === "todo", detail: `status=${data?.status}` };
    },
    control: (ctx, s) => ({ taskId: s.taskComplete }),
    verifyControl: async (admin, s) => {
      const { data } = await admin.from("tasks").select("status").eq("id", s.taskComplete).maybeSingle();
      return { ok: data?.status === "done", detail: `status=${data?.status}` };
    },
  },
  {
    tool: "miss_task",
    outcome: "applies",
    what: "mark B's task missed",
    victim: (ctx) => ({ taskId: ctx.b.taskId }),
    verifyVictim: async (admin, ctx) => {
      const { data } = await admin
        .from("tasks")
        .select("status, missed_at")
        .eq("id", ctx.b.taskId)
        .maybeSingle();
      return { ok: data?.status === "todo" && !data?.missed_at, detail: `status=${data?.status}` };
    },
    control: (ctx, s) => ({ taskId: s.taskMiss }),
    verifyControl: async (admin, s) => {
      const { data } = await admin.from("tasks").select("status").eq("id", s.taskMiss).maybeSingle();
      return { ok: data?.status === "missed", detail: `status=${data?.status}` };
    },
  },
  {
    tool: "update_task",
    outcome: "applies",
    what: "rename B's task",
    victim: (ctx) => ({ taskId: ctx.b.taskId, title: "forged-rename" }),
    verifyVictim: async (admin, ctx) => {
      const { data } = await admin.from("tasks").select("title").eq("id", ctx.b.taskId).maybeSingle();
      return { ok: data?.title === ctx.b.taskTitle, detail: `title=${data?.title}` };
    },
    control: (ctx, s) => ({ taskId: s.taskUpdate, title: `${s.marker}-ctl-renamed` }),
    verifyControl: async (admin, s) => {
      const { data } = await admin.from("tasks").select("title").eq("id", s.taskUpdate).maybeSingle();
      return { ok: data?.title === `${s.marker}-ctl-renamed`, detail: `title=${data?.title}` };
    },
  },
  {
    tool: "delete_task",
    outcome: "applies",
    what: "delete B's task",
    victim: (ctx) => ({ taskId: ctx.b.taskId }),
    verifyVictim: async (admin, ctx) => {
      const { data } = await admin.from("tasks").select("id").eq("id", ctx.b.taskId);
      return { ok: (data ?? []).length === 1, detail: `rows=${(data ?? []).length}` };
    },
    control: (ctx, s) => ({ taskId: s.taskDelete }),
    verifyControl: async (admin, s) => {
      const { data } = await admin.from("tasks").select("id").eq("id", s.taskDelete);
      return { ok: (data ?? []).length === 0, detail: `rows=${(data ?? []).length}` };
    },
  },
  {
    tool: "upsert_goal",
    outcome: "applies",
    what: "archive B's goal",
    victim: (ctx) => ({ goalId: ctx.b.goalId, status: "archived" }),
    verifyVictim: async (admin, ctx) => {
      const { data } = await admin.from("goals").select("status").eq("id", ctx.b.goalId).maybeSingle();
      return { ok: data?.status === "active", detail: `status=${data?.status}` };
    },
    control: (ctx, s) => ({ goalId: s.goalId, status: "archived" }),
    verifyControl: async (admin, s) => {
      const { data } = await admin.from("goals").select("status").eq("id", s.goalId).maybeSingle();
      return { ok: data?.status === "archived", detail: `status=${data?.status}` };
    },
  },
  {
    tool: "manage_group",
    outcome: "applies",
    what: "rename B's group",
    victim: (ctx) => ({ action: "update", groupId: ctx.b.groupId, name: "forged-rename" }),
    verifyVictim: async (admin, ctx) => {
      const { data } = await admin.from("groups").select("name").eq("id", ctx.b.groupId).maybeSingle();
      return { ok: data?.name === ctx.b.groupName, detail: `name=${data?.name}` };
    },
    control: (ctx, s) => ({ action: "update", groupId: s.groupId, name: `${s.marker}-ctl-renamed` }),
    verifyControl: async (admin, s) => {
      const { data } = await admin.from("groups").select("name").eq("id", s.groupId).maybeSingle();
      return { ok: data?.name === `${s.marker}-ctl-renamed`, detail: `name=${data?.name}` };
    },
  },
  {
    tool: "archive_recurring_task",
    outcome: "applies",
    what: "stop B's repeating task",
    victim: (ctx) => ({ ruleId: ctx.b.recurringTaskId }),
    verifyVictim: async (admin, ctx) => {
      const { data } = await admin
        .from("recurring_tasks")
        .select("archived")
        .eq("id", ctx.b.recurringTaskId)
        .maybeSingle();
      return { ok: data?.archived === false, detail: `archived=${data?.archived}` };
    },
    control: (ctx, s) => ({ ruleId: s.recurringTaskId }),
    verifyControl: async (admin, s) => {
      const { data } = await admin
        .from("recurring_tasks")
        .select("archived")
        .eq("id", s.recurringTaskId)
        .maybeSingle();
      return { ok: data?.archived === true, detail: `archived=${data?.archived}` };
    },
  },
  {
    tool: "delete_spend_limit",
    outcome: "applies",
    what: "delete B's spending limit",
    victim: (ctx) => ({ limitId: ctx.b.spendLimitId }),
    verifyVictim: async (admin, ctx) => {
      const { data } = await admin
        .from("spend_limits")
        .select("archived")
        .eq("id", ctx.b.spendLimitId)
        .maybeSingle();
      return { ok: data?.archived === false, detail: `archived=${data?.archived}` };
    },
    control: (ctx, s) => ({ limitId: s.spendLimitId }),
    verifyControl: async (admin, s) => {
      const { data } = await admin
        .from("spend_limits")
        .select("archived")
        .eq("id", s.spendLimitId)
        .maybeSingle();
      // Deleted or archived — either way it is no longer an active limit, and
      // it demonstrably was one before the control ran.
      return { ok: !data || data.archived === true, detail: `row=${JSON.stringify(data)}` };
    },
  },
  {
    tool: "log_spend",
    outcome: "applies",
    what: "write a ledger row into B's account",
    victim: (ctx) => ({ accountId: ctx.b.accountId, amount: 3, categoryId: null, note: "forged" }),
    verifyVictim: async (admin, ctx) => {
      const { data } = await admin
        .from("balance_changes")
        .select("id")
        .eq("account_id", ctx.b.accountId);
      return { ok: (data ?? []).length === 1, detail: `rows=${(data ?? []).length}` };
    },
    control: (ctx, s) => ({
      accountId: s.logAccountId,
      amount: 3,
      categoryId: null,
      note: "control",
    }),
    verifyControl: async (admin, s) => {
      const { data } = await admin
        .from("balance_changes")
        .select("id")
        .eq("account_id", s.logAccountId);
      return { ok: (data ?? []).length === 1, detail: `rows=${(data ?? []).length}` };
    },
  },
  {
    tool: "update_stock",
    outcome: "applies",
    what: "archive B's inventory item (resolved-op shape)",
    victim: (ctx) => ({
      operations: [{ kind: "archive", itemId: ctx.b.itemId, name: ctx.b.itemName }],
    }),
    verifyVictim: async (admin, ctx) => {
      const { data } = await admin
        .from("inventory_items")
        .select("archived, quantity")
        .eq("id", ctx.b.itemId)
        .maybeSingle();
      return {
        ok: data?.archived === false && Number(data?.quantity) === 12,
        detail: `archived=${data?.archived} qty=${data?.quantity}`,
      };
    },
    control: (ctx, s) => ({
      operations: [{ kind: "archive", itemId: s.itemId, name: s.itemName }],
    }),
    verifyControl: async (admin, s) => {
      const { data } = await admin
        .from("inventory_items")
        .select("archived")
        .eq("id", s.itemId)
        .maybeSingle();
      return { ok: data?.archived === true, detail: `archived=${data?.archived}` };
    },
  },
  {
    tool: "update_finance",
    outcome: "applies",
    what: "remove B's ledger row (resolved-op shape)",
    // The executor pre-checks every referenced account against ownerId before
    // touching a row, so accountId must be present AND must be B's for this to
    // exercise the guard rather than the shape validator.
    victim: (ctx) => ({
      operations: [
        {
          kind: "remove",
          changeId: ctx.b.changeId,
          accountId: ctx.b.accountId,
          label: "forged remove",
        },
      ],
    }),
    verifyVictim: async (admin, ctx) => {
      const { data } = await admin.from("balance_changes").select("id").eq("id", ctx.b.changeId);
      return { ok: (data ?? []).length === 1, detail: `rows=${(data ?? []).length}` };
    },
    control: (ctx, s) => ({
      operations: [
        {
          kind: "remove",
          changeId: s.removeChangeId,
          accountId: s.removeAccountId,
          label: "control remove",
        },
      ],
    }),
    verifyControl: async (admin, s) => {
      const { data } = await admin.from("balance_changes").select("id").eq("id", s.removeChangeId);
      return { ok: (data ?? []).length === 0, detail: `rows=${(data ?? []).length}` };
    },
  },

  // =========================================================================
  // The thirteen executors the 2026-10-26 audit found uncovered. `tool` is the
  // EXECUTORS key, not the MCP tool name — confirmAction does
  // EXECUTORS[proposal.tool_name], and the two differ for complete_recurring
  // (registered as complete_recurring_task). Each `input` is exactly what the
  // matching propose* function hands recordProposal, post-resolution.
  // =========================================================================

  {
    tool: "create_task",
    outcome: "applies",
    what: "create a task inside B's group",
    victim: (ctx) => ({
      title: "forged into B's group",
      groupId: ctx.b.groupId,
      dueDate: null,
      notes: null,
      priority: "med",
    }),
    verifyVictim: async (admin, ctx) => {
      const { data } = await admin.from("tasks").select("id").eq("group_id", ctx.b.groupId);
      // B seeded exactly one task into that group.
      return { ok: (data ?? []).length === 1, detail: `rows=${(data ?? []).length}` };
    },
    control: (ctx, s) => ({
      title: `${s.marker}-ctl-created`,
      groupId: s.createGroupId,
      dueDate: null,
      notes: null,
      priority: "med",
    }),
    verifyControl: async (admin, s) => {
      const { data } = await admin.from("tasks").select("id").eq("group_id", s.createGroupId);
      return { ok: (data ?? []).length === 1, detail: `rows=${(data ?? []).length}` };
    },
  },
  {
    tool: "create_recurring_task",
    outcome: "applies",
    what: "create a repeating task inside B's group",
    // frequency 'daily' on purpose: validateCreateRecurringTask reads
    // dayOfMonth/intervalDays/startDate, while the STORED value spells them
    // day_of_month/interval_days/start_date (TaskRecurrence). Daily leaves all
    // three null, so the stored shape round-trips through the executor's
    // re-validation exactly as it does in production.
    victim: (ctx) => ({
      title: "forged habit into B's group",
      groupId: ctx.b.groupId,
      notes: null,
      priority: "med",
      frequency: "daily",
      dueTime: null,
      durationMin: null,
    }),
    verifyVictim: async (admin, ctx) => {
      const { data } = await admin
        .from("recurring_tasks")
        .select("id")
        .eq("group_id", ctx.b.groupId);
      return { ok: (data ?? []).length === 0, detail: `rows=${(data ?? []).length}` };
    },
    control: (ctx, s) => ({
      title: `${s.marker}-ctl-created-habit`,
      groupId: s.createGroupId,
      notes: null,
      priority: "med",
      frequency: "daily",
      dueTime: null,
      durationMin: null,
    }),
    verifyControl: async (admin, s) => {
      const { data } = await admin
        .from("recurring_tasks")
        .select("id")
        .eq("group_id", s.createGroupId);
      return { ok: (data ?? []).length === 1, detail: `rows=${(data ?? []).length}` };
    },
  },
  {
    tool: "update_recurring_task",
    outcome: "applies",
    what: "rename B's repeating-task rule",
    victim: (ctx) => ({ ruleId: ctx.b.recurringTaskId, title: "forged-rename" }),
    verifyVictim: async (admin, ctx) => {
      const { data } = await admin
        .from("recurring_tasks")
        .select("title")
        .eq("id", ctx.b.recurringTaskId)
        .maybeSingle();
      return { ok: data?.title === ctx.b.recurringTaskTitle, detail: `title=${data?.title}` };
    },
    control: (ctx, s) => ({ ruleId: s.recurringUpdateId, title: `${s.marker}-ctl-renamed-habit` }),
    verifyControl: async (admin, s) => {
      const { data } = await admin
        .from("recurring_tasks")
        .select("title")
        .eq("id", s.recurringUpdateId)
        .maybeSingle();
      return {
        ok: data?.title === `${s.marker}-ctl-renamed-habit`,
        detail: `title=${data?.title}`,
      };
    },
  },
  {
    // EXECUTORS key, not the tool name (complete_recurring_task).
    tool: "complete_recurring",
    outcome: "applies",
    what: "check off today's occurrence of B's habit",
    victim: (ctx) => ({ ruleId: ctx.b.recurringTaskId, undo: false }),
    verifyVictim: async (admin, ctx) => {
      const { data } = await admin
        .from("recurring_task_completions")
        .select("id")
        .eq("rule_id", ctx.b.recurringTaskId);
      return { ok: (data ?? []).length === 0, detail: `rows=${(data ?? []).length}` };
    },
    control: (ctx, s) => ({ ruleId: s.recurringCompleteId, undo: false }),
    verifyControl: async (admin, s) => {
      const { data } = await admin
        .from("recurring_task_completions")
        .select("id")
        .eq("rule_id", s.recurringCompleteId);
      return { ok: (data ?? []).length === 1, detail: `rows=${(data ?? []).length}` };
    },
  },
  {
    tool: "set_spend_limit",
    outcome: "applies",
    what: "cap B's spending category",
    victim: (ctx) => ({
      scope: "category",
      categoryId: ctx.b.categoryId,
      period: "monthly",
      amount: 1,
    }),
    verifyVictim: async (admin, ctx) => {
      const { data } = await admin
        .from("spend_limits")
        .select("id, amount")
        .eq("category_id", ctx.b.categoryId);
      // B seeded one limit on that category, at 300.
      return {
        ok: (data ?? []).length === 1 && Number(data[0].amount) === 300,
        detail: JSON.stringify(data),
      };
    },
    control: (ctx, s) => ({
      scope: "category",
      categoryId: s.limitCategoryId,
      period: "monthly",
      amount: 1,
    }),
    verifyControl: async (admin, s) => {
      const { data } = await admin
        .from("spend_limits")
        .select("id, amount")
        .eq("category_id", s.limitCategoryId);
      return {
        ok: (data ?? []).length === 1 && Number(data[0].amount) === 1,
        detail: JSON.stringify(data),
      };
    },
  },
  {
    tool: "manage_finance",
    outcome: "applies",
    what: "rename B's account (resolved-op shape)",
    victim: (ctx) => ({
      operations: [
        {
          kind: "update_account",
          accountId: ctx.b.accountId,
          accountName: ctx.b.accountName,
          name: "forged-rename",
          type: null,
          color: null,
          archived: null,
        },
      ],
    }),
    verifyVictim: async (admin, ctx) => {
      const { data } = await admin
        .from("accounts")
        .select("name")
        .eq("id", ctx.b.accountId)
        .maybeSingle();
      return { ok: data?.name === ctx.b.accountName, detail: `name=${data?.name}` };
    },
    control: (ctx, s) => ({
      operations: [
        {
          kind: "update_account",
          accountId: s.adminAccountId,
          accountName: s.adminAccountName,
          name: `${s.marker}-ctl-admin-renamed`,
          type: null,
          color: null,
          archived: null,
        },
      ],
    }),
    verifyControl: async (admin, s) => {
      const { data } = await admin
        .from("accounts")
        .select("name")
        .eq("id", s.adminAccountId)
        .maybeSingle();
      return {
        ok: data?.name === `${s.marker}-ctl-admin-renamed`,
        detail: `name=${data?.name}`,
      };
    },
  },
  {
    tool: "update_people",
    outcome: "applies",
    what: "archive B's person (resolved-op shape)",
    victim: (ctx) => ({
      operations: [{ kind: "archive", personId: ctx.b.personId, name: ctx.b.personName }],
    }),
    verifyVictim: async (admin, ctx) => {
      const { data } = await admin
        .from("people")
        .select("archived")
        .eq("id", ctx.b.personId)
        .maybeSingle();
      return { ok: data?.archived === false, detail: `archived=${data?.archived}` };
    },
    control: (ctx, s) => ({
      operations: [{ kind: "archive", personId: s.personId, name: s.personName }],
    }),
    verifyControl: async (admin, s) => {
      const { data } = await admin
        .from("people")
        .select("archived")
        .eq("id", s.personId)
        .maybeSingle();
      return { ok: data?.archived === true, detail: `archived=${data?.archived}` };
    },
  },

  // ---- no foreign id to point at: the claim is "it lands on the caller" ----
  {
    tool: "log_daily",
    outcome: "applies",
    noForeignRef: true,
    what: "overwrite B's same-day check-in",
    // executeLogDaily upserts on (user_id, log_date) with user_id: ownerId.
    // There is nothing in the input to aim at B — which is exactly why the
    // victim and control inputs are identical and the ASSERTIONS differ: the
    // control proves A's own row was written, the victim proves B's same-day
    // row (seeded with mood 4 / energy 3) never moved.
    victim: () => ({ mood: 1, energy: 1, sleepHours: 1 }),
    verifyVictim: async (admin, ctx) => {
      const { data } = await admin
        .from("daily_logs")
        .select("mood, energy, note")
        .eq("id", ctx.b.dailyLogId)
        .maybeSingle();
      return {
        ok: data?.mood === 4 && data?.energy === 3 && data?.note === ctx.b.dailyNote,
        detail: JSON.stringify(data),
      };
    },
    control: () => ({ mood: 1, energy: 1, sleepHours: 1 }),
    verifyControl: async (admin, s, ctx) => {
      const { data } = await admin
        .from("daily_logs")
        .select("mood, energy")
        .eq("user_id", ctx.a.userId);
      return {
        ok: (data ?? []).some((row) => row.mood === 1 && row.energy === 1),
        detail: JSON.stringify(data),
      };
    },
  },
  {
    tool: "update_settings",
    outcome: "applies",
    noForeignRef: true,
    what: "rewrite B's settings row",
    // Same shape as log_daily: an upsert on { user_id: ownerId }. shoppingStore
    // rather than timezone, because the tenants' timezones are load-bearing for
    // several earlier assertions and the attack sweep has already run.
    victim: () => ({ shoppingStore: "forged-store" }),
    verifyVictim: async (admin, ctx) => {
      const { data } = await admin
        .from("user_settings")
        .select("shopping_store, timezone")
        .eq("user_id", ctx.b.userId)
        .maybeSingle();
      return {
        ok: data?.shopping_store === ctx.b.shoppingStore && data?.timezone === ctx.b.timezone,
        detail: JSON.stringify(data),
      };
    },
    control: () => ({ shoppingStore: "control-store" }),
    verifyControl: async (admin, s, ctx) => {
      const { data } = await admin
        .from("user_settings")
        .select("shopping_store")
        .eq("user_id", ctx.a.userId)
        .maybeSingle();
      return { ok: data?.shopping_store === "control-store", detail: JSON.stringify(data) };
    },
  },

  // ---- control fails, but only AFTER resolving the caller's own row ----
  {
    tool: "generate_audio_overview",
    // generateEpisodeFor resolves the course against `.eq("user_id", userId)`
    // FIRST and only then reads the Anthropic key, so the two failures are
    // different sentences. The control names A's own (empty) course and must
    // die at "no converted sources" — proof it got past course resolution —
    // while the victim names B's course and must die before that. No episode is
    // ever generated, so neither call spends money.
    outcome: { reaches: /has no converted sources yet/i },
    victimError: /course/i,
    what: "generate an episode from B's course",
    victim: (ctx) => ({
      course: ctx.b.courseId,
      sourceIds: null,
      flavor: "brief",
      engine: "gemini",
    }),
    verifyVictim: async (admin, ctx) => {
      const { data } = await admin
        .from("audio_episodes")
        .select("id")
        .eq("course_id", ctx.b.courseId);
      return { ok: (data ?? []).length === 0, detail: `rows=${(data ?? []).length}` };
    },
    control: (ctx, s) => ({
      course: s.courseId,
      sourceIds: null,
      flavor: "brief",
      engine: "gemini",
    }),
    verifyControl: async (admin, s) => {
      const { data } = await admin.from("audio_episodes").select("id").eq("course_id", s.courseId);
      return { ok: (data ?? []).length === 0, detail: `rows=${(data ?? []).length}` };
    },
  },

  // ---- a gate earlier than any row resolution refuses both ----
  {
    tool: "create_event",
    // There is no Mindboard row to own here: the executor's isolation boundary
    // IS the Google credential, and it loads that from `ownerId`, never from
    // the stored input. So the pair asserts exactly that and nothing more —
    // both the foreign calendarId and A's own die at A's own missing token,
    // which means no stored field can route around the credential lookup.
    // (The matrix entry carries the complementary half: B HAS a token, so
    // reading B's row would fail Google-side with a different message.)
    outcome: { gate: /google calendar connection failed/i },
    what: "create an event on B's calendar",
    victim: (ctx) => ({
      summary: "forged event",
      date: todayKey(1),
      startTime: "10:00",
      durationMin: 60,
      calendarId: `${ctx.b.marker}-calendar`,
      description: null,
    }),
    verifyVictim: async (admin, ctx) => {
      const { data } = await admin
        .from("google_tokens")
        .select("access_token")
        .eq("user_id", ctx.b.userId)
        .maybeSingle();
      return {
        ok: !data || data.access_token === ctx.b.googleAccessToken,
        detail: "B's google_tokens row is unchanged",
      };
    },
    control: (ctx, s) => ({
      summary: "control event",
      date: todayKey(1),
      startTime: "10:00",
      durationMin: 60,
      calendarId: `${s.marker}-calendar`,
      description: null,
    }),
    verifyControl: async () => ({ ok: true, detail: "no row is written either way" }),
  },
  {
    tool: "reschedule_event",
    outcome: { gate: /google calendar connection failed/i },
    what: "move an event on B's calendar",
    victim: (ctx) => ({
      calendarId: `${ctx.b.marker}-calendar`,
      eventId: `${ctx.b.marker}-event`,
      allDay: false,
      start: `${todayKey(1)}T10:00:00Z`,
      end: `${todayKey(1)}T11:00:00Z`,
      timeZone: null,
    }),
    verifyVictim: async (admin, ctx) => {
      const { data } = await admin
        .from("google_tokens")
        .select("access_token")
        .eq("user_id", ctx.b.userId)
        .maybeSingle();
      return {
        ok: !data || data.access_token === ctx.b.googleAccessToken,
        detail: "B's google_tokens row is unchanged",
      };
    },
    control: (ctx, s) => ({
      calendarId: `${s.marker}-calendar`,
      eventId: `${s.marker}-event`,
      allDay: false,
      start: `${todayKey(1)}T10:00:00Z`,
      end: `${todayKey(1)}T11:00:00Z`,
      timeZone: null,
    }),
    verifyControl: async () => ({ ok: true, detail: "no row is written either way" }),
  },
  {
    tool: "spawn_urc",
    // urcAuth runs FIRST in executeSpawnUrc — before the proposal's age check,
    // before the folder is parsed, before the device is resolved. Neither probe
    // tenant is ever URC_OWNER_USER_ID, so both halves must be refused by that
    // gate, with the gate's own message. A victim refused for any OTHER reason
    // would mean the owner check moved below something forgeable, which is the
    // regression this pair exists to catch. The device rows exist on both sides
    // so the inputs are shape-identical and neither refusal can be a
    // "device not found" in disguise.
    outcome: { gate: /not available|URC/i },
    what: "start a Claude Code session on B's PC",
    victim: (ctx) => ({
      folder: ctx.b.urcFolderKey,
      deviceId: ctx.b.urcDeviceId,
      name: null,
    }),
    verifyVictim: async (admin, ctx) => {
      const { data } = await admin
        .from("urc_jobs")
        .select("id, status")
        .eq("user_id", ctx.b.userId);
      const queued = (data ?? []).filter((j) => j.status === "queued");
      return {
        ok: (data ?? []).length === 1 && queued.length === 0,
        detail: JSON.stringify(data),
      };
    },
    control: (ctx, s) => ({
      folder: s.urcFolderKey,
      deviceId: s.urcDeviceId,
      name: null,
    }),
    verifyControl: async (admin, s, ctx) => {
      const { data } = await admin.from("urc_jobs").select("id").eq("user_id", ctx.a.userId);
      return {
        ok: (data ?? []).length === 0,
        detail: `the attacker holds ${(data ?? []).length} urc job(s)`,
      };
    },
  },
];

async function forgeProposal(admin, ownerId, toolName, input, tag) {
  const { data, error } = await admin
    .from("ai_audit_log")
    .insert({
      user_id: ownerId,
      source: "mcp",
      status: "proposed",
      tool_name: toolName,
      input,
      summary: `forged ${tag} for ${toolName} (isolation probe)`,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`forge ${toolName}: ${error?.message ?? "insert failed"}`);
  return data.id;
}

function textOf(result) {
  return (result?.content ?? [])
    .map((c) => (typeof c?.text === "string" ? c.text : ""))
    .join(" ");
}

export async function runForgedProposalProbe({ mcpA, ctx, reporter, scratch }) {
  reporter.section("forged proposals: the executors, driven across the boundary");
  reporter.info(
    "propose-time resolution refuses cross-tenant ids, so confirm_action's executors are",
  );
  reporter.info(
    "otherwise unreachable. Each pair forges the missing step: a CONTROL on A's own scratch",
  );
  reporter.info(
    "row that must APPLY (proving the shape reaches the executor), then the same shape",
  );
  reporter.info("aimed at B, which must be refused.");
  reporter.info("");
  reporter.info(
    "Three executors cannot succeed for a throwaway tenant, so their controls assert a",
  );
  reporter.info(
    "weaker-but-real property instead — see the outcome vocabulary at the top of this file.",
  );

  let controlsReached = 0;

  const confirmForged = async (ownerId, tool, input, tag) => {
    const proposalId = await forgeProposal(ctx.admin, ownerId, tool, input, tag);
    const result = await mcpA.callTool({
      name: "confirm_action",
      arguments: { proposalId },
    });
    return { result, text: textOf(result) };
  };

  for (const forgery of FORGERIES) {
    const outcome = forgery.outcome ?? "applies";
    const gate = typeof outcome === "object" && outcome.gate ? outcome.gate : null;
    const reaches = typeof outcome === "object" && outcome.reaches ? outcome.reaches : null;

    // 1. Control — the same shape, aimed at A's own row.
    const control = await confirmForged(
      ctx.a.userId,
      forgery.tool,
      forgery.control(ctx, scratch),
      "control",
    );
    const controlVerified = await forgery.verifyControl(ctx.admin, scratch, ctx);

    let controlOk;
    let controlLabel;
    if (gate) {
      // Nothing applies; the claim is that the gate refused the CALLER, by its
      // own message, before any row was resolved.
      controlOk = control.result.isError === true && gate.test(control.text);
      controlLabel = `CONTROL ${forgery.tool}: refused by the caller's own gate, not by anything in the stored input`;
    } else if (reaches) {
      // The control must fail, but with the message that only exists past the
      // resolution step. Anything else means the shape never got that far.
      controlOk =
        control.result.isError === true && reaches.test(control.text) && controlVerified.ok;
      controlLabel = `CONTROL ${forgery.tool}: the forged shape resolves A's own row and fails only after it`;
    } else {
      controlOk = control.result.isError !== true && controlVerified.ok;
      controlLabel = `CONTROL ${forgery.tool}: the forged shape reaches the executor and applies to A's own row`;
    }

    reporter.check(
      controlLabel,
      controlOk,
      `isError=${control.result.isError} ${controlVerified.detail} ${control.text.slice(0, 120)}`,
    );
    if (controlOk) controlsReached += 1;
    else {
      reporter.fail(
        `${forgery.tool}: the refusal below proves nothing — the forged shape never reached the executor`,
        "the resolved-op shape has probably drifted from the executor's validator",
      );
    }

    // 2. Victim — the same shape, aimed at B. Must be refused, B untouched.
    const victim = await confirmForged(
      ctx.a.userId,
      forgery.tool,
      forgery.victim(ctx),
      "victim",
    );
    reporter.check(
      `${forgery.tool} executor refuses to ${forgery.what}`,
      victim.result.isError === true,
      victim.text.slice(0, 160),
    );

    if (gate) {
      reporter.check(
        `${forgery.tool}'s refusal comes from the caller gate, whatever the stored input says`,
        gate.test(victim.text),
        victim.text.slice(0, 160),
      );
    }
    if (reaches) {
      // The whole point of `reaches`: the victim must die EARLIER than the
      // control did. Seeing the control's message here would mean the victim's
      // row resolved — a breach wearing a refusal's clothes for some later,
      // unrelated reason.
      reporter.check(
        `${forgery.tool} refuses B BEFORE the step the control reached`,
        !reaches.test(victim.text),
        victim.text.slice(0, 160),
      );
    }
    if (forgery.victimError) {
      reporter.check(
        `${forgery.tool}'s refusal is an ownership refusal, not an unrelated one`,
        forgery.victimError.test(victim.text),
        victim.text.slice(0, 160),
      );
    }

    const victimVerified = await forgery.verifyVictim(ctx.admin, ctx);
    reporter.check(
      `B's row survived the forged ${forgery.tool}`,
      victimVerified.ok,
      victimVerified.detail,
    );
  }

  reporter.check(
    `every executor's control reached its executor (${controlsReached}/${FORGERIES.length})`,
    controlsReached === FORGERIES.length,
    `${FORGERIES.length - controlsReached} executor(s) were never actually reached`,
  );

  return { controlsApplied: controlsReached, total: FORGERIES.length };
}
