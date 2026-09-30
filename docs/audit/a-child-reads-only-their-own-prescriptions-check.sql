-- Behavioural proof for 0465 (F-G09: parents write, kids see their own), run as
-- real `authenticated` sessions under RLS. Everything is inside one DO block;
-- run it inside a transaction you roll back.
--
-- The fixture is one family with a parent, a child and the child's sibling,
-- and four prescriptions: the parent's own, one filed "Whole family"
-- (member_id NULL — the module's default), the child's and the sibling's, each
-- with a schedule and a dose.
--
-- What it asserts, each with its opposite so neither half is vacuous:
--
--   READS   the parent reads all four prescriptions, schedules and doses; the
--           child reads exactly their own — not the sibling's, not the
--           parent's, not the family-wide one — and the sibling, symmetrically,
--           only theirs.
--   DOSES   the child still records, re-marks and un-marks a dose of their own
--           medication (insert / update / delete, the module's three writes),
--           and cannot rewrite the sibling's dose.
--   WRITES  immunizations and health_visits: the child's insert is REFUSED
--           (42501), their update and delete reach no row; the parent's
--           insert, update and delete each land. Prescriptions: the child still
--           cannot touch a medication or schedule (0309 / 0434 kept).
--
-- Non-vacuity: with 0465's read policies replaced by the pre-0465
-- `is_family_member(family_id)` reads (see the note at the end), this probe
-- fails at "a child read a prescription that is not theirs".
grant usage on schema public to authenticated;

do $$
declare
  fam          uuid := 'cccc0465-0000-4000-8000-000000000001';
  parent_uid   uuid := 'c0465000-0000-4000-8000-000000000001';
  child_uid    uuid := 'c0465000-0000-4000-8000-000000000002';
  sib_uid      uuid := 'c0465000-0000-4000-8000-000000000003';
  parent_mid   uuid;
  child_mid    uuid;
  sib_mid      uuid;
  med_parent   uuid;
  med_family   uuid;
  med_child    uuid;
  med_sib      uuid;
  sch_child    uuid;
  sch_sib      uuid;
  dose_sib     uuid;
  dose_child   uuid;
  imm_id       uuid;
  visit_id     uuid;
  blocked      boolean;
  n            int;
  names        text;
begin
  delete from public.medication_doses where family_id = fam;
  delete from public.medication_schedules where family_id = fam;
  delete from public.medications where family_id = fam;
  delete from public.immunizations where family_id = fam;
  delete from public.health_visits where family_id = fam;
  delete from public.family_members where family_id = fam;
  delete from public.families where id = fam;

  insert into public.families (id, name) values (fam, 'Prescriptions 0465');
  insert into auth.users (id, email) values
    (parent_uid, 'p0465@example.test'), (child_uid, 'c0465@example.test'), (sib_uid, 's0465@example.test')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, parent_uid, 'Parent', 'parent', true) returning id into parent_mid;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, child_uid, 'Child', 'child', true) returning id into child_mid;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, sib_uid, 'Sibling', 'teen', true) returning id into sib_mid;

  -- ── As the PARENT: the fixture, through RLS, and the positive controls ───
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;

  insert into public.medications (family_id, member_id, name, dosage, is_active, created_by)
    values (fam, parent_mid, 'Sertraline', '50mg', true, parent_uid) returning id into med_parent;
  insert into public.medications (family_id, member_id, name, dosage, is_active, created_by)
    values (fam, null, 'Unassigned', '1 tab', true, parent_uid) returning id into med_family;
  insert into public.medications (family_id, member_id, name, dosage, is_active, created_by)
    values (fam, child_mid, 'Amoxicillin', '250mg', true, parent_uid) returning id into med_child;
  insert into public.medications (family_id, member_id, name, dosage, is_active, created_by)
    values (fam, sib_mid, 'Methylphenidate', '18mg', true, parent_uid) returning id into med_sib;

  insert into public.medication_schedules (family_id, medication_id, time_of_day) values (fam, med_parent, '08:00');
  insert into public.medication_schedules (family_id, medication_id, time_of_day) values (fam, med_family, '08:00');
  insert into public.medication_schedules (family_id, medication_id, time_of_day)
    values (fam, med_child, '08:00') returning id into sch_child;
  insert into public.medication_schedules (family_id, medication_id, time_of_day)
    values (fam, med_sib, '08:00') returning id into sch_sib;

  -- The parent records the sibling's morning dose.
  insert into public.medication_doses (family_id, medication_id, schedule_id, member_id, scheduled_for, status, logged_by, notes)
    values (fam, med_sib, sch_sib, sib_mid, date_trunc('day', now()) + interval '8 hours', 'taken', parent_uid, 'felt sick after')
    returning id into dose_sib;

  select count(*) into n from public.medications where family_id = fam;
  if n <> 4 then raise exception 'a parent no longer reads every prescription in the family (% of 4)', n; end if;
  select count(*) into n from public.medication_schedules where family_id = fam;
  if n <> 4 then raise exception 'a parent no longer reads every schedule in the family (% of 4)', n; end if;
  select count(*) into n from public.medication_doses where family_id = fam;
  if n <> 1 then raise exception 'a parent no longer reads the family''s doses (% of 1)', n; end if;

  -- Immunizations and visits: a parent writes all three ways.
  insert into public.immunizations (family_id, member_id, vaccine, created_by)
    values (fam, child_mid, 'MMR', parent_uid) returning id into imm_id;
  update public.immunizations set dose_label = 'Dose 2' where id = imm_id;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'a parent can no longer edit an immunization (%)', n; end if;
  insert into public.health_visits (family_id, member_id, title, created_by)
    values (fam, child_mid, 'Checkup', parent_uid) returning id into visit_id;
  update public.health_visits set title = 'Annual checkup' where id = visit_id;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'a parent can no longer edit a health visit (%)', n; end if;

  -- ── As the CHILD ─────────────────────────────────────────────────────────
  reset role;
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- READS: exactly their own.
  select string_agg(name, ', ' order by name) into names from public.medications where family_id = fam;
  if names is distinct from 'Amoxicillin' then
    raise exception 'a child read a prescription that is not theirs: saw [%], expected only their own', names;
  end if;
  select count(*) into n from public.medications where id in (med_parent, med_family, med_sib);
  if n <> 0 then raise exception 'a child can select a parent''s, sibling''s or family-wide prescription by id (%)', n; end if;
  select count(*) into n from public.medication_schedules where family_id = fam;
  if n <> 1 then raise exception 'a child read % schedules; expected only the one for their own medication', n; end if;
  select count(*) into n from public.medication_schedules where id = sch_child;
  if n <> 1 then raise exception 'a child can no longer read the schedule of their own medication'; end if;
  select count(*) into n from public.medication_doses where family_id = fam;
  if n <> 0 then raise exception 'a child read a sibling''s dose history (%)', n; end if;

  -- DOSES: the module's three writes, on their own medication.
  insert into public.medication_doses (family_id, medication_id, schedule_id, member_id, scheduled_for, status, logged_by)
    values (fam, med_child, sch_child, child_mid, date_trunc('day', now()) + interval '8 hours', 'taken', child_uid);
  select id into dose_child from public.medication_doses where schedule_id = sch_child;
  if dose_child is null then raise exception 'a child cannot read back the dose they just recorded'; end if;

  update public.medication_doses set status = 'skipped', taken_at = null
    where id = dose_child and family_id = fam and medication_id = med_child;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'a child can no longer re-mark their own dose (%)', n; end if;

  -- And not the sibling's. Before 0465 this was UPDATE 1.
  update public.medication_doses set status = 'skipped' where id = dose_sib;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a child rewrote a sibling''s dose'; end if;

  delete from public.medication_doses where id = dose_child and family_id = fam;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'a child can no longer un-mark their own dose (%)', n; end if;

  -- PRESCRIPTION WRITES stay a parent's (0309 / 0434).
  update public.medications set dosage = '500mg' where id = med_child;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a child changed the dosage of their own prescription'; end if;
  delete from public.medication_schedules where id = sch_child;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a child deleted the schedule of their own prescription'; end if;

  -- IMMUNIZATIONS: refused, and the rows are still readable (reads unchanged).
  blocked := false;
  begin
    insert into public.immunizations (family_id, member_id, vaccine, created_by) values (fam, child_mid, 'Forged', child_uid);
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise exception 'a child recorded an immunization'; end if;
  update public.immunizations set date_given = '2001-01-01', next_due_date = null where id = imm_id;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a child rewrote an immunization record'; end if;
  delete from public.immunizations where id = imm_id;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a child deleted an immunization record'; end if;
  select count(*) into n from public.immunizations where id = imm_id;
  if n <> 1 then raise exception 'a child can no longer read the family''s immunizations'; end if;

  -- HEALTH VISITS: the same.
  blocked := false;
  begin
    insert into public.health_visits (family_id, member_id, title, created_by) values (fam, child_mid, 'Forged', child_uid);
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise exception 'a child recorded a health visit'; end if;
  update public.health_visits set outcome = 'rewritten' where id = visit_id;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a child rewrote a health visit'; end if;
  delete from public.health_visits where id = visit_id;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a child deleted a health visit'; end if;
  select count(*) into n from public.health_visits where id = visit_id;
  if n <> 1 then raise exception 'a child can no longer read the family''s health visits'; end if;

  -- ── As the SIBLING: symmetric, and their dose is visible to them ─────────
  reset role;
  perform set_config('request.jwt.claim.sub', sib_uid::text, true);
  set local role authenticated;
  select string_agg(name, ', ' order by name) into names from public.medications where family_id = fam;
  if names is distinct from 'Methylphenidate' then
    raise exception 'the sibling read [%], expected only their own prescription', names;
  end if;
  select count(*) into n from public.medication_doses where id = dose_sib;
  if n <> 1 then raise exception 'the sibling cannot read their own dose'; end if;

  -- ── As the PARENT again: deletes land ────────────────────────────────────
  reset role;
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  delete from public.immunizations where id = imm_id;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'a parent can no longer delete an immunization (%)', n; end if;
  delete from public.health_visits where id = visit_id;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'a parent can no longer delete a health visit (%)', n; end if;
  select status::text into names from public.medication_doses where id = dose_sib;
  if names is distinct from 'taken' then raise exception 'the sibling''s dose changed under the child''s refused update (%)', names; end if;

  reset role;
  raise notice 'OK 0465: a parent reads every prescription and writes the health record; a child reads only their own prescription, schedule and doses, still records their own dose, and cannot write an immunization or a visit';
end $$;

-- Non-vacuity, for whoever re-runs this: inside the same rolled-back
-- transaction, before the block above, restore the pre-0465 reads —
--
--   drop policy medications_own_or_manager_read_guard on public.medications;
--   drop policy medication_schedules_own_or_manager_read_guard on public.medication_schedules;
--   drop policy medication_doses_own_or_manager_read_guard on public.medication_doses;
--   alter policy medications_select on public.medications using (public.is_family_member(family_id));
--   alter policy medication_schedules_select on public.medication_schedules using (public.is_family_member(family_id));
--   alter policy medication_doses_select on public.medication_doses using (public.is_family_member(family_id));
--
-- and the probe fails at "a child read a prescription that is not theirs".
