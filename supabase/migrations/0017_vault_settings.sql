-- Per-user vault connection for /brain: each user stores their own GitHub
-- fine-grained PAT + repo, mirroring the google_tokens pattern (0002).
create table public.vault_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  github_token text not null,
  repo text not null,
  branch text not null default 'main',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.vault_settings enable row level security;

create policy vault_settings_select_own on public.vault_settings
  for select using (auth.uid() = user_id);

create policy vault_settings_insert_own on public.vault_settings
  for insert with check (auth.uid() = user_id);

create policy vault_settings_update_own on public.vault_settings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy vault_settings_delete_own on public.vault_settings
  for delete using (auth.uid() = user_id);
