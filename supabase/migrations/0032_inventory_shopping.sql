-- Shopping list + estimated prices. shopping_pinned keeps an item on the
-- shopping list regardless of stock level; auto entries (out/low/running-out
-- -soon) are derived at read time, so only the pin is stored. est_price is the
-- expected cost of one purchase (pack as sold, dollars); price_source records
-- whether it came from an AI lookup or a human edit (AI never overwrites
-- 'manual'). shopping_store/shopping_day are the user's grocery store and
-- weekly shopping weekday (0 = Sunday), used to snap projected grocery spend
-- onto the finance forecast.
alter table inventory_items
  add column shopping_pinned boolean not null default false,
  add column est_price numeric check (est_price is null or est_price >= 0),
  add column price_source text check (price_source in ('ai', 'manual')),
  add column price_checked_at timestamptz;

alter table user_settings
  add column shopping_store text,
  add column shopping_day integer check (shopping_day between 0 and 6);
