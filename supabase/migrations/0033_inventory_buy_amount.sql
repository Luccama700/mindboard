-- How much of an item the user plans to buy on the next trip, in the item's
-- own tracked unit (4 cans, 6 pieces). Null = unspecified (one typical
-- package). est_price is the estimated TOTAL for that planned purchase, not a
-- per-unit price times this number — stores sell in packs that don't map 1:1
-- to tracked units, so the AI price lookup does the pack math.
alter table inventory_items
  add column buy_amount numeric check (buy_amount is null or buy_amount > 0);
