-- ============================================================================
-- FamilyOS · SEED — Moment activations (500 records).
-- Fills moment_activations so the Moments organizing layer (R12) can be tested at
-- volume and its engagement history renders: every moment × ~50 days with a spread
-- of statuses (active/engaged/dismissed). Idempotent via reason like '%[seed]%';
-- resolves the family by email. (Needs migration 0148 applied.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
  keys     text[] := array['morning','school','dinner','homework','bedtime','weekend','vacation','birthday','holiday','emergency'];
  statuses text[] := array['active','active','engaged','engaged','dismissed'];
  reasons  text[] := array['Weekday morning','School hours','Around dinnertime','Due tomorrow','Evening wind-down','It''s the weekend','A trip is coming','A birthday is near','A holiday is near','Always one tap away'];
begin
  if to_regclass('public.moment_activations') is null then
    raise notice 'moment_activations not present — apply migration 0148 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  delete from public.moment_activations where family_id = v_family and reason like '%[seed]%';

  -- key index = i % 10, day = floor(i/10) → each (moment, day) pair unique across 500.
  insert into public.moment_activations
    (family_id, moment_key, as_of_date, status, reason, priority, created_at)
  select
    v_family,
    keys[1+(g.i % 10)],
    (current_date - (g.i / 10)),
    statuses[1+(g.i % array_length(statuses,1))],
    reasons[1+(g.i % 10)] || ' [seed]',
    100 - (g.i % 100),
    now() - ((g.i) || ' hours')::interval
  from generate_series(0, n - 1) g(i)
  on conflict (family_id, moment_key, as_of_date) do nothing;

  raise notice 'Moment activations seeded 500 rows for family %', v_family;
end $$;

-- Verify:
--   select count(*) from moment_activations where reason like '%[seed]%';   -- 500
--   select moment_key, count(*) from moment_activations group by moment_key order by 2 desc;
