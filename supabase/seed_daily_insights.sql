-- ============================================================================
-- FamilyOS · SEED — Daily insights (500 records).
-- Fills daily_insights so the "insight of the day" (T4) can be tested at volume:
-- every kind across ~56 days, with a spread of statuses (active/dismissed/acted).
-- Idempotent: clears its own '[seed:insight]' rows first, then inserts (never
-- clobbers a real insight on the unique key). Resolves the family by email.
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migration 0141 applied.)
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
  kinds   text[] := array['departure','conflict','homework','approval','reminder_overdue','renewal','document','meal','grocery'];
  impacts int[]  := array[90,92,84,76,70,66,60,52,40];
  hrefs   text[] := array['/dashboard/calendar','/dashboard/conflicts','/dashboard/homework','/dashboard/autopilot','/dashboard/reminders','/dashboard/renewals','/dashboard/documents','/dashboard/meals','/dashboard/grocery'];
  titles  text[] := array[
    'Leave 20 min earlier for the swim meet','A schedule clash today','2 assignments due tomorrow',
    '3 decisions waiting on you','2 reminders slipped past due','Passport expires in 3 days',
    'Insurance card expires in 6 days','3 dinners this week aren''t planned','6 items on the grocery list'];
  statuses text[] := array['active','active','active','active','dismissed','acted'];
begin
  if to_regclass('public.daily_insights') is null then
    raise notice 'daily_insights not present — apply migration 0141 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  delete from public.daily_insights where family_id = v_family and detail like '%[seed:insight]%';

  -- date = current_date - floor(i/9), kind index = i % 9 → each (date, kind) pair
  -- is unique across the 500 rows (i = 9*q + r), so the unique key never collides.
  insert into public.daily_insights
    (family_id, as_of_date, kind, title, detail, href, impact, status, created_at)
  select
    v_family,
    (current_date - (g.i / 9)),
    kinds[1 + (g.i % 9)],
    titles[1 + (g.i % 9)],
    'Ranked insight for the day. [seed:insight]',
    hrefs[1 + (g.i % 9)],
    greatest(0, impacts[1 + (g.i % 9)] - (g.i / 9)),   -- older days decay a touch
    statuses[1 + (g.i % 6)],
    now() - ((g.i) || ' hours')::interval
  from generate_series(0, n - 1) g(i)
  on conflict (family_id, as_of_date, kind) do nothing;

  raise notice 'Daily insights seeded 500 rows for family %', v_family;
end $$;

-- Verify:
--   select count(*) from daily_insights where detail like '%[seed:insight]%';   -- 500
--   select kind, count(*) from daily_insights group by kind order by 2 desc;
