-- ============================================================================
-- seed_hydration_one_family.sql — Hydration habits demo data for ONE family (TODO-0416)
-- ----------------------------------------------------------------------------
-- WHAT IT SEEDS:
--   • habits     — one "💧 Drink water" count habit per active member (daily
--                  target from the member's age) plus a family bottle-refill
--                  habit — all tagged in description
--   • habit_logs — 250 daily count rows across those habits over the last
--                  weeks: full days (streaks), partial days, one row per day
-- TARGET FAMILY: resolved at runtime (v_email's family → first family).
-- IDEMPOTENT: habits carry description like '%[seed:hydration]%'; their logs
--             cascade on delete before re-insert.
-- HOW TO RUN: npm run db:seed:hydration   REQUIRES: migration 0073 (habits)
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_user    uuid;
  v_members uuid[];
  m_count   int;
  n         int := 250;
  hids      uuid[] := '{}';
  targets   int[] := '{}';
  hid       uuid;
  i         int;
  h_idx     int;
  age       int;
  tgt       int;
  d         date;
  cnt       int;
begin
  if to_regclass('public.habits') is null or to_regclass('public.habit_logs') is null then
    raise notice 'habits tables not present — apply migration 0073 first. Skipping.';
    return;
  end if;
  select f.id into v_family from public.families f
    join public.family_members fm on fm.family_id = f.id join auth.users u on u.id = fm.user_id
    where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id order by created_at) into v_members from public.family_members where family_id = v_family and is_active;
  m_count := coalesce(array_length(v_members, 1), 0);
  if m_count = 0 then raise exception 'Family % has no active members.', v_family; end if;
  select fm.user_id into v_user from public.family_members fm where fm.family_id = v_family and fm.user_id is not null order by fm.created_at limit 1;

  delete from public.habits where family_id = v_family and description like '%[seed:hydration]%';

  -- 1) One water habit per member (age-based target) + a family refill habit --------
  for i in 1..m_count loop
    select coalesce(extract(year from age(current_date, fm.birthday))::int, 35) into age from public.family_members fm where fm.id = v_members[i];
    tgt := case when age < 1 then 1 when age <= 3 then 4 when age <= 8 then 5 when age <= 13 then 7 when age <= 18 then 9 else 8 end;
    insert into public.habits (family_id, member_id, title, description, color, cadence, target_per_period, weekdays, is_active, sort_order, created_by)
    values (v_family, v_members[i], '💧 Drink water', 'A cup at a time. Target: ' || tgt || ' cups a day. [seed:hydration]', 'sky', 'daily', tgt, '{}', true, 90 + i, v_user)
    returning id into hid;
    hids := hids || hid; targets := targets || tgt;
  end loop;
  insert into public.habits (family_id, member_id, title, description, color, cadence, target_per_period, weekdays, is_active, sort_order, created_by)
  values (v_family, null, '🚰 Refill the water bottle', 'Three refills of a 500 ml bottle is a day’s water. [seed:hydration]', 'sky', 'daily', 3, '{}', true, 99, v_user)
  returning id into hid;
  hids := hids || hid; targets := targets || 3;

  -- 2) 250 daily count rows: one per habit per day (UNIQUE habit_id, log_date) -------
  -- Walk days backwards, cycling habits; recent days are mostly full for streaks.
  for i in 1..n loop
    h_idx := 1 + ((i - 1) % array_length(hids, 1));
    d := current_date - ((i - 1) / array_length(hids, 1));
    tgt := targets[h_idx];
    cnt := case
      when d >= current_date - 6 then tgt                              -- last week: on target → streaks
      when i % 4 = 0 then greatest(1, tgt - 1 - (i % 3))                -- partial days
      when i % 9 = 0 then tgt + 1                                        -- over target
      else tgt end;
    if d = current_date then cnt := greatest(1, tgt / 2); end if;        -- today: mid-way, +1 to finish
    insert into public.habit_logs (family_id, habit_id, member_id, log_date, count, note, created_by)
    select v_family, hids[h_idx], h.member_id, d, cnt, '[seed:hydration]', v_user from public.habits h where h.id = hids[h_idx]
    on conflict (habit_id, log_date) do update set count = excluded.count, note = excluded.note;
  end loop;

  raise notice 'Seeded hydration for family %: % habits, % logs', v_family,
    (select count(*) from public.habits where family_id = v_family and description like '%[seed:hydration]%'),
    (select count(*) from public.habit_logs where family_id = v_family and note = '[seed:hydration]');
end $$;
