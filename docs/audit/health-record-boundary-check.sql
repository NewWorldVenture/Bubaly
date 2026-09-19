-- ── 0326: the last two health tables 0309 did not reach ─────────────────────
--
-- 0309 gated `medications` and `medication_schedules` behind restrictive
-- manager guards, and named the class in its own header:
--
--   "This is the shape this series keeps finding — a class fixed where somebody
--    remembered and left open where nobody did."
--
-- It listed the neighbours it had checked: `medical_profiles`,
-- `health_providers`, `insurance_policies`. It did not look at `immunizations`
-- or `health_visits`, which sit on the same route — /dashboard/medical renders
-- all three modules one under the other — and which `lib/ai/context/policy.ts`
-- names as sensitive ("vaccination records", "visit notes").
--
-- Both kept 0068/0069's `FOR ALL TO authenticated USING (is_family_member)`.
-- Neither module carries the `canEdit = isManager(role)` that
-- medications-module.tsx has, so unlike medications this was not even a hidden
-- button: the Edit and Delete controls render for a child and work.
--
-- Measured before 0326, as a signed-in child:
--   NOTICE: child rewrote a SIBLING's mental-health visit outcome
--   NOTICE: child deleted a SIBLING's visit record
--   NOTICE: child back-dated a SIBLING's vaccination and cleared the next-due
--   NOTICE: child deleted a SIBLING's vaccination record
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/health-record-boundary-check.sql
--
-- Re-runnable: the fixture family's rows are cleared before each run.
-- Audit C1-S8-03.
do $$
declare
  fam uuid := 'f0326000-0000-4000-8000-00000000fa01';
  up  uuid := 'f0326000-0000-4000-8000-00000000c001';  -- parent
  uk  uuid := 'f0326000-0000-4000-8000-00000000c002';  -- child (the attacker)
  us  uuid := 'f0326000-0000-4000-8000-00000000c003';  -- sibling (the subject)
  mp uuid; mk uuid; ms uuid; vis uuid; imm uuid; med uuid;
  n int; txt text; dt date; holes text[] := '{}';
begin
  insert into public.families (id, name) values (fam, '0326 health records') on conflict do nothing;
  insert into auth.users (id, email) values
    (up, 'p0326@example.test'), (uk, 'k0326@example.test'), (us, 's0326@example.test')
    on conflict do nothing;
  delete from public.medication_doses where family_id = fam;
  delete from public.medications     where family_id = fam;
  delete from public.health_visits   where family_id = fam;
  delete from public.immunizations   where family_id = fam;
  delete from public.family_members  where family_id = fam;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, up, 'Parent', 'parent', true) returning id into mp;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uk, 'Kid', 'child', true) returning id into mk;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, us, 'Sibling', 'child', true) returning id into ms;

  insert into public.health_visits (family_id, member_id, kind, title, visit_date, outcome, created_by)
    values (fam, ms, 'mental_health', 'Counselling', current_date - 7,
            'Ongoing treatment; review in six weeks', up)
    returning id into vis;
  insert into public.immunizations (family_id, member_id, vaccine, dose_label, date_given, next_due_date, created_by)
    values (fam, ms, 'MMR', 'Dose 2', current_date - 400, current_date + 30, up)
    returning id into imm;
  insert into public.medications (family_id, member_id, name, dosage, is_active, created_by)
    values (fam, ms, 'Amoxicillin', '250 mg', true, up) returning id into med;
  -- A second pair nothing below attacks, so the "can a child still READ the
  -- hub?" control measures RLS rather than the probe's own deletions.
  insert into public.health_visits (family_id, member_id, kind, title, visit_date, created_by)
    values (fam, mp, 'medical', 'Annual physical', current_date - 30, up);
  insert into public.immunizations (family_id, member_id, vaccine, date_given, created_by)
    values (fam, mp, 'Influenza (Flu)', current_date - 200, up);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', uk::text, true);
  if auth.uid() is distinct from uk then
    raise exception '0326: impersonation failed — auth.uid() is %, expected the child; this probe is not testing what it claims', auth.uid();
  end if;

  -- ── 1. Rewriting a sibling's visit notes ──────────────────────────────────
  -- `outcome` is documented in 0068 as "diagnosis / what happened / notes".
  begin
    update public.health_visits set outcome = 'Discharged, no follow-up needed' where id = vis;
    get diagnostics n = row_count;
  exception when insufficient_privilege then n := 0;
  end;
  if n > 0 then
    holes := holes || 'child rewrote a SIBLING''s mental-health visit outcome'::text;
    raise notice 'child rewrote a SIBLING''s mental-health visit outcome';
  end if;

  -- ── 2. Deleting a sibling's visit ─────────────────────────────────────────
  begin
    delete from public.health_visits where id = vis;
    get diagnostics n = row_count;
  exception when insufficient_privilege then n := 0;
  end;
  if n > 0 then
    holes := holes || 'child deleted a SIBLING''s visit record'::text;
    raise notice 'child deleted a SIBLING''s visit record';
  end if;

  -- ── 3. Falsifying a sibling's vaccination ledger ──────────────────────────
  -- 0069 wrote this table for "school/camp/travel forms", and next_due_date is
  -- what dueStatus() turns into the overdue badge.
  begin
    update public.immunizations set date_given = current_date, next_due_date = null where id = imm;
    get diagnostics n = row_count;
  exception when insufficient_privilege then n := 0;
  end;
  if n > 0 then
    holes := holes || 'child back-dated a SIBLING''s vaccination and cleared the next-due'::text;
    raise notice 'child back-dated a SIBLING''s vaccination and cleared the next-due';
  end if;

  begin
    delete from public.immunizations where id = imm;
    get diagnostics n = row_count;
  exception when insufficient_privilege then n := 0;
  end;
  if n > 0 then
    holes := holes || 'child deleted a SIBLING''s vaccination record'::text;
    raise notice 'child deleted a SIBLING''s vaccination record';
  end if;

  -- ── Positive controls: what must NOT change ───────────────────────────────
  -- Reading is the product. Every family member sees the family's health hub.
  select count(*) into n from public.health_visits where family_id = fam;
  if n < 1 then raise exception '0326: the child can no longer READ the family visit history'; end if;
  select count(*) into n from public.immunizations where family_id = fam;
  if n < 1 then raise exception '0326: the child can no longer READ the family vaccination ledger'; end if;

  -- 0309 left `medication_doses` — the "I took it" tick — open on purpose and
  -- asserts it as a positive control. Re-asserted here so this migration cannot
  -- quietly take it away.
  insert into public.medication_doses (family_id, medication_id, member_id, scheduled_for, status)
    values (fam, med, mk, now(), 'taken');
  -- And 0309's own boundary must still hold, so a regression there is not
  -- mistaken for this migration working.
  begin
    update public.medications set dosage = '1000 mg' where id = med;
    get diagnostics n = row_count;
  exception when insufficient_privilege then n := 0;
  end;
  if n > 0 then
    raise exception '0326: 0309 has regressed — a child changed a prescribed dosage';
  end if;

  reset role;

  -- ── A manager must still be able to do all of it ──────────────────────────
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', up::text, true);
  insert into public.health_visits (family_id, member_id, kind, title, visit_date, outcome, created_by)
    values (fam, ms, 'dental', 'Cleaning', current_date, 'No cavities', up) returning id into vis;
  update public.health_visits set outcome = 'One filling' where id = vis;
  select outcome into txt from public.health_visits where id = vis;
  if txt is distinct from 'One filling' then
    raise exception '0326: a parent can no longer edit a visit record (outcome is %)', txt;
  end if;
  delete from public.health_visits where id = vis;

  insert into public.immunizations (family_id, member_id, vaccine, date_given, next_due_date, created_by)
    values (fam, ms, 'Tdap', current_date, current_date + 3650, up) returning id into imm;
  update public.immunizations set next_due_date = current_date + 365 where id = imm;
  select next_due_date into dt from public.immunizations where id = imm;
  if dt is distinct from current_date + 365 then
    raise exception '0326: a parent can no longer edit a vaccination record';
  end if;
  delete from public.immunizations where id = imm;
  reset role;

  if array_length(holes, 1) is not null then
    raise exception '0326: a child may rewrite the family health record: %', array_to_string(holes, '; ');
  end if;
  raise notice '0326 OK — children read the health hub and log their own doses; parents keep the pen';
end $$;
