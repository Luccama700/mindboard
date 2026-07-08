-- Audio overviews gain a single-narrator format: flavor 'solo' is a straight
-- lecture read by one host, alongside the two-host deep-dive/brief/debate.
alter table public.audio_episodes
  drop constraint audio_episodes_flavor_check;

alter table public.audio_episodes
  add constraint audio_episodes_flavor_check
  check (flavor in ('deep-dive', 'brief', 'debate', 'solo'));
