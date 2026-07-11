-- ============================================================================
-- FamilyOS · SEED — Onboarding progress (500 accounts).
-- Fills onboarding_progress (migration 0159) at volume so the onboarding
-- lifecycle + marketing-signal layer can be tested across a realistic mix of
-- accounts: fully-onboarded wizard graduates, the "needs setup" auto-provisioned
-- cohort (skipped the wizard — no questionnaire/goals/marketing profile), and a
-- reset tail. Because onboarding_progress is ONE-per-account (unique user_id),
-- this seeds 500 synthetic auth.users (shared '@seed-onb.bubaly.test' domain) and
-- one progress row each — so marketing segments (value_engaged, source, status,
-- completeness) can be exercised at 500-account scale.
--
-- Realistic distribution across 500 accounts:
--   ~55% wizard + completed        (value_engaged mostly true, high completeness)
--   ~35% auto_provision + in_progress ("needs setup" — low completeness, no goals)
--   ~10% reset                     (explicitly restarted setup)
--
-- IDEMPOTENT: the synthetic users share the '@seed-onb.bubaly.test' domain and
-- their progress rows are removed (cascade) before re-insert. Resolves the family
-- by email for family_id. Degrades safely if 0159 isn't applied yet.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  goalset  text[] := array['chores','calendar','meals','groceries','budget','health','school','activities'];
  refs     text[] := array['friend','search','social','app_store','blog','other'];
begin
  if to_regclass('public.onboarding_progress') is null then
    raise notice 'onboarding_progress not present — apply migration 0159 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;

  -- Clean prior seed: delete synthetic users → onboarding_progress cascades.
  begin
    delete from auth.users where email like '%@seed-onb.bubaly.test';
  exception when others then raise notice 'skip auth.users cleanup: %', sqlerrm; end;

  -- 500 synthetic accounts.
  begin
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous)
    select gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'onb'||g||'@seed-onb.bubaly.test', crypt('Password123!', gen_salt('bf')), now(),
           now() - ((g % 120) || ' days')::interval, now(),
           '{"provider":"email","providers":["email"]}'::jsonb,
           jsonb_build_object('full_name','Onboard Test '||g), false, false
    from generate_series(1, 500) as gs(g) on conflict do nothing;
  exception when others then
    raise notice 'skip auth.users insert (cannot seed synthetic accounts): %', sqlerrm;
    return;
  end;

  -- One progress row per synthetic account, with a realistic cohort spread.
  insert into public.onboarding_progress
    (user_id, family_id, status, source, steps_completed, value_engaged, import_source,
     events_imported, time_saved_minutes, goals, referral_source,
     household_adults, household_children, members_added, members_invited, has_pin,
     marketing_opt_in, completeness, completed_at, reset_at, created_at)
  select
    u.id,
    v_family,
    c.status,
    c.source,
    c.steps,
    c.value_engaged,
    case when c.value_engaged then (array['paste','demo','ics'])[1 + (n % 3)] else null end,
    case when c.value_engaged then 8 + (n % 40) else 0 end,
    case when c.value_engaged then 15 + (n % 45) else 0 end,
    c.goals,
    case when c.source = 'wizard' then refs[1 + (n % 6)] else null end,
    case when c.source = 'wizard' then 1 + (n % 2) else null end,
    case when c.source = 'wizard' then (n % 4) else null end,
    case when c.source = 'wizard' then (n % 3) else 0 end,
    case when c.source = 'wizard' then (n % 2) else 0 end,
    c.has_pin,
    (n % 10) <> 0,                                   -- ~90% marketing opt-in
    c.completeness,
    case when c.status = 'completed' then now() - ((n % 120) || ' days')::interval else null end,
    case when c.status = 'reset' then now() - ((n % 30) || ' days')::interval else null end,
    now() - ((n % 120) || ' days')::interval
  from (
    select u.id, row_number() over (order by u.created_at, u.id) as n
    from auth.users u where u.email like '%@seed-onb.bubaly.test'
  ) u
  cross join lateral (
    select
      case when (u.n % 20) < 11 then 'completed'
           when (u.n % 20) < 18 then 'in_progress'
           else 'reset' end                                             as status,
      case when (u.n % 20) < 11 then 'wizard'
           when (u.n % 20) < 18 then 'auto_provision'
           else 'wizard' end                                           as source,
      case when (u.n % 20) < 11 then array['profile','family','value','about','members','pin']
           when (u.n % 20) < 18 then array['profile']
           else array['profile','family']::text[] end                  as steps,
      ((u.n % 20) < 11 and (u.n % 3) <> 0)                             as value_engaged,
      case when (u.n % 20) < 11 then array[goalset[1 + (u.n % 8)], goalset[1 + ((u.n + 3) % 8)]]
           else array[]::text[] end                                    as goals,
      ((u.n % 20) < 11 and (u.n % 4) = 0)                              as has_pin,
      case when (u.n % 20) < 11 then 80 + (u.n % 21)                   -- completed: 80..100
           when (u.n % 20) < 18 then 30 + (u.n % 15)                   -- needs setup: 30..44
           else 15 + (u.n % 20) end                                    as completeness
  ) c
  on conflict (user_id) do update
    set status = excluded.status, source = excluded.source,
        steps_completed = excluded.steps_completed, value_engaged = excluded.value_engaged,
        goals = excluded.goals, has_pin = excluded.has_pin, completeness = excluded.completeness,
        completed_at = excluded.completed_at, reset_at = excluded.reset_at;

  raise notice 'onboarding_progress seeded 500 accounts (family %).', v_family;
end $$;

-- Verify:
--   select count(*) from onboarding_progress op join auth.users u on u.id=op.user_id where u.email like '%@seed-onb.bubaly.test';  -- 500
--   select status, source, count(*) from onboarding_progress op join auth.users u on u.id=op.user_id where u.email like '%@seed-onb.bubaly.test' group by 1,2 order by 1,2;
--   select count(*) filter (where value_engaged) as engaged, round(avg(completeness)) as avg_score from onboarding_progress op join auth.users u on u.id=op.user_id where u.email like '%@seed-onb.bubaly.test';
