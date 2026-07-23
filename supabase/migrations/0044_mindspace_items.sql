-- Mindspace M2 (docs/mindspace-plan.md): persisted classifications and the
-- reflective-observation layer. mindspace_items caches the LLM verdict per
-- trace — salience (the "weight on mind" half of the score) and labels — keyed
-- by (user, source, source_ref) so the read path can merge cached verdicts
-- over freshly gathered items. No trace text is persisted: classification
-- happens in-process against gathered content, so Postgres holds only numbers,
-- titles, and refs. taxonomy_hash marks which taxonomy a verdict was made
-- against; a mismatch means the item re-classifies on the next pass.

create table public.mindspace_items (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  source        text not null check (source in
                  ('capture', 'journal', 'note', 'task', 'ai_chat', 'daily_log', 'spend', 'event')),
  source_ref    text not null,
  occurred_at   timestamptz not null,
  mass          numeric not null check (mass >= 0),
  word_count    int,
  title         text,
  salience      smallint not null default 1 check (salience between 0 and 3),
  valence       smallint check (valence between -2 and 2),
  taxonomy_hash text,
  model_version text,
  classified_at timestamptz,
  created_at    timestamptz not null default now(),
  unique (user_id, source, source_ref)
);

create index mindspace_items_user_occurred_idx
  on public.mindspace_items (user_id, occurred_at desc);

create table public.mindspace_labels (
  item_id    uuid not null references public.mindspace_items (id) on delete cascade,
  topic_id   uuid not null references public.mindspace_topics (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  weight     numeric not null check (weight > 0 and weight <= 1),
  created_at timestamptz not null default now(),
  primary key (item_id, topic_id)
);

create index mindspace_labels_user_idx on public.mindspace_labels (user_id);

create table public.mindspace_observations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  topic_id    uuid references public.mindspace_topics (id) on delete cascade,
  window_days int not null,
  text        text not null,
  created_at  timestamptz not null default now()
);

create index mindspace_observations_user_idx
  on public.mindspace_observations (user_id, created_at desc);

alter table public.mindspace_items enable row level security;
alter table public.mindspace_labels enable row level security;
alter table public.mindspace_observations enable row level security;

create policy "mindspace_items_select_own" on public.mindspace_items
  for select using (auth.uid() = user_id);
create policy "mindspace_items_insert_own" on public.mindspace_items
  for insert with check (auth.uid() = user_id);
create policy "mindspace_items_update_own" on public.mindspace_items
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "mindspace_items_delete_own" on public.mindspace_items
  for delete using (auth.uid() = user_id);

create policy "mindspace_labels_select_own" on public.mindspace_labels
  for select using (auth.uid() = user_id);
create policy "mindspace_labels_insert_own" on public.mindspace_labels
  for insert with check (auth.uid() = user_id);
create policy "mindspace_labels_update_own" on public.mindspace_labels
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "mindspace_labels_delete_own" on public.mindspace_labels
  for delete using (auth.uid() = user_id);

create policy "mindspace_observations_select_own" on public.mindspace_observations
  for select using (auth.uid() = user_id);
create policy "mindspace_observations_insert_own" on public.mindspace_observations
  for insert with check (auth.uid() = user_id);
create policy "mindspace_observations_update_own" on public.mindspace_observations
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "mindspace_observations_delete_own" on public.mindspace_observations
  for delete using (auth.uid() = user_id);
