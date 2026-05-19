create table public.google_tokens (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null unique references auth.users (id) on delete cascade,
  access_token   text not null,
  refresh_token  text not null,
  expires_at     timestamptz not null,
  scopes         text not null,
  updated_at     timestamptz not null default now()
);

create index google_tokens_user_id_idx on public.google_tokens (user_id);

alter table public.google_tokens enable row level security;

create policy "google_tokens_select_own"
  on public.google_tokens for select
  using (auth.uid() = user_id);

create policy "google_tokens_insert_own"
  on public.google_tokens for insert
  with check (auth.uid() = user_id);

create policy "google_tokens_update_own"
  on public.google_tokens for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "google_tokens_delete_own"
  on public.google_tokens for delete
  using (auth.uid() = user_id);
