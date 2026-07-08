-- ============================================================================
-- mindboard flashcards (L5 of docs/education-plan.md): generated cards with
-- got-it/missed-it progress. Study artifacts (guides/FAQs) live in the vault,
-- not here — cards get a table only because progress state is operational.
-- ============================================================================

create table public.course_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  question text not null,
  answer text not null,
  explain text,
  got_count integer not null default 0,
  miss_count integer not null default 0,
  last_reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index course_cards_course_idx on public.course_cards (course_id);

alter table public.course_cards enable row level security;

create policy course_cards_select_own on public.course_cards
  for select using (auth.uid() = user_id);
create policy course_cards_insert_own on public.course_cards
  for insert with check (auth.uid() = user_id);
create policy course_cards_update_own on public.course_cards
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy course_cards_delete_own on public.course_cards
  for delete using (auth.uid() = user_id);
