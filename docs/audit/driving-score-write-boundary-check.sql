-- Behavioural proof for 0319, run as real `authenticated` sessions under RLS.
--
-- `driving_trips` and `driver_licenses` are the two tables of one feature and
-- did not carry the same rule. The licence had
-- `can_manage_family or is_self_member` on all four commands; the telemetry —
-- hard brakes, max mph, phone-use seconds and the 0-100 score a parent reads
-- before deciding about car keys — had plain `is_family_member`. The driver
-- graded their own driving.
--
-- components/family/driving-safety-view.tsx writes with the anon key from the
-- browser and has no role gate of any kind, so RLS is the whole boundary AND
-- the reason DELETE is not simply closed to managers: the view renders Delete
-- for every member. `created_by` is what separates "the entry I just made" from
-- "my parent's record of my driving".
--
-- No blanket `grant ... on all tables in schema public`: the bootstrap's
-- `alter default privileges` already gives the client roles DML on every table
-- a migration creates, and restating it would undo later deliberate revokes for
-- every probe that runs after this one.
grant usage on schema public to authenticated;

do $$
declare
  fam        uuid := 'ffff8888-0000-4000-8000-00000000000b';
  parent_uid uuid := 'f8000000-0000-4000-8000-000000000001';
  teen_uid   uuid := 'f8000000-0000-4000-8000-000000000002';
  parent_mid uuid;
  teen_mid   uuid;
  parent_trip uuid;
  teen_trip   uuid;
  n          int;
  v_score    int;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  delete from public.driving_trips  where family_id = fam;
  delete from public.family_members where user_id in (parent_uid, teen_uid);
  delete from public.families       where id = fam;

  insert into public.families (id, name) values (fam, 'Drivers');
  insert into auth.users (id, email) values
    (parent_uid, 'dp@example.test'), (teen_uid, 'dt@example.test') on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, parent_uid, 'Parent', 'parent', true) returning id into parent_mid;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, teen_uid, 'Teen', 'teen', true) returning id into teen_mid;

  -- The trip the parent recorded about the teen: the report this is all about.
  insert into public.driving_trips
    (family_id, member_id, label, distance_miles, max_mph, hard_brakes, rapid_accels, phone_use_seconds, score, created_by)
  values (fam, teen_mid, 'Late drive home', 18.4, 78, 5, 3, 240, 41, parent_uid)
  returning id into parent_trip;

  -- ══ POSITIVE CONTROLS FIRST ════════════════════════════════════════════

  -- 1. The teen can still LOG a trip. The form is offered to every member and
  --    picks the driver from the roster, so this must not move.
  perform set_config('request.jwt.claim.sub', teen_uid::text, true);
  set local role authenticated;
  insert into public.driving_trips
    (family_id, member_id, label, distance_miles, max_mph, hard_brakes, rapid_accels, phone_use_seconds, score, created_by)
  values (fam, teen_mid, 'School run', 4.2, 41, 0, 0, 0, 96, teen_uid)
  returning id into teen_trip;

  -- 2. And still SEES the family's trips — the summary at the top of the view
  --    averages them, so a narrowed read would empty the page.
  select count(*) into n from public.driving_trips where family_id = fam;
  if n <> 2 then
    raise exception 'a teen sees % of 2 trips; the driving view reads family-wide', n;
  end if;

  -- 3. And can withdraw the entry THEY made. The view offers Delete to every
  --    member with no role gate; a rule that failed here would leave a UI whose
  --    primary control does not work.
  delete from public.driving_trips where id = teen_trip;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a teen can no longer delete the trip they logged themselves (%)', n;
  end if;

  -- ══ THE BOUNDARY ═══════════════════════════════════════════════════════

  -- 4. Regrading the parent's record. This is the finding: UPDATE 1, score 100.
  update public.driving_trips set score = 100 where id = parent_trip;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a teen rewrote the driving score their parent recorded (%)', n;
  end if;

  -- 5. Or quietly softening the telemetry the score is computed from, which is
  --    the same act one column to the left.
  update public.driving_trips
     set hard_brakes = 0, phone_use_seconds = 0, max_mph = 55
   where id = parent_trip;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a teen rewrote the telemetry behind their score (%)', n;
  end if;

  -- 6. Or erasing the trip entirely — the view deletes by id alone, so RLS is
  --    the only thing that ever said no.
  delete from public.driving_trips where id = parent_trip;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a teen deleted the trip their parent recorded (%)', n;
  end if;
  reset role;

  -- The parent's record is untouched, number for number.
  select score into v_score from public.driving_trips where id = parent_trip;
  if v_score is distinct from 41 then
    raise exception 'the parent''s recorded score changed: %', v_score;
  end if;

  -- ══ AND THE PARENT STILL OWNS IT ═══════════════════════════════════════
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  update public.driving_trips set label = 'Late drive home (reviewed)' where id = parent_trip;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a manager can no longer correct a trip (%)', n;
  end if;
  delete from public.driving_trips where id = parent_trip;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a manager can no longer delete a trip (%)', n;
  end if;
  reset role;

  perform set_config('request.jwt.claim.sub', '', true);
  delete from public.driving_trips  where family_id = fam;
  delete from public.family_members where user_id in (parent_uid, teen_uid);
  delete from public.families       where id = fam;

  raise notice '0319 driving score write boundary: all assertions held';
end $$;
