-- Audit 2026-10-26 L9: database defence in depth.
--
-- 1. anon held Supabase's default table grants on every public table. No
--    policy admits anon (every policy is auth.uid() = user_id, and anon's
--    auth.uid() is null), so it read zero rows — but the grant itself was the
--    only thing between a future permissive policy and the open internet.
--    Signed-out traffic never needs table access: every page checks the
--    session before querying, and the MCP / worker / URC routes use the
--    service role. Revoke it, and stop new tables inheriting it.
--
-- 2. Every policy called bare auth.uid(), which Postgres re-evaluates per row
--    (161 auth_rls_initplan performance advisories). Wrapping it as
--    (select auth.uid()) makes it a one-time initplan; the semantics are
--    identical. This is done dynamically so it also covers policies added by
--    other migrations in this batch and skips ones that earlier migrations
--    dropped (0056 jobs, 0060 ai_audit_log).

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;

do $$
declare
  p record;
  new_qual text;
  new_check text;
  stmt text;
begin
  for p in
    select schemaname, tablename, policyname, qual, with_check
      from pg_policies
     where schemaname = 'public'
       and (
         (qual is not null and qual ~ 'auth\.uid\(\)' and qual !~ 'SELECT auth\.uid\(\)')
         or (with_check is not null and with_check ~ 'auth\.uid\(\)' and with_check !~ 'SELECT auth\.uid\(\)')
       )
  loop
    new_qual := case
      when p.qual is null then null
      else regexp_replace(p.qual, 'auth\.uid\(\)', '(select auth.uid())', 'g')
    end;
    new_check := case
      when p.with_check is null then null
      else regexp_replace(p.with_check, 'auth\.uid\(\)', '(select auth.uid())', 'g')
    end;
    stmt := format('alter policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
    if new_qual is not null then
      stmt := stmt || format(' using (%s)', new_qual);
    end if;
    if new_check is not null then
      stmt := stmt || format(' with check (%s)', new_check);
    end if;
    execute stmt;
  end loop;
end
$$;
