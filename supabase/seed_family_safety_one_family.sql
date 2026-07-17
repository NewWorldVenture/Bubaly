-- ============================================================================
-- seed_family_safety_one_family.sql — data for the new Family safety pages:
--   Check In (safety_check_ins), Driving Safety (driving_trips), Play Dates
--   (play_dates) — for ONE family.
-- ----------------------------------------------------------------------------
-- Seeds ~60 check-ins, ~60 driving trips, ~30 play dates (150+ rows) with a
-- realistic spread of statuses, scores, and dates (past + upcoming).
--
-- TABLES: safety_check_ins, driving_trips, play_dates. Requires migration
--   0114_family_safety.sql applied first.
--
-- TARGET FAMILY: resolved reproducibly at runtime.
-- IDEMPOTENT: seeded rows are tagged ('[seed]' in note/notes) and removed before
--   re-insert. Run: npm run db:seed:family  (or psql -f this file).
-- VERIFY: open /dashboard/family → Check In / Driving Safety / Play Dates.
-- ============================================================================

do $$
declare
  v_fam uuid := coalesce((select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1),(select fm.family_id from public.family_members fm where fm.is_active and fm.role not in ('parent','adult') group by fm.family_id order by min(fm.created_at) limit 1),(select id from public.families order by created_at limit 1));  -- reproducible (was a hardcoded prod UUID)
  v_email text := 'newworldventurellc@gmail.com';
  v_uid uuid; v_members uuid[]; n int; i int;
  st text; statuses text[] := ARRAY['safe','on_my_way','arrived','need_help'];
  pd_st text[] := ARRAY['planned','confirmed','completed','cancelled'];
  hb int; ra int; ph int; mph int; sc int; dist numeric;
  titles text[] := ARRAY['Playdate at the park','Swim playdate','Backyard hangout','Museum trip','Movie afternoon','Birthday party','Soccer in the park','Library story time','Ice cream meetup','Trampoline park'];
  friends text[] := ARRAY['Emma & Liam','Noah','Ava & Mia','the Johnsons','Sophia','Jackson','the Patels','Olivia','Ethan & Lucas','Chloe'];
begin
  select id into v_uid from auth.users where lower(email)=lower(v_email) limit 1;
  if v_uid is null then raise notice 'Seed skipped: no user %', v_email; return; end if;
  if not exists (select 1 from public.families where id=v_fam) then raise notice 'Seed skipped: no family'; return; end if;
  select array_agg(id) into v_members from public.family_members where family_id=v_fam and is_active;
  n := coalesce(array_length(v_members,1),0);
  if n = 0 then raise notice 'Seed skipped: no members'; return; end if;

  delete from public.safety_check_ins where family_id=v_fam and note = '[seed]';
  delete from public.driving_trips where family_id=v_fam and notes = '[seed]';
  delete from public.play_dates where family_id=v_fam and notes = '[seed]';

  -- Check-ins (60)
  for i in 1..60 loop
    st := statuses[1 + (i % 4)];
    insert into public.safety_check_ins (family_id, member_id, status, place_label, note, latitude, longitude, created_by, created_at)
    values (v_fam, v_members[1 + (i % n)], st,
      (ARRAY['Home','School','Soccer practice','Grandma''s','The mall','Work',null])[1 + (i % 7)],
      '[seed]',
      case when i % 3 = 0 then 37.77 + (i % 20) * 0.001 else null end,
      case when i % 3 = 0 then -122.41 - (i % 20) * 0.001 else null end,
      v_uid, now() - (i * interval '7 hours'));
  end loop;

  -- Driving trips (60)
  for i in 1..60 loop
    hb := i % 5; ra := (i * 2) % 4; ph := (i % 6) * 15; mph := 55 + (i % 40); dist := round((3 + (i % 25) + (i%10)*0.1)::numeric, 1);
    sc := greatest(0, least(100, 100 - hb*4 - ra*3 - (ph/30.0)*2 - (case when mph>75 then (mph-75)*1.5 else 0 end)))::int;
    insert into public.driving_trips (family_id, member_id, label, started_at, ended_at, distance_miles, max_mph, hard_brakes, rapid_accels, phone_use_seconds, score, notes, created_by)
    values (v_fam, v_members[1 + (i % n)],
      (ARRAY['School run','Grocery trip','Soccer practice','Highway commute','Errands','Road trip'])[1 + (i % 6)],
      now() - (i * interval '11 hours'), now() - (i * interval '11 hours') + interval '25 minutes',
      dist, mph, hb, ra, ph, sc, '[seed]', v_uid);
  end loop;

  -- Play dates (30): mix of upcoming + past
  for i in 1..30 loop
    insert into public.play_dates (family_id, member_id, title, with_kids, location, starts_at, status, contact_name, contact_phone, notes, created_by)
    values (v_fam, v_members[1 + (i % n)],
      titles[1 + (i % array_length(titles,1))], friends[1 + (i % array_length(friends,1))],
      (ARRAY['Riverside Park','Community Pool','Our house','Science Museum','Downtown Cinema',null])[1 + (i % 6)],
      case when i % 2 = 0 then now() + ((i % 15) * interval '1 day') else now() - ((i % 20) * interval '1 day') end,
      case when i % 2 = 0 then pd_st[1 + (i % 2)] else pd_st[3] end,
      (ARRAY['Sarah''s mom','Coach Dave','Emma''s dad',null])[1 + (i % 4)],
      case when i % 3 = 0 then '(555) 010-' || lpad((i*7 % 10000)::text, 4, '0') else null end,
      '[seed]', v_uid);
  end loop;

  raise notice 'Seeded 60 check-ins, 60 trips, 30 play dates for family %', v_fam;
end $$;
