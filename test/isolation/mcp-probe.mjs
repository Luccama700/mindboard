// Drives the attack table in ./tool-matrix.mjs against a running MCP server as
// tenant A, then reports coverage against the server's live tools/list.

import { leakNeedles, scanForLeak, stringLeaves, toolJson, toolText } from "./harness.mjs";
import { BLIND_SPOTS, DECLARED_SKIPS, TOOL_MATRIX } from "./tool-matrix.mjs";

async function callTool(client, name, args) {
  try {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError === true, json: toolJson(result), text: toolText(result) };
  } catch (e) {
    // A protocol-level rejection is still a refusal — record it as one.
    const message = e instanceof Error ? e.message : String(e);
    return { isError: true, json: null, text: message, threw: true };
  }
}

export async function runToolMatrix({ mcpA, ctx, reporter }) {
  const needles = leakNeedles({ ...ctx.b, userId: ctx.b.userId });
  const exercised = new Map();
  const proposalsToCancel = [];

  reporter.section(`mcp attack sweep: A's token, B's ids and names (${TOOL_MATRIX.length} calls)`);

  for (const entry of TOOL_MATRIX) {
    if (entry.skip) {
      exercised.set(entry.tool, exercised.get(entry.tool) ?? { calls: 0, skip: entry.skip });
      continue;
    }

    const args = entry.args(ctx);
    const sent = stringLeaves(args);
    const label = `${entry.tool}: ${entry.attack}`;

    let response;
    try {
      response = await callTool(mcpA, entry.tool, args);
    } catch (e) {
      reporter.fail(label, e instanceof Error ? e.message : String(e));
      continue;
    }

    // Every response, always: did A get handed anything of B's that A did not
    // already supply in the request?
    const leaked = scanForLeak(response.text, needles, sent);
    reporter.check(`${entry.tool}: response discloses nothing of B's`, leaked.length === 0, leaked.join(", "));

    // Propose tools that legitimately succeed for A leave a pending proposal.
    // `confirm: true` entries push it all the way through so the write path —
    // not just the resolution step — is exercised across the boundary.
    if (typeof response.json?.proposalId === "string") {
      if (entry.confirm) {
        const confirmed = await callTool(mcpA, "confirm_action", {
          proposalId: response.json.proposalId,
        });
        response.confirmFailed = confirmed.isError === true;
        response.confirmText = confirmed.text;
        const confirmLeak = scanForLeak(confirmed.text, needles, sent);
        reporter.check(
          `${entry.tool}: confirm discloses nothing of B's`,
          confirmLeak.length === 0,
          confirmLeak.join(", "),
        );
      } else {
        proposalsToCancel.push(response.json.proposalId);
      }
    }

    try {
      await entry.assert(response, ctx, (l, ok, detail) => reporter.check(l, ok, detail));
    } catch (e) {
      reporter.fail(label, e instanceof Error ? e.message : String(e));
    }

    const seen = exercised.get(entry.tool) ?? { calls: 0, attacks: [] };
    seen.calls += 1;
    (seen.attacks ??= []).push(entry.attack);
    exercised.set(entry.tool, seen);
  }

  // Leave no pending proposals of A's behind.
  for (const proposalId of proposalsToCancel) {
    await callTool(mcpA, "cancel_action", { proposalId });
  }

  return exercised;
}

export async function reportCoverage({ mcpA, exercised, reporter }) {
  const listed = await mcpA.listTools();
  const live = (listed?.tools ?? []).map((t) => t.name).sort();

  reporter.section(`tool coverage (${live.length} tools registered on the live server)`);

  const uncovered = [];
  for (const name of live) {
    const seen = exercised.get(name);
    if (!seen || (seen.calls ?? 0) === 0) {
      const reason = seen?.skip ?? DECLARED_SKIPS[name];
      if (reason) {
        console.log(`  SKIP  ${name.padEnd(28)} ${reason}`);
      } else {
        console.log(`  ----  ${name.padEnd(28)} NOT EXERCISED — no matrix entry`);
        uncovered.push(name);
      }
      continue;
    }
    const attacks = seen.attacks ?? [];
    const mark = BLIND_SPOTS[name] ? "weak" : "ok  ";
    console.log(`  ${mark}  ${name.padEnd(28)} ${attacks.length} call(s): ${attacks[0]}`);
    for (const extra of attacks.slice(1)) {
      console.log(`        ${"".padEnd(28)} ${extra}`);
    }
    if (BLIND_SPOTS[name]) {
      console.log(`        ${"".padEnd(28)} ^ BLIND SPOT: ${BLIND_SPOTS[name]}`);
    }
  }

  const stale = [...exercised.keys()].filter((name) => !live.includes(name)).sort();

  reporter.check(
    "every registered tool has an attack-table entry",
    uncovered.length === 0,
    uncovered.join(", "),
  );
  reporter.check(
    "the attack table names no tool the server does not register",
    stale.length === 0,
    stale.join(", "),
  );

  const weak = live.filter((name) => BLIND_SPOTS[name]);
  reporter.info("");
  reporter.info(
    `${live.length - weak.length}/${live.length} tools are asserted on a real data path.`,
  );
  reporter.info(
    `${weak.length} are marked 'weak' above: they pass because a precondition is missing`,
  );
  reporter.info(
    "(no Google token / vault row / API key / worker allowlisting), so a scoping bug",
  );
  reporter.info("inside them would NOT turn this probe red. See BLIND_SPOTS in tool-matrix.mjs.");

  return { live, uncovered, stale, weak };
}
