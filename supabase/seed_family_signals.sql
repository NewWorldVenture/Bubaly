-- ============================================================================
-- FamilyOS · SEED — Family signals (500 records).
-- Fills family_signals so Family Intelligence (R10) can be tested at volume: all
-- four hard-signal kinds, each with realistic evidence + a spread of statuses
-- (active/acknowledged/dismissed). Idempotent via evidence->>'seed' = 'r10';
-- resolves the family by email. (Needs migration 0142 applied.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
  kinds    text[] := array['ignored_reminder','stress_window','chore_conflict','routine_adherence','budget_drift'];
  statuses text[] := array['active','active','active','acknowledged','dismissed'];
  rem_titles text[] := array['Take out trash','Water plants','Pack lunches','Refill prescription','Sign permission slip','Feed the cat'];
  stress_lbl text[] := array['Weekday evenings','Weekday mornings','Weekend afternoons','Weekday afternoons'];
  chores     text[] := array['Dishes','Vacuum','Walk the dog','Clean bathroom','Take out recycling'];
  routines   text[] := array['Morning routine','Bedtime routine','Homework hour','Tidy-up time'];
  bud_cats   text[] := array['Groceries','Dining out','Gas','Entertainment','Kids activities','Household'];
begin
  if to_regclass('public.family_signals') is null then
    raise notice 'family_signals not present — apply migration 0142 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  delete from public.family_signals where family_id = v_family and evidence->>'seed' = 'r10';

  insert into public.family_signals
    (family_id, kind, subject_key, title, detail, score, evidence, status, first_seen_at, last_seen_at)
  select
    v_family,
    k,
    k || ':seed-' || g.i,
    case k
      when 'ignored_reminder'   then '“' || rem_titles[1+(g.i % array_length(rem_titles,1))] || '” keeps getting missed'
      when 'stress_window'      then stress_lbl[1+(g.i % array_length(stress_lbl,1))] || ' are your crunch time'
      when 'chore_conflict'     then '“' || chores[1+(g.i % array_length(chores,1))] || '” causes friction'
      when 'budget_drift'       then 'Over budget on ' || bud_cats[1+(g.i % array_length(bud_cats,1))]
      else '“' || routines[1+(g.i % array_length(routines,1))] || '” only sticks ' || (20 + (g.i % 40)) || '% of the time'
    end,
    'Detected from your recent activity. [seed]',
    40 + (g.i % 60),
    case k
      when 'ignored_reminder'   then jsonb_build_object('seed','r10','count', 3 + (g.i % 6), 'lastAt', now())
      when 'stress_window'      then jsonb_build_object('seed','r10','events', 4 + (g.i % 8), 'conflicts', (g.i % 3), 'overdue', (g.i % 4))
      when 'chore_conflict'     then jsonb_build_object('seed','r10','rejected', 1 + (g.i % 3), 'disputed', (g.i % 3), 'members', 2 + (g.i % 3), 'total', 5 + (g.i % 10))
      when 'budget_drift'       then jsonb_build_object('seed','r10','category', bud_cats[1+(g.i % array_length(bud_cats,1))], 'period','monthly', 'limit', 200 + (g.i % 6)*50, 'spent', 200 + (g.i % 6)*50 + 30 + (g.i % 120), 'overBy', 30 + (g.i % 120), 'recurring', (g.i % 2 = 0))
      else jsonb_build_object('seed','r10','actual', 4 + (g.i % 6), 'expected', 20, 'adherencePct', 20 + (g.i % 40))
    end,
    statuses[1+(g.i % array_length(statuses,1))],
    now() - ((30 + (g.i % 60)) || ' days')::interval,
    now() - ((g.i % 14) || ' days')::interval
  from generate_series(1, n) g(i)
  cross join lateral (select kinds[1+(g.i % 5)] as k) kk
  on conflict (family_id, kind, subject_key) do nothing;

  raise notice 'Family signals seeded 500 rows for family %', v_family;
end $$;

-- Verify:
--   select count(*) from family_signals where evidence->>'seed'='r10';   -- 500
--   select kind, count(*) from family_signals group by kind;
