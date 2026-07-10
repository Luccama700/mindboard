-- Adds an 'executing' status to ai_audit_log so confirm_action can atomically
-- CLAIM a proposal (proposed -> executing) BEFORE running its executor, closing
-- the double-confirm race (MCP-EXEC-2) without overloading 'executed'. A row
-- reads 'executing' only while its write is in flight; the executor then flips
-- it to 'executed' (success) or 'error' (failure), so 'executed' keeps meaning
-- "finished with a result" and a mid-execution crash leaves a distinguishable
-- 'executing' row rather than a fake-completed one.
--
-- DEPLOY ORDERING: this migration MUST be applied to the database BEFORE the
-- code that writes 'executing' is deployed, or every confirm will fail the
-- CHECK constraint. (Not applied to the live DB in the bug-fix cycle — see
-- ~/Documents/agent-ops/logs/mindboard-bugs-2026-07-10.md.)

alter table public.ai_audit_log
  drop constraint if exists ai_audit_log_status_check;

alter table public.ai_audit_log
  add constraint ai_audit_log_status_check
  check (status in ('proposed', 'executing', 'executed', 'rejected', 'error'));
