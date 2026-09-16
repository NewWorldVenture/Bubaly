-- Who may change what a child is told to take.
--
-- components/modules/medications-module.tsx declares `canEdit = isManager(role)`
-- and then writes `medications` and `medication_schedules` STRAIGHT FROM THE
-- BROWSER with the viewer's own JWT (lines 205, 216, 223, 236, 251). `canEdit`
-- only decides whether a button renders (284, 368, 399, 419). A hidden button
-- is not a boundary.
--
-- Its neighbours in the same area ARE enforced — `medical_profiles`,
-- `health_providers` and `insurance_policies` each carry three manager-checked
-- write policies. The three medication tables carry none, so this is the
-- familiar shape: a class fixed where somebody remembered, left open where
-- nobody did.
--
-- What the columns reach is not a display. lib/server/notifications.ts reads
-- `medications.{name,dosage,member_id,is_active}` and
-- `medication_schedules.{time_of_day,days_of_week,starts_on,ends_on}` to raise
-- the family's "dose due today" reminder — so these rows decide what a parent is
-- told to administer and when, and `is_active = false` stops the telling
-- altogether. app/api/ai/health/coach/route.ts feeds `dosage` and `instructions`
-- to a model as fact.
--
-- LOGGING a dose is deliberately not guarded here and is asserted as a positive
-- control: the module leaves that ungated for everyone (lines 166-172), the same
-- way a child may tick their own chore done. This probe is about the
-- prescription, not the tick.
--
-- Judged on ROW COUNTS: an UPDATE refused by nothing simply lands, and an
-- exception-only assertion would report a boundary that is not there.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-0000000ded01';
  parent_uid uuid := '00000000-0000-4000-8000-0000000deda1';
  child_uid  uuid := '00000000-0000-4000-8000-0000000deda2';
  child_mid uuid;
  med uuid;
  sched uuid;
  spare_med uuid;
  spare_sched uuid;
  txt text;
  flag boolean;
  n int;
  failures int := 0;
begin
  delete from public.medication_doses where family_id = fam;
  delete from public.medication_schedules where family_id = fam;
  delete from public.medications where family_id = fam;

  insert into auth.users (id, email) values
    (parent_uid, 'med-parent@example.com'), (child_uid, 'med-child@example.com')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Medications', parent_uid)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, parent_uid, 'Parent', 'parent', true),
    (fam, child_uid,  'Child',  'child',  true)
  on conflict do nothing;
  select id into child_mid from public.family_members where family_id = fam and user_id = child_uid;

  -- A prescription the parent set up, for the child.
  insert into public.medications (family_id, member_id, name, dosage, instructions, is_active, created_by)
    values (fam, child_mid, 'Methylphenidate', '10 mg', 'One tablet with breakfast', true, parent_uid)
    returning id into med;
  insert into public.medication_schedules (family_id, medication_id, time_of_day, days_of_week, starts_on)
    values (fam, med, '08:00', '{0,1,2,3,4,5,6}', current_date) returning id into sched;

  -- A second prescription, so the DELETE assertions below cannot destroy the
  -- row the "what the reminder reads" and manager controls depend on. An
  -- earlier draft of this probe deleted its own fixture and then reported the
  -- product's working manager path as a control failure.
  insert into public.medications (family_id, member_id, name, dosage, is_active, created_by)
    values (fam, child_mid, 'Amoxicillin', '250 mg', true, parent_uid) returning id into spare_med;
  insert into public.medication_schedules (family_id, medication_id, time_of_day, days_of_week, starts_on)
    values (fam, spare_med, '12:00', '{1,2,3}', current_date) returning id into spare_sched;

  -- ── as the child ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  if not public.is_family_member(fam) then
    raise exception 'CONTROL FAILED: not acting as a member of the family under test';
  end if;
  if public.can_manage_family(fam) then
    raise exception 'CONTROL FAILED: acting as a manager, so nothing below is a child boundary';
  end if;

  -- 1. Logging a dose is theirs to do — the positive control. The module leaves
  --    this ungated for everyone, and a guard that blocked it would have closed
  --    adherence tracking rather than the hole.
  begin
    insert into public.medication_doses
      (family_id, medication_id, schedule_id, member_id, scheduled_for, status, logged_by)
    values (fam, med, sched, child_mid, now(), 'taken', child_uid);
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a child could not log their own dose (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a child could not log their own dose (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 2. But not rewrite the dose itself.
  begin
    update public.medications set dosage = '40 mg' where id = med;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child changed their own prescribed dosage (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 3. Nor the instructions an AI health coach repeats as fact.
  begin
    update public.medications set instructions = 'Take as many as you like' where id = med;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child rewrote their medication instructions (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 4. Nor switch the reminder off. is_active = false removes the medication
  --    from the notification read entirely, so nobody is told it is due.
  begin
    update public.medications set is_active = false where id = med;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child deactivated their own medication (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 5. Nor move when it is due.
  begin
    update public.medication_schedules set time_of_day = '23:59', days_of_week = '{0}' where id = sched;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child moved their own dosing schedule (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 6. Nor delete the schedule, which has the same effect more bluntly.
  begin
    delete from public.medication_schedules where id = spare_sched;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child deleted their own dosing schedule (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 7. Nor the prescription.
  begin
    delete from public.medications where id = spare_med;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child deleted their own medication record (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  reset role;

  -- 8. What the reminder would read is still what the parent prescribed.
  select dosage, is_active into txt, flag from public.medications where id = med;
  if txt is distinct from '10 mg' or flag is distinct from true then
    raise warning 'BREACH: the prescription the reminder reads is now % (active: %)', txt, flag;
    failures := failures + 1;
  end if;
  select count(*) into n from public.medication_schedules where id = sched and time_of_day = '08:00';
  if n <> 1 then
    raise warning 'BREACH: the dosing time the reminder reads is no longer the one the parent set';
    failures := failures + 1;
  end if;

  -- 9. A manager still prescribes, or the guard has closed the product.
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  begin
    update public.medications set dosage = '15 mg' where id = med;
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not change a dosage (rows: %)', n;
      failures := failures + 1;
    end if;
    insert into public.medication_schedules (family_id, medication_id, time_of_day, days_of_week, starts_on)
      values (fam, med, '20:00', '{1,3,5}', current_date);
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not add a dosing schedule (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a manager could not manage a prescription (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;
  reset role;

  if failures > 0 then
    raise exception 'medication-record-boundary: % assertion(s) failed', failures;
  end if;
  raise notice 'medication-record-boundary: OK — a child may log a dose, and may not rewrite the prescription';
end
$probe$;
