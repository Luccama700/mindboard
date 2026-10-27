-- ai_audit_log is written by the server only (audit 2026-10-26, finding M7:
-- "service-role code trusts rows that RLS lets clients rewrite").
--
-- 0014 gave the table the same four own-row policies as ordinary user data.
-- But an audit row is not user data: it IS the proposal state, and the
-- service-role code that executes a confirm reads its tool_name, its input and
-- its created_at back out. With insert/update/delete, a signed-in user could:
--
--   * flip an 'executed' row back to 'proposed' and replay the write it
--     describes (confirm_action guards on status='proposed', and that guard was
--     the only thing standing between one approval and N applications);
--   * rewrite created_at to defeat spawn_urc's five-minute proposal-age check
--     (app/lib/urc/jobs.ts), stretching a stale approval into a live one;
--   * hand-write a 'proposed' row whose input never met a propose-time
--     validator -- the reason EXECUTORS.spawn_urc re-derives everything from
--     server state and executeUpdateTask re-runs validateUpdateTask;
--   * delete the record of a write that happened.
--
-- None of it is cross-tenant (every load, claim and resolve filters the
-- caller), which is why this is M and not H. It is still a user rewriting their
-- own security log.
--
-- SELECT stays: /approvals, /plan, the dashboard's pending count and
-- list_proposals all read the user's own rows with the cookie client.
--
-- Every writer already runs on the service client, which bypasses RLS, so
-- dropping these changes no application behavior: app/lib/mcp/audit.ts (the
-- store behind every propose/claim/resolve/finalize on every surface) and
-- app/lib/watch/writes.ts (its own idempotency-ledger statements) both open
-- createServiceClient() and filter by user_id explicitly. The code is correct
-- with or without this migration applied.

drop policy if exists "ai_audit_log_insert_own" on public.ai_audit_log;
drop policy if exists "ai_audit_log_update_own" on public.ai_audit_log;
drop policy if exists "ai_audit_log_delete_own" on public.ai_audit_log;

-- Left in place, unchanged, so a user can still read their own audit trail:
--   ai_audit_log_select_own ... for select using (auth.uid() = user_id)
