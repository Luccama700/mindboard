-- Inventory item lifecycle: "stop tracking" archives instead of deleting.
-- archived items are hidden from the page, vitals, projections, and MCP reads;
-- last_restocked_at powers the "sitting at zero since…" archive suggestion.

alter table inventory_items
  add column archived boolean not null default false,
  add column archived_at timestamptz,
  add column last_restocked_at timestamptz;

create index inventory_items_active_idx
  on inventory_items (user_id)
  where not archived;
