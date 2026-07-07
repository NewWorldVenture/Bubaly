-- ============================================================================
-- FamilyOS · SEED — Home briefs (500 daily snapshots).
-- Fills home_briefs so the outcome-first home (T3) can be tested at volume and its
-- readiness trend renders: one snapshot per day for 500 days, readiness climbing
-- over time (early days sparse → recent days set up). Idempotent: upserts on
-- (family_id, as_of_date). Resolves the family by email.
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migration 0140 applied.)
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
begin
  if to_regclass('public.home_briefs') is null then
    raise notice 'home_briefs not present — apply migration 0140 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  insert into public.home_briefs
    (family_id, as_of_date, is_sparse, readiness_pct, week_count, conflict_count, dinner_count, time_saved_minutes, headline, brief)
  select
    v_family,
    (current_date - g.i),
    ready < 40,
    ready,
    wk,
    cf,
    3,
    saved,
    case when ready < 40
      then 'Let''s make this week easier — a few quick wins to set up.'
      else 'You''re in good shape — ' || wk || ' events this week and nothing urgent.' end,
    jsonb_build_object(
      'seed', 'home',
      'headline', 'Day -' || g.i || ' snapshot',
      'readinessPct', ready,
      'isSparse', ready < 40,
      'weekCount', wk,
      'conflictCount', cf,
      'dinnerCount', 3,
      'timeSavedMinutes', saved,
      'steps', jsonb_build_array(
        jsonb_build_object('id','calendar','done', wk > 0),
        jsonb_build_object('id','meals','done', false),
        jsonb_build_object('id','family','done', ready >= 40)
      )
    )
  from generate_series(0, n - 1) g(i)
  cross join lateral (
    -- Readiness climbs as days get more recent (i=0 today = highest).
    select
      least(100, greatest(0, 100 - (g.i / 6)))                 as ready,
      (g.i % 9)                                                 as wk,
      (g.i % 4)                                                 as cf,
      (20 + (g.i * 7) % 120)                                    as saved
  ) d
  on conflict (family_id, as_of_date) do update
    set is_sparse = excluded.is_sparse, readiness_pct = excluded.readiness_pct,
        week_count = excluded.week_count, conflict_count = excluded.conflict_count,
        dinner_count = excluded.dinner_count, time_saved_minutes = excluded.time_saved_minutes,
        headline = excluded.headline, brief = excluded.brief;

  raise notice 'Home briefs seeded 500 daily snapshots for family %', v_family;
end $$;

-- Verify:
--   select count(*) from home_briefs where brief->>'seed'='home';   -- 500
--   select min(readiness_pct), max(readiness_pct) from home_briefs;
