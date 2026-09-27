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
--
-- NEGATIVE CONTROL. Checks 2-7 are refusals, and a refusal on its own names no
-- rule. 0309 -- which is still the newest migration to touch either table's
-- policies -- spells its guards as RESTRICTIVE policies with
-- `can_manage_family(family_id)` in USING, so a child's UPDATE and DELETE are
-- filtered to ZERO ROWS rather than raising anything. Zero rows is also what a
-- revoked GRANT, a column-level denial, a row this session cannot SELECT, or a
-- row that was never seeded would report; and the `insufficient_privilege`
-- arms catch 42501, which a missing GRANT, a failed JWT and a WITH CHECK
-- violation all share. The parent block at check 9 is a positive control and a
-- good one, but it moves the ACTOR and the PREDICATE together, and it never
-- touches DELETE at all.
--
-- So before any refusal is attempted, the SAME child -- same user, same
-- `authenticated` role, same JWT, same tables, same statements, same policies
-- -- performs every one of those writes against a second household they really
-- do manage. Only `can_manage_family(family_id)` differs. If any of them is
-- refused, this probe says its control failed and names the reason, rather
-- than crediting a refusal it did not measure to 0309.
--
-- And the guard itself is read out of `pg_policies`, not out of the migration
-- file, so this cannot pass against a rule a later migration replaced.
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
  -- The second household, for the negative control. This same child is a
  -- 'parent' here, so `can_manage_family` answers TRUE and every write refused
  -- on `fam` below is one they may really make.
  ctl_fam uuid := '00000000-0000-4000-8000-0000000ded02';
  ctl_mid uuid;
  ctl_med uuid;
  ctl_sched uuid;
  why text;
  r record;
  txt text;
  flag boolean;
  n int;
  failures int := 0;
begin
  delete from public.medication_doses where family_id in (fam, ctl_fam);
  delete from public.medication_schedules where family_id in (fam, ctl_fam);
  delete from public.medications where family_id in (fam, ctl_fam);

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

  -- The control household, and one prescription of its own. Nothing below
  -- counts or reads these rows: the control DELETES both as its last two steps,
  -- so `ctl_fam` leaves check 8's read-back and check 9's manager path exactly
  -- as it found them.
  --
  -- The family_members insert is belt-and-braces -- creating a family already
  -- enrols its creator as a 'parent', and `family_members` is unique on
  -- (family_id, user_id), so on a normal run this does nothing. What actually
  -- decides the control is the `can_manage_family(ctl_fam)` assertion below,
  -- which fires whatever state this household was found in.
  insert into public.families (id, name, created_by) values (ctl_fam, 'Medications (control)', child_uid)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (ctl_fam, child_uid, 'Grown up elsewhere', 'parent', true)
  on conflict do nothing;
  select id into ctl_mid from public.family_members where family_id = ctl_fam and user_id = child_uid;
  insert into public.medications (family_id, member_id, name, dosage, instructions, is_active, created_by)
    values (ctl_fam, ctl_mid, 'Loratadine', '10 mg', 'One tablet at night', true, child_uid)
    returning id into ctl_med;
  insert into public.medication_schedules (family_id, medication_id, time_of_day, days_of_week, starts_on)
    values (ctl_fam, ctl_med, '21:00', '{0,1,2,3,4,5,6}', current_date) returning id into ctl_sched;

  -- ── the rule that refuses is the one 0309 wrote ──────────────────
  -- The negative control below proves a refusal was real, was not a missing
  -- GRANT and was not a read denial. It still does not name the RULE: anything
  -- keyed on `can_manage_family(family_id)` refuses exactly these writes and
  -- would be credited here to 0309. So read the guard out of the CATALOG, not
  -- out of supabase/migrations -- that is the trap chore-award-amount-check
  -- fell into, where the live boundary was 0331's rewritten body, not 0305's.
  --
  -- Reproduced, not theorised: with all six of 0309's guards dropped and
  -- 0004's PERMISSIVE update/delete policies re-spelled `can_manage_family`,
  -- every check below still refused, the negative control still passed, and
  -- this probe still printed its OK line -- with 0309 gone from the database
  -- entirely. These eight rows are what turn that back into a red.
  --
  -- Pinned by SHAPE, not by name: a rename that keeps the predicate is not a
  -- boundary change, and failing on one would be noise. What is pinned is
  -- 0309's mechanism -- RESTRICTIVE (0254's trick: a restrictive policy ANDs
  -- with the permissive union, so no permissive policy added later can grant
  -- past it), spelling exactly `can_manage_family(family_id)`, on both tables,
  -- on all three write commands, and in BOTH halves of UPDATE. Matching the
  -- predicate exactly rather than with `like '%can_manage_family%'` is
  -- deliberate, and is the blind spot money-write-boundary-check reproduced:
  -- `is_family_member(family_id) or can_manage_family(family_id)` contains the
  -- string while re-opening the write to every member in the family.
  for r in
    select want.tbl, want.cmd, want.half
      from (values
              ('medications',          'INSERT', 'with check'),
              ('medications',          'UPDATE', 'using'),
              ('medications',          'UPDATE', 'with check'),
              ('medications',          'DELETE', 'using'),
              ('medication_schedules', 'INSERT', 'with check'),
              ('medication_schedules', 'UPDATE', 'using'),
              ('medication_schedules', 'UPDATE', 'with check'),
              ('medication_schedules', 'DELETE', 'using')
           ) as want(tbl, cmd, half)
     where not exists (
             select 1
               from pg_policies p
              where p.schemaname = 'public'
                and p.tablename  = want.tbl
                and p.permissive = 'RESTRICTIVE'
                and p.cmd        = want.cmd
                and (case when want.half = 'using' then p.qual else p.with_check end)
                    = 'can_manage_family(family_id)')
  loop
    raise exception 'CONTROL FAILED: no RESTRICTIVE % policy on public.% spells can_manage_family(family_id) in its % -- 0309''s guard is not the rule refusing the writes below, so a refusal there cannot be credited to it. Re-read which migration owns this boundary.',
      r.cmd, r.tbl, r.half;
  end loop;

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

  -- ── NEGATIVE CONTROL ─────────────────────────────────────────────────────
  -- Prove this session can make these writes AT ALL before reading anything
  -- into its being refused them. Same statements, same tables, same policies,
  -- same user -- against `ctl_fam`, where `can_manage_family` is true. Anything
  -- that failed here would also have refused checks 2-7 and been credited to
  -- 0309.
  if current_user <> 'authenticated' then
    raise exception 'CONTROL FAILED: these writes are running as %, not as authenticated, so RLS is not the thing being measured', current_user;
  end if;
  if not public.can_manage_family(ctl_fam) then
    raise exception 'CONTROL FAILED: this user does not manage the control household, so the writes below are not the same predicate with its answer flipped';
  end if;

  -- And the rows checks 2-7 aim at are rows this session can SEE. A row a
  -- child cannot SELECT reports exactly what a row a policy refused to write
  -- reports: nothing. 0297 left the medication reads open on purpose; if that
  -- is ever narrowed, this says so instead of letting the refusals below be
  -- read as 0309's.
  select count(*) into n from public.medications where id in (med, spare_med);
  if n <> 2 then
    raise exception 'CONTROL FAILED: this child can see % of the 2 medications that checks 2-4 and 7 aim at, so a zero row count there would be a read refusal rather than 0309''s write guard', n;
  end if;
  select count(*) into n from public.medication_schedules where id in (sched, spare_sched);
  if n <> 2 then
    raise exception 'CONTROL FAILED: this child can see % of the 2 dosing schedules that checks 5 and 6 aim at, so a zero row count there would be a read refusal rather than 0309''s write guard', n;
  end if;

  -- Control for checks 2, 3 and 4 -- all three columns in one statement, so a
  -- column-level denial on any of them shows up here rather than downstream.
  why := null;
  begin
    update public.medications
       set dosage = '40 mg', instructions = 'Take as many as you like', is_active = false
     where id = ctl_med;
    get diagnostics n = row_count;
    if n <> 1 then why := format('the UPDATE matched %s row(s)', n); end if;
  exception when others then why := format('%s %s', sqlstate, sqlerrm);
  end;
  if why is not null then
    raise exception 'CONTROL FAILED: this child was refused an ORDINARY prescription edit -- dosage, instructions and is_active -- in a family they DO manage (%), so a refusal in checks 2-4 would prove nothing about 0309', why;
  end if;

  -- Control for check 5.
  why := null;
  begin
    update public.medication_schedules set time_of_day = '23:59', days_of_week = '{0}' where id = ctl_sched;
    get diagnostics n = row_count;
    if n <> 1 then why := format('the UPDATE matched %s row(s)', n); end if;
  exception when others then why := format('%s %s', sqlstate, sqlerrm);
  end;
  if why is not null then
    raise exception 'CONTROL FAILED: this child could not move a dosing schedule in a family they DO manage (%), so a refusal in check 5 would prove nothing about 0309', why;
  end if;

  -- Control for check 6, and it goes BEFORE check 7's: medication_schedules
  -- cascades on medication_id, so deleting the medication first would take the
  -- schedule with it and leave this DELETE nothing to match -- a control
  -- failure this probe would have written itself.
  why := null;
  begin
    delete from public.medication_schedules where id = ctl_sched;
    get diagnostics n = row_count;
    if n <> 1 then why := format('the DELETE matched %s row(s)', n); end if;
  exception when others then why := format('%s %s', sqlstate, sqlerrm);
  end;
  if why is not null then
    raise exception 'CONTROL FAILED: this child could not delete a dosing schedule in a family they DO manage (%), so a refusal in check 6 would prove nothing about 0309', why;
  end if;

  -- Control for check 7. Nobody else in this probe proves a medications DELETE
  -- is reachable by anyone: check 9's manager block only updates and inserts.
  why := null;
  begin
    delete from public.medications where id = ctl_med;
    get diagnostics n = row_count;
    if n <> 1 then why := format('the DELETE matched %s row(s)', n); end if;
  exception when others then why := format('%s %s', sqlstate, sqlerrm);
  end;
  if why is not null then
    raise exception 'CONTROL FAILED: this child could not delete a medication record in a family they DO manage (%), so a refusal in check 7 would prove nothing about 0309', why;
  end if;

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
  raise notice 'medication-record-boundary: OK — a child may log a dose, may make every one of these writes in a household they manage, and may not rewrite this prescription';
end
$probe$;
