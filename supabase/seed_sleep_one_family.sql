-- ============================================================================
-- seed_sleep_one_family.sql — Sleep Coach demo data for ONE family (TODO-0410)
-- ----------------------------------------------------------------------------
-- WHAT IT SEEDS (250 rows per table):
--   • sleep_logs       — 250 nights across the family (member × night, no gaps for
--                        the most recent nights) with realistic bed/wake times,
--                        duration, quality, awakenings, sources
--   • bedtime_routines — 250 routines: one ACTIVE per member (age-appropriate
--                        steps) + archived earlier versions (is_active = false)
--   • sleep_checkins   — 250 daily check-ins (energy, mood, caffeine, screens, exercise)
--                        aligned to the same nights so the coach can correlate
-- TARGET FAMILY: resolved at runtime (v_email's family → first family).
-- IDEMPOTENT: rows carry notes = '[seed:sleep]' and are deleted before re-insert.
-- HOW TO RUN: npm run db:seed:sleep   REQUIRES: migration 0243
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_user    uuid;
  v_members uuid[];
  m_count   int;
  n         int := 250;
  steps_kid  text[] := array['Bath','Pyjamas + teeth','Two books','Song + lights out'];
  steps_teen text[] := array['Phone charges outside the room','Shower','Read or journal','Lights out'];
  steps_adult text[] := array['Dim lights + screens off','Tomorrow''s list written down','Stretch or read','Lights out'];
  routine_names text[] := array['School-night routine','Weekend routine','Summer routine','Reset routine','Travel routine'];
  sources   text[] := array['manual','manual','wearable','manual','estimate'];
  i         int;
  mem       uuid;
  mi        int;
  night     date;
  bed_min   int;
  dur_min   int;
  bed_ts    timestamptz;
  wake_ts   timestamptz;
  quality   int;
begin
  if to_regclass('public.sleep_logs') is null then
    raise notice 'sleep_logs not present — apply migration 0243 first. Skipping.';
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

  delete from public.sleep_checkins where family_id = v_family and notes = '[seed:sleep]';
  delete from public.sleep_logs where family_id = v_family and notes = '[seed:sleep]';
  delete from public.bedtime_routines where family_id = v_family and notes = '[seed:sleep]';

  -- 1) 250 nights: member × night, most recent nights first ---------------------
  for i in 0..(n - 1) loop
    mi := 1 + (i % m_count);
    mem := v_members[mi];
    night := current_date - (i / m_count);                         -- the night that ended this morning = today
    -- Bedtime drifts by member (younger → earlier) with weekend + noise, in minutes after 18:00.
    bed_min := 180 + (mi * 45) + (case when extract(dow from night) in (5, 6) then 40 else 0 end) + ((i * 7) % 50) - 25;
    dur_min := 420 + (case when mi = 1 then 30 else 120 end) + ((i * 11) % 90) - 45 - (case when i % 9 = 0 then 90 else 0 end);
    bed_ts := (night - 1)::timestamp + interval '18 hours' + (bed_min || ' minutes')::interval;
    wake_ts := bed_ts + (dur_min || ' minutes')::interval;
    quality := case when i % 7 = 0 then null else 2 + ((i * 5) % 4) end;
    insert into public.sleep_logs (family_id, member_id, sleep_date, bedtime, wake_time, duration_min, quality, awakenings, source, notes, created_by)
    values (v_family, mem, night, bed_ts, wake_ts, dur_min, quality, case when i % 6 = 0 then 1 + (i % 3) else 0 end,
      sources[1 + (i % array_length(sources, 1))], '[seed:sleep]', v_user)
    on conflict (member_id, sleep_date) do nothing;
  end loop;

  -- 2) 250 routines: one active per member + archived versions ------------------
  for i in 1..n loop
    mi := 1 + (i % m_count);
    mem := v_members[mi];
    insert into public.bedtime_routines (family_id, member_id, name, target_bedtime, target_wake, wind_down_min, steps, days_of_week, is_active, notes, created_by)
    values (v_family, mem,
      routine_names[1 + (i % array_length(routine_names, 1))] || case when i > m_count then ' v' || (i / m_count) else '' end,
      (time '18:00' + ((180 + (mi * 45) + ((i * 13) % 40) - 20) || ' minutes')::interval)::time,
      (time '06:00' + (((mi * 15) + ((i * 7) % 30)) || ' minutes')::interval)::time,
      20 + ((i * 5) % 40),
      case when mi = 1 then steps_adult when mi = 2 then steps_teen else steps_kid end,
      case when i % 4 = 0 then array[5, 6] else array[0, 1, 2, 3, 4, 5, 6] end,
      (i <= m_count), '[seed:sleep]', v_user);
  end loop;

  -- 3) 250 check-ins aligned to the seeded nights --------------------------------
  for i in 0..(n - 1) loop
    mi := 1 + (i % m_count);
    mem := v_members[mi];
    night := current_date - (i / m_count);
    insert into public.sleep_checkins (family_id, member_id, checkin_date, energy, mood, caffeine_after_2pm, screens_in_bed, exercised, notes, created_by)
    values (v_family, mem, night, 1 + ((i * 3) % 5), 1 + ((i * 7) % 5), (i % 5 = 0), (i % 3 = 0), (i % 4 = 1), '[seed:sleep]', v_user)
    on conflict (member_id, checkin_date) do nothing;
  end loop;

  raise notice 'Sleep seeded: % nights, % routines, % check-ins for family %', n, n, n, v_family;
end $$;
