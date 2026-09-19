-- Behavioural proof for 0300, run as real `authenticated` sessions under RLS.
--
-- `medications` and `medication_schedules` are written DIRECTLY FROM THE BROWSER
-- and the module's idea of who may write is a React boolean
-- (`const canEdit = isManager(role)`, medications-module.tsx:77). A child is a
-- real Supabase auth user, so a child session can call PostgREST directly and
-- RLS is the only boundary. Before 0328 the child's UPDATE and DELETE succeeded.
-- (This migration was 0300 until main landed its own 0300 for the paywall.)
--
-- Deleting a schedule also silences the medication reminder, so this is a safety
-- surface and not only a record.
--
-- What a member may still do is asserted alongside what they may not: a child
-- still READS the family's medications, and still marks a dose taken or skipped
-- — `medication_doses` is deliberately left member-writable, because the person
-- taking the medicine is the one who records it.
grant usage on schema public to authenticated;
-- No blanket `grant ... on all tables in schema public` here. The bootstrap's
-- `alter default privileges` already gives `authenticated` full DML on every
-- table a migration creates, so the restatement was redundant — and once
-- migrations began revoking DML deliberately (0300 takes the paywall columns
-- away from the client), it stopped being redundant and started undoing them
-- for every probe that runs after this one against the shared database.

do $$
declare
  fam        uuid := 'cccc2222-0000-4000-8000-00000000000c';
  parent_uid uuid := 'c2000000-0000-4000-8000-000000000001';
  child_uid  uuid := 'c2000000-0000-4000-8000-000000000002';
  child_mid  uuid;
  med_id     uuid;
  sched_id   uuid;
  blocked    boolean;
  n          int;
begin
  -- Re-runnable against a database that already holds a previous run's rows.
  delete from public.medication_doses where family_id = fam;
  delete from public.medication_schedules where family_id = fam;
  delete from public.medications where family_id = fam;
  delete from public.family_members where user_id in (parent_uid, child_uid);
  delete from public.families where id = fam;

  insert into public.families (id, name) values (fam, 'Meds') on conflict do nothing;
  insert into auth.users (id, email) values (parent_uid, 'mp@example.test'), (child_uid, 'mc@example.test')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, parent_uid, 'Parent', 'parent', true);
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, child_uid, 'Child', 'child', true) returning id into child_mid;

  -- ── As the PARENT: the positive control, and the fixture ─────────────────
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;

  insert into public.medications (family_id, member_id, name, dosage, instructions, is_active, created_by)
  values (fam, null, 'Sertraline', '50mg', 'One daily with food', true, parent_uid)
  returning id into med_id;
  insert into public.medication_schedules (family_id, medication_id, time_of_day)
  values (fam, med_id, '08:00') returning id into sched_id;

  update public.medications set dosage = '75mg' where id = med_id;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a parent can no longer edit a medication (%)', n;
  end if;

  -- ── As the CHILD ─────────────────────────────────────────────────────────
  reset role;
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- 1. Cannot change a dosage. Before 0328 this was UPDATE 1.
  update public.medications set dosage = '500mg' where id = med_id;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child changed a medication dosage';
  end if;

  -- 2. Cannot delete the medication.
  delete from public.medications where id = med_id;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child deleted a medication';
  end if;

  -- 3. Cannot delete the schedule — which is also what drives the reminder.
  delete from public.medication_schedules where id = sched_id;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child deleted a medication schedule, silencing its reminder';
  end if;

  -- 4. Cannot invent a prescription.
  blocked := false;
  begin
    insert into public.medications (family_id, name, dosage, is_active)
    values (fam, 'Something else', '1000mg', true);
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'a child inserted a medication';
  end if;

  -- 5. READS are unchanged.
  select count(*) into n from public.medications where family_id = fam;
  if n <> 1 then
    raise exception 'a child can no longer see the family medications (%)', n;
  end if;

  -- 6. And a member still records a dose. Manager-only here would break
  --    adherence tracking: the person taking the medicine is the one who marks
  --    it, and the module's buttons are rendered for everyone.
  insert into public.medication_doses (family_id, medication_id, schedule_id, member_id, scheduled_for, status, logged_by)
  values (fam, med_id, sched_id, child_mid, now(), 'taken', child_uid);
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a member can no longer record a dose (%)', n;
  end if;

  -- ── No stray permissive write policy survives ────────────────────────────
  reset role;
  select count(*) into n
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public'
    and c.relname = any (array['medications','medication_schedules'])
    and p.polpermissive
    and p.polcmd in ('a','w','d','*')
    and p.polname not in (c.relname || '_mng_insert', c.relname || '_mng_update', c.relname || '_mng_delete');
  if n <> 0 then
    raise exception '% stray permissive write policy(ies) on the prescription tables', n;
  end if;

  raise notice 'OK prescriptions: a child cannot write or delete a medication or its schedule, still reads them, and still records a dose';
end $$;
