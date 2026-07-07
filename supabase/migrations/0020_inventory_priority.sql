-- Stock attention priority, mirroring task priority: high surfaces near the
-- top of the Stream when running low, med only when actually out (the old
-- behavior), low never leaves /inventory.

alter table inventory_items
  add column priority text not null default 'med'
  check (priority in ('low', 'med', 'high'));
