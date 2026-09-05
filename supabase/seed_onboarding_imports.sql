-- ============================================================================
-- Bubaly · SEED — Onboarding calendar imports (500 records).
-- Fills onboarding_imports so the value-first first-run (T1) can be tested at
-- volume: every source, a spread of event/conflict/action counts, and a computed
-- brief summary per row. Idempotent via brief->>'seed' = 'onboard'; resolves the
-- family by email. Where: Supabase → SQL Editor → paste → Run.
-- (Needs migration 0138 applied.)
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
  sources text[] := array['ics','paste','url','demo'];
begin
  if to_regclass('public.onboarding_imports') is null then
    raise notice 'onboarding_imports not present — apply migration 0138 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  delete from public.onboarding_imports where family_id = v_family and brief->>'seed' = 'onboard';

  insert into public.onboarding_imports
    (family_id, source, event_count, today_count, conflict_count, action_count, time_saved_minutes, brief, created_at)
  select
    v_family,
    sources[1 + (g.i % 4)],
    ev,
    td,
    cf,
    act,
    saved,
    jsonb_build_object(
      'seed', 'onboard',
      'headline', 'Here''s your week — ' || td || ' today, ' || cf || ' clash' || case when cf = 1 then '' else 'es' end || ' to resolve.',
      'todayCount', td,
      'weekCount', ev,
      'conflictCount', cf,
      'actionCount', act,
      'timeSavedMinutes', saved,
      'opportunities', jsonb_build_array(
        jsonb_build_object('label', (ev/4) || ' recurring events on autopilot', 'minutes', (ev/4)*5),
        jsonb_build_object('label', cf || ' clashes caught for you', 'minutes', cf*15)
      )
    ),
    now() - ((g.i) || ' hours')::interval
  from generate_series(1, n) g(i)
  cross join lateral (
    select
      (20 + (g.i * 7) % 280)          as ev,
      (g.i % 9)                       as td,
      (g.i % 5)                       as cf,
      (g.i % 7)                       as act,
      ((g.i % 5) * 15 + ((20 + (g.i * 7) % 280) / 4) * 5) as saved
  ) d;

  raise notice 'Onboarding imports seeded 500 rows for family %', v_family;
end $$;

-- Verify:
--   select count(*) from onboarding_imports where brief->>'seed'='onboard';   -- 500
--   select source, count(*) from onboarding_imports group by source;
