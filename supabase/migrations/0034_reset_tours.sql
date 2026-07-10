-- One-shot onboarding reset: the tours were reworked to cover the shopping
-- list, grocery forecast, spend limits, dock rework, auto sort, and fixed
-- monthly income, and everyone should see them (and the updated intro) again.
-- Paired with the client-side mirror-key bump to mb-completed-tours-v2.
update public.user_settings set completed_tours = '{}'::jsonb;
