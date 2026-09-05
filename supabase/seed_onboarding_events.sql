-- ============================================================================
-- Bubaly · SEED — Onboarding funnel (onboarding_events, ~550 across 250 sessions).
-- Realistic drop-off so /dashboard/onboarding-funnel can be tested: every session
-- reaches 'profile', ~70% reach 'pin', ~50% complete 'done'. Not family-scoped
-- (pre-family telemetry). Idempotent via meta->>'seed' = 'onboarding'.
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migration 0133 applied.)
-- ============================================================================
do $$
declare
  n_sessions int := 250;
begin
  delete from public.onboarding_events where meta->>'seed' = 'onboarding';

  -- Step 1: profile — every session starts here.
  insert into public.onboarding_events (user_id, session_id, step, phase, duration_ms, meta)
  select null, 'seed-ob-' || g.i, 'profile', 'started', 0, '{"seed":"onboarding"}'::jsonb
  from generate_series(1, n_sessions) as g(i);

  -- Step 2: pin — ~70% of sessions advance.
  insert into public.onboarding_events (user_id, session_id, step, phase, duration_ms, meta)
  select null, 'seed-ob-' || g.i, 'pin', 'step', (3000 + floor(random()*12000))::int, '{"seed":"onboarding"}'::jsonb
  from generate_series(1, n_sessions) as g(i)
  where (g.i % 10) < 7;

  -- Step 3: done — ~50% complete.
  insert into public.onboarding_events (user_id, session_id, step, phase, duration_ms, meta)
  select null, 'seed-ob-' || g.i, 'done', 'completed', (8000 + floor(random()*32000))::int, '{"seed":"onboarding"}'::jsonb
  from generate_series(1, n_sessions) as g(i)
  where (g.i % 10) < 5;

  raise notice 'Onboarding funnel seeded for % sessions', n_sessions;
end $$;

-- Verify:
--   select step, count(*) from onboarding_events where meta->>'seed'='onboarding' group by step;
--   select count(distinct session_id) from onboarding_events where meta->>'seed'='onboarding';
