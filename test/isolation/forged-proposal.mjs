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
// A CONTROL case runs first, forged the same way but pointing at A's own row.
// It must SUCCEED. Without it, every "refused" below could equally mean the
// forged input was malformed and the executor was never reached at all.

import { todayKey } from "./harness.mjs";

function forgeries(ctx) {
  return [
    {
      tool: "complete_task",
      what: "complete B's task",
      input: { taskId: ctx.b.taskId },
      verify: async (admin) => {
        const { data } = await admin
          .from("tasks")
          .select("status")
          .eq("id", ctx.b.taskId)
          .maybeSingle();
        return { ok: data?.status === "todo", detail: `status=${data?.status}` };
      },
    },
    {
      tool: "miss_task",
      what: "mark B's task missed",
      input: { taskId: ctx.b.taskId },
      verify: async (admin) => {
        const { data } = await admin
          .from("tasks")
          .select("status, missed_at")
          .eq("id", ctx.b.taskId)
          .maybeSingle();
        return { ok: data?.status === "todo" && !data?.missed_at, detail: `status=${data?.status}` };
      },
    },
    {
      tool: "update_task",
      what: "rename B's task",
      input: { taskId: ctx.b.taskId, title: "forged-rename" },
      verify: async (admin) => {
        const { data } = await admin
          .from("tasks")
          .select("title")
          .eq("id", ctx.b.taskId)
          .maybeSingle();
        return { ok: data?.title === ctx.b.taskTitle, detail: `title=${data?.title}` };
      },
    },
    {
      tool: "delete_task",
      what: "delete B's task",
      input: { taskId: ctx.b.taskId },
      verify: async (admin) => {
        const { data } = await admin.from("tasks").select("id").eq("id", ctx.b.taskId);
        return { ok: (data ?? []).length === 1, detail: `rows=${(data ?? []).length}` };
      },
    },
    {
      tool: "upsert_goal",
      what: "archive B's goal",
      input: { goalId: ctx.b.goalId, status: "archived" },
      verify: async (admin) => {
        const { data } = await admin
          .from("goals")
          .select("status")
          .eq("id", ctx.b.goalId)
          .maybeSingle();
        return { ok: data?.status === "active", detail: `status=${data?.status}` };
      },
    },
    {
      tool: "manage_group",
      what: "rename B's group",
      input: { action: "update", groupId: ctx.b.groupId, name: "forged-rename" },
      verify: async (admin) => {
        const { data } = await admin
          .from("groups")
          .select("name")
          .eq("id", ctx.b.groupId)
          .maybeSingle();
        return { ok: data?.name === ctx.b.groupName, detail: `name=${data?.name}` };
      },
    },
    {
      tool: "archive_recurring_task",
      what: "stop B's repeating task",
      input: { ruleId: ctx.b.recurringTaskId },
      verify: async (admin) => {
        const { data } = await admin
          .from("recurring_tasks")
          .select("archived")
          .eq("id", ctx.b.recurringTaskId)
          .maybeSingle();
        return { ok: data?.archived === false, detail: `archived=${data?.archived}` };
      },
    },
    {
      tool: "delete_spend_limit",
      what: "delete B's spending limit",
      input: { limitId: ctx.b.spendLimitId },
      verify: async (admin) => {
        const { data } = await admin
          .from("spend_limits")
          .select("archived")
          .eq("id", ctx.b.spendLimitId)
          .maybeSingle();
        return { ok: data?.archived === false, detail: `archived=${data?.archived}` };
      },
    },
    {
      tool: "log_spend",
      what: "write a ledger row into B's account",
      input: { accountId: ctx.b.accountId, amount: 3, categoryId: null, note: "forged" },
      verify: async (admin) => {
        const { data } = await admin
          .from("balance_changes")
          .select("id")
          .eq("account_id", ctx.b.accountId);
        return { ok: (data ?? []).length === 1, detail: `rows=${(data ?? []).length}` };
      },
    },
    {
      tool: "update_stock",
      what: "archive B's inventory item (resolved-op shape)",
      input: {
        operations: [{ kind: "archive", itemId: ctx.b.itemId, name: ctx.b.itemName }],
      },
      verify: async (admin) => {
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
    },
    {
      tool: "update_finance",
      what: "remove B's ledger row (resolved-op shape)",
      input: {
        operations: [{ kind: "remove", changeId: ctx.b.changeId, summary: "forged remove" }],
      },
      verify: async (admin) => {
        const { data } = await admin
          .from("balance_changes")
          .select("id")
          .eq("id", ctx.b.changeId);
        return { ok: (data ?? []).length === 1, detail: `rows=${(data ?? []).length}` };
      },
    },
  ];
}

async function forgeProposal(admin, ownerId, toolName, input) {
  const { data, error } = await admin
    .from("ai_audit_log")
    .insert({
      user_id: ownerId,
      source: "mcp",
      status: "proposed",
      tool_name: toolName,
      input,
      summary: `forged proposal for ${toolName} (isolation probe)`,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`forge ${toolName}: ${error?.message ?? "insert failed"}`);
  return data.id;
}

export async function runForgedProposalProbe({ mcpA, ctx, reporter }) {
  reporter.section("forged proposals: the executors, driven across the boundary");
  reporter.info(
    "propose-time resolution refuses cross-tenant ids, so confirm_action's executors are",
  );
  reporter.info(
    "otherwise unreachable. These bypass the propose step to test the executor guards directly.",
  );

  // Control: same forgery mechanism, A's own row. Must succeed, or every
  // refusal below proves nothing about isolation.
  const controlId = await forgeProposal(ctx.admin, ctx.a.userId, "complete_task", {
    taskId: ctx.a.secondTaskId,
  });
  const control = await mcpA.callTool({
    name: "confirm_action",
    arguments: { proposalId: controlId },
  });
  const { data: controlRow } = await ctx.admin
    .from("tasks")
    .select("status")
    .eq("id", ctx.a.secondTaskId)
    .maybeSingle();
  const controlWorked = control.isError !== true && controlRow?.status === "done";
  reporter.check(
    "CONTROL: a forged proposal on A's OWN row reaches the executor and applies",
    controlWorked,
    `isError=${control.isError} status=${controlRow?.status}`,
  );
  if (!controlWorked) {
    reporter.fail(
      "forged-proposal probe is not reaching the executors — the refusals below prove nothing",
    );
  }

  for (const forgery of forgeries(ctx)) {
    const proposalId = await forgeProposal(ctx.admin, ctx.a.userId, forgery.tool, forgery.input);
    const result = await mcpA.callTool({
      name: "confirm_action",
      arguments: { proposalId },
    });
    const text = (result?.content ?? [])
      .map((c) => (typeof c?.text === "string" ? c.text : ""))
      .join(" ");
    reporter.check(
      `${forgery.tool} executor refuses to ${forgery.what}`,
      result.isError === true,
      text.slice(0, 140),
    );
    const verified = await forgery.verify(ctx.admin);
    reporter.check(`B's row survived the forged ${forgery.tool}`, verified.ok, verified.detail);
  }

  // Restore the control task so the tenant snapshot comparison for A (if ever
  // added) stays meaningful, and so the run leaves no half-applied state.
  await ctx.admin
    .from("tasks")
    .update({ status: "todo", completed_at: null })
    .eq("id", ctx.a.secondTaskId)
    .eq("user_id", ctx.a.userId);

  return { today: todayKey() };
}
