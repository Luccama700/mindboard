alter table public.user_settings
  add column mcp_token_hash text;

create unique index user_settings_mcp_token_idx
  on public.user_settings (mcp_token_hash)
  where mcp_token_hash is not null;

alter table public.ai_audit_log
  add column source text not null default 'assistant'
  check (source in ('assistant', 'mcp'));
