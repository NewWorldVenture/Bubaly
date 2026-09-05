-- ============================================================================
-- seed_declutter_one_family.sql — Declutter Missions demo data for ONE family (TODO-0411)
-- ----------------------------------------------------------------------------
-- WHAT IT SEEDS (250 rows per table):
--   • declutter_zones    — 250 zones (rooms × surfaces/closets/drawers/…) with
--                          clutter scores 1–5 and last-reset dates
--   • declutter_missions — 250 missions across zones + members: planned for the
--                          coming week, done over the last months (items removed,
--                          points), a few skipped
--   • declutter_sessions — 250 timed sessions (minutes, items removed) forming streaks
-- TARGET FAMILY: resolved at runtime (v_email's family → first family).
-- IDEMPOTENT: rows carry notes = '[seed:declutter]' and are deleted before re-insert.
-- HOW TO RUN: npm run db:seed:declutter   REQUIRES: migration 0244
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_user    uuid;
  v_members uuid[];
  m_count   int;
  n         int := 250;
  rooms     text[] := array['Kitchen','Living room','Primary bedroom','Kids'' room','Office','Garage','Entryway','Bathroom','Laundry room','Basement','Playroom','Dining room','Hall closet','Car'];
  things    text[] := array['counter','table','floor','closet','top drawer','junk drawer','bookshelf','toy bins','desk','fridge','pantry shelf','shoe pile','mail pile','windowsill','under the bed','coat hooks','cabinet','phone photos'];
  kinds     text[] := array['surface','surface','floor','closet','drawer','drawer','shelf','toys','desk','fridge','fridge','entryway','surface','surface','floor','entryway','closet','digital'];
  titles    text[] := array['Clear everything that doesn''t live here','Sort the paper pile: file, act, recycle','Floor pickup: nothing on the floor but furniture','Pull 10 things you haven''t worn this year','Empty it, keep only what you use monthly','Remove 5 things that don''t belong','Toss expired, wipe one shelf','Bin the broken, box the outgrown','Cables, chargers, pens: one tray','10-minute reset','Bag one donation','Everything back to its bin — race the timer'];
  statuses  text[] := array['done','done','done','planned','done','skipped','done','planned'];
  i         int;
  zid       uuid;
  mem       uuid;
  stat      text;
  sched     date;
begin
  if to_regclass('public.declutter_zones') is null then
    raise notice 'declutter_zones not present — apply migration 0244 first. Skipping.';
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

  delete from public.declutter_sessions where family_id = v_family and notes = '[seed:declutter]';
  delete from public.declutter_missions where family_id = v_family and notes = '[seed:declutter]';
  delete from public.declutter_zones where family_id = v_family and notes = '[seed:declutter]';

  -- 1) 250 zones ------------------------------------------------------------------
  for i in 1..n loop
    insert into public.declutter_zones (family_id, name, room, kind, clutter_score, last_reset_at, target_state, is_active, notes, created_by)
    values (v_family,
      initcap(things[1 + (i % array_length(things, 1))]) || case when i > array_length(rooms, 1) * array_length(things, 1) then ' ' || i else '' end,
      rooms[1 + ((i / array_length(things, 1)) % array_length(rooms, 1))],
      kinds[1 + (i % array_length(kinds, 1))],
      1 + ((i * 7) % 5),
      case when i % 4 = 0 then null else now() - (((i * 13) % 60) || ' days')::interval end,
      case when i % 3 = 0 then 'Clear and wiped, only daily-use items out' else null end,
      (i % 23 <> 0), '[seed:declutter]', v_user);
  end loop;

  create temp table tmp_dc_zones on commit drop as
    select id, row_number() over (order by created_at, id) as rn, count(*) over () as cnt
    from public.declutter_zones where family_id = v_family and notes = '[seed:declutter]';
  create index on tmp_dc_zones (rn);

  -- 2) 250 missions ---------------------------------------------------------------
  for i in 1..n loop
    select id into zid from tmp_dc_zones where rn = 1 + ((i * 11) % 250);
    mem := v_members[1 + (i % m_count)];
    stat := statuses[1 + (i % array_length(statuses, 1))];
    sched := case when stat = 'planned' then current_date + (i % 7) else current_date - ((i * 3) % 120) end;
    insert into public.declutter_missions (family_id, zone_id, title, minutes, assignee_id, status, scheduled_for, completed_at, items_removed, points, notes, created_by)
    values (v_family, zid, titles[1 + (i % array_length(titles, 1))], 5 + 5 * (i % 6), mem, stat, sched,
      case when stat = 'done' then (sched::timestamp + interval '18 hours' + ((i % 90) || ' minutes')::interval) else null end,
      case when stat = 'done' then (i * 7) % 15 else 0 end,
      3 + (i % 10), '[seed:declutter]', v_user);
  end loop;

  -- 3) 250 sessions, one per day going back (streak-friendly) -------------------
  for i in 0..(n - 1) loop
    select id into zid from tmp_dc_zones where rn = 1 + ((i * 17) % 250);
    insert into public.declutter_sessions (family_id, zone_id, member_id, started_at, minutes, missions_done, items_removed, notes, created_by)
    values (v_family, zid, v_members[1 + (i % m_count)], now() - (i || ' days')::interval - ((i * 29) % 600 || ' minutes')::interval,
      5 + 5 * (i % 6), 1 + (i % 2), (i * 5) % 12, '[seed:declutter]', v_user);
  end loop;

  raise notice 'Declutter seeded: % zones, % missions, % sessions for family %', n, n, n, v_family;
end $$;
