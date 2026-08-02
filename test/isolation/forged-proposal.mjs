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
  s.recurringTaskId = await one("recurring_tasks", {
    user_id: userId,
    title: `${marker}-ctl-habit`,
    frequency: "daily",
  });
  // 'overall' scope so it cannot collide with the tenant's category-scoped limit.
  s.spendLimitId = await one("spend_limits", {
    user_id: userId,
    scope: "overall",
    period: "monthly",
    amount: 500,
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

  let controlsApplied = 0;

  for (const forgery of FORGERIES) {
    // 1. Control — same shape, A's own row. Must reach the executor and apply.
    const controlId = await forgeProposal(
      ctx.admin,
      ctx.a.userId,
      forgery.tool,
      forgery.control(ctx, scratch),
      "control",
    );
    const controlResult = await mcpA.callTool({
      name: "confirm_action",
      arguments: { proposalId: controlId },
    });
    const controlVerified = await forgery.verifyControl(ctx.admin, scratch);
    const controlOk = controlResult.isError !== true && controlVerified.ok;
    reporter.check(
      `CONTROL ${forgery.tool}: the forged shape reaches the executor and applies to A's own row`,
      controlOk,
      `isError=${controlResult.isError} ${controlVerified.detail} ${textOf(controlResult).slice(0, 100)}`,
    );
    if (controlOk) controlsApplied += 1;
    else {
      reporter.fail(
        `${forgery.tool}: the refusal below proves nothing — the forged shape never reached the executor`,
        "the resolved-op shape has probably drifted from the executor's validator",
      );
    }

    // 2. Victim — same shape, B's row. Must be refused, and B must be untouched.
    const victimId = await forgeProposal(
      ctx.admin,
      ctx.a.userId,
      forgery.tool,
      forgery.victim(ctx),
      "victim",
    );
    const victimResult = await mcpA.callTool({
      name: "confirm_action",
      arguments: { proposalId: victimId },
    });
    reporter.check(
      `${forgery.tool} executor refuses to ${forgery.what}`,
      victimResult.isError === true,
      textOf(victimResult).slice(0, 140),
    );
    const victimVerified = await forgery.verifyVictim(ctx.admin, ctx);
    reporter.check(
      `B's row survived the forged ${forgery.tool}`,
      victimVerified.ok,
      victimVerified.detail,
    );
  }

  reporter.check(
    `every executor's control applied (${controlsApplied}/${FORGERIES.length})`,
    controlsApplied === FORGERIES.length,
    `${FORGERIES.length - controlsApplied} executor(s) were never actually reached`,
  );

  return { controlsApplied, total: FORGERIES.length };
}
