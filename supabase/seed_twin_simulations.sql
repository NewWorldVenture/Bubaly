-- ============================================================================
-- Bubaly · SEED — Twin simulations (500 records).
-- Fills twin_simulations so the Digital Twin activity projection (R8) can be
-- tested at volume: saved "what-if" scenarios spanning verdicts + weekly-hour
-- loads, each with a per-dimension breakdown. Idempotent via input->>'seed'='r8';
-- resolves the family by email. (Needs migration 0147 applied.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_member uuid;
  n int := 500;
  acts     text[] := array['Travel Soccer','Club Swim','Youth Orchestra','Robotics Team','Ballet','Chess Club','Scouts','Basketball','Debate Team','Art Class'];
  verdicts text[] := array['clear','clear','tight','tight','conflict'];
begin
  if to_regclass('public.twin_simulations') is null then
    raise notice 'twin_simulations not present — apply migration 0147 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select id into v_member from public.family_members where family_id = v_family order by created_at limit 1;

  delete from public.twin_simulations where family_id = v_family and input->>'seed' = 'r8';

  insert into public.twin_simulations
    (family_id, member_id, activity_name, verdict, weekly_hours, input, dimensions, created_at)
  select
    v_family, v_member,
    acts[1+(g.i % array_length(acts,1))] || ' #' || g.i,
    verdicts[1+(g.i % array_length(verdicts,1))],
    round((2 + (g.i % 10) + (g.i % 3) * 0.5)::numeric, 1),
    jsonb_build_object('seed','r8','activityName', acts[1+(g.i % array_length(acts,1))],
      'sessionsPerWeek', 1 + (g.i % 4), 'weeks', 6 + (g.i % 20), 'travelMinEach', (g.i % 6) * 10),
    jsonb_build_array(
      jsonb_build_object('key','schedule','label','Schedule','severity', (array['ok','caution','blocker'])[1+(g.i % 3)], 'headline','Fits — sessions added'),
      jsonb_build_object('key','travel','label','Travel','severity', (array['ok','caution'])[1+(g.i % 2)], 'headline', ((g.i % 4)+1) || ' round trips/week'),
      jsonb_build_object('key','family_time','label','Family time','severity', (array['ok','caution','blocker'])[1+(g.i % 3)], 'headline','≈ ' || (2+(g.i%10)) || 'h a week'),
      jsonb_build_object('key','cost','label','Cost','severity', (array['ok','caution','blocker'])[1+(g.i % 3)], 'headline','Within budget')
    ),
    now() - ((g.i) || ' hours')::interval
  from generate_series(1, n) g(i);

  raise notice 'Twin simulations seeded 500 rows for family %', v_family;
end $$;

-- Verify:
--   select count(*) from twin_simulations where input->>'seed'='r8';   -- 500
--   select verdict, count(*) from twin_simulations group by verdict;
