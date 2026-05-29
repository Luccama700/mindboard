-- ============================================================================
-- mindboard inventory item icons
-- adds inventory_items.image_url and a user-scoped public storage bucket.
-- ============================================================================

alter table public.inventory_items add column image_url text;

-- public bucket so icons can be served via <img src> by URL.
insert into storage.buckets (id, name, public)
values ('inventory-icons', 'inventory-icons', true)
on conflict (id) do nothing;

-- writes are scoped to the user's own folder: {user_id}/...
create policy "inventory_icons_insert_own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'inventory-icons'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "inventory_icons_update_own"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'inventory-icons'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "inventory_icons_delete_own"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'inventory-icons'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "inventory_icons_read_public"
  on storage.objects for select
  using (bucket_id = 'inventory-icons');
