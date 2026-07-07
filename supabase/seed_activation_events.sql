-- ============================================================================
-- seed_activation_events.sql — ≥500 records to fully exercise T10
-- (TTFV / activation telemetry). Activation is CROSS-family (one cohort per new
-- family / sign-up run), so this seeds ~220 synthetic cohorts with a realistic
-- funnel to first value: everyone signs up, ~85% import a calendar, ~70% see a
-- first briefing, ~65% activate (view a first outcome) with a spread of TTFV
-- times (minutes for most, a multi-day slow tail), and ~40% make a first capture.
--
-- IDEMPOTENT: every seeded row has session_id like 'seed-t10-%' and is deleted
-- before re-insert. Rows carry family_id = null (pre/at-signup cohorts) and are
-- read only by the super-admin funnel via the service role. Safe to re-run.
--
-- VOLUME: ~790 rows across 220 cohorts.
--
-- HOW TO RUN: paste into the Supabase SQL editor, Run, then open (as a super
-- admin) /dashboard/onboarding-funnel → the "Time to First Value" panel.
-- ============================================================================

do $$
declare
  v_email text := 'newworldventurellc@gmail.com';
  v_uid   uuid;
begin
  select id into v_uid from auth.users where lower(email) = lower(v_email) limit 1;

  -- ── clean prior seed ─────────────────────────────────────────────────────
  delete from public.activation_events where session_id like 'seed-t10-%';

  insert into public.activation_events
    (user_id, family_id, session_id, milestone, session_index, ms_since_signup, created_at)
  select
    v_uid, null,
    'seed-t10-fam-' || c,
    m.milestone, m.session_index, m.ms,
    now() - make_interval(days => (c % 45), mins => (c * 13) % 1440)
  from generate_series(1, 220) as c
  cross join lateral (
    values
      -- every cohort signs up (TTFV clock t0)
      ('signup',               1,                                            0,                                                                 true),
      -- ~85% import a calendar; ~20% of those do it in a later session
      ('calendar_imported',    case when (c * 7) % 10 < 2 then 2 else 1 end,
                               case when (c * 7) % 10 < 2 then 3 * 86400000 else (5 + (c % 55)) * 60000 end,
                               (c % 100) < 85),
      -- ~70% see a first briefing (mostly session 1)
      ('first_brief_viewed',   case when c % 8 = 0 then 2 else 1 end,        (2 + (c % 90)) * 60000,                                            (c % 100) < 70),
      -- ~65% activate: TTFV = minutes for most, a multi-day slow tail
      ('first_outcome_viewed', case when c % 9 = 0 then 2 else 1 end,
                               case when c % 10 = 0 then (1 + (c % 3)) * 86400000 else (2 + (c % 40)) * 60000 end,
                               (c % 100) < 65),
      -- ~40% make a first capture
      ('first_capture',        1,                                            (10 + (c % 120)) * 60000,                                          (c % 100) < 40)
  ) as m(milestone, session_index, ms, include)
  where m.include;

  raise notice 'T10 activation seed complete (~790 rows across 220 cohorts).';
end $$;

-- ── Verify: cohort/activation counts + session-1 spread ─────────────────────
select 'total rows' as metric, count(*)::text as value from public.activation_events where session_id like 'seed-t10-%'
union all
select 'cohorts (new families)', count(distinct session_id)::text from public.activation_events where session_id like 'seed-t10-%'
union all
select 'activated (first outcome)', count(distinct session_id)::text from public.activation_events where session_id like 'seed-t10-%' and milestone = 'first_outcome_viewed'
union all
select 'calendar imported · session 1', count(distinct session_id)::text from public.activation_events where session_id like 'seed-t10-%' and milestone = 'calendar_imported' and session_index = 1
union all
select 'median TTFV (min)', (percentile_cont(0.5) within group (order by ms_since_signup) / 60000.0)::numeric(10,1)::text
  from public.activation_events where session_id like 'seed-t10-%' and milestone = 'first_outcome_viewed'
order by metric;
