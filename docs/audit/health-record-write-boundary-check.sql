-- Behavioural proof for 0307, run as real `authenticated` sessions under RLS.
--
-- Nine health tables were `for all using (is_family_member(family_id))`: any
-- member could rewrite or delete any other member's health record. All nine are
-- written directly from the browser and NONE of the six modules that write them
-- contains a role check, so RLS was the only boundary there was.
--
-- 0307 applies TWO rules, and this probe asserts the difference between them
-- rather than treating the nine as one list:
--
--   RULE A (a log you keep about yourself: symptom_logs, health_metrics,
--          health_goals, sleep_logs, sleep_checkins, nutrition_logs)
--          -> a manager, the author, OR the member the row is about.
--   RULE B (a record of medical fact about someone: health_visits,
--          immunizations, care_log)
--          -> a manager or the author, and NOT the subject. A child deleting
--             the record of their own vaccination is the defect, not the
--             feature — which is exactly where A and B part company.
--
-- INSERT is unchanged on all nine and asserted so: 0300 filed "is logging a
-- vaccination any member's to do?" as an owner decision and it is still filed.
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

do $$
declare
  fam        uuid := 'eeee1111-0000-4000-8000-00000000000e';
  parent_uid uuid := 'e1000000-0000-4000-8000-000000000001';
  kidA_uid   uuid := 'e1000000-0000-4000-8000-000000000002';
  kidB_uid   uuid := 'e1000000-0000-4000-8000-000000000003';
  parent_mid uuid;
  kidA_mid   uuid;
  kidB_mid   uuid;
  sym        uuid;
  imm        uuid;
  slp        uuid;
  blocked    boolean;
  n          int;
  v_status   text;
begin
  -- Re-runnable against a database that already holds a previous run's rows.
  delete from public.symptom_logs   where family_id = fam;
  delete from public.immunizations  where family_id = fam;
  delete from public.sleep_logs     where family_id = fam;
  delete from public.family_members where user_id in (parent_uid, kidA_uid, kidB_uid);
  delete from public.families       where id = fam;

  insert into public.families (id, name) values (fam, 'Health');
  insert into auth.users (id, email) values
    (parent_uid, 'ep@example.test'), (kidA_uid, 'ea@example.test'), (kidB_uid, 'eb@example.test')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, parent_uid, 'Parent', 'parent', true) returning id into parent_mid;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, kidA_uid, 'Kid A', 'child', true) returning id into kidA_mid;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, kidB_uid, 'Kid B', 'child', true) returning id into kidB_mid;

  -- ── As the PARENT: records ABOUT Kid A, authored by the parent ───────────
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;

  insert into public.symptom_logs (family_id, member_id, symptom, severity, created_by)
  values (fam, kidA_mid, 'Sore throat', 3, parent_uid) returning id into sym;
  insert into public.immunizations (family_id, member_id, vaccine, created_by)
  values (fam, kidA_mid, 'MMR', parent_uid) returning id into imm;
  insert into public.sleep_logs (family_id, member_id, sleep_date, bedtime, wake_time, duration_min, created_by)
  values (fam, kidA_mid, current_date, now() - interval '9 hours', now() - interval '1 hour', 480, parent_uid)
  returning id into slp;

  -- ── As KID B: another child's records are none of their business ─────────
  reset role;
  perform set_config('request.jwt.claim.sub', kidB_uid::text, true);
  set local role authenticated;

  -- 1. RULE A: cannot rewrite a sibling's symptom log. Before 0307: UPDATE 1.
  update public.symptom_logs set status = 'resolved' where id = sym;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child rewrote a sibling''s symptom log (%)', n;
  end if;

  -- 2. RULE A: cannot delete a sibling's sleep log.
  delete from public.sleep_logs where id = slp;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child deleted a sibling''s sleep log (%)', n;
  end if;

  -- 3. RULE B: cannot delete a sibling's vaccination record.
  delete from public.immunizations where id = imm;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child deleted a sibling''s vaccination record (%)', n;
  end if;

  -- Positive control: Kid B still READS the family's health records, which is
  -- deliberately unchanged — narrowing reads is an owner decision, still filed.
  select count(*) into n from public.symptom_logs where family_id = fam;
  if n = 0 then
    raise exception 'a child can no longer read the family''s health records';
  end if;
  -- And still records their own. INSERT is unchanged on all nine.
  insert into public.symptom_logs (family_id, member_id, symptom, severity, created_by)
  values (fam, kidB_mid, 'Headache', 2, kidB_uid);
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a child can no longer record their own symptom (%)', n;
  end if;

  -- ── As KID A: the SUBJECT of all three rows. This is where A and B part ──
  reset role;
  perform set_config('request.jwt.claim.sub', kidA_uid::text, true);
  set local role authenticated;

  -- 4. RULE A: the subject MAY correct a log about themselves, even one a
  --    parent wrote. Three of these tables upsert on (member_id, date), so the
  --    second entry of the day IS an update; an author-only rule would refuse
  --    a child their own correction the moment a parent logged one first.
  update public.symptom_logs set status = 'resolved' where id = sym;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'the subject can no longer correct their own symptom log (%)', n;
  end if;
  select status into v_status from public.symptom_logs where id = sym;
  if v_status is distinct from 'resolved' then
    raise exception 'the subject''s own correction did not take (now %)', v_status;
  end if;

  update public.sleep_logs set quality = 4 where id = slp;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'the subject can no longer correct their own sleep log (%)', n;
  end if;

  -- 5. RULE B: the subject may NOT erase the record of their own vaccination.
  delete from public.immunizations where id = imm;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child deleted the record of their own vaccination (%)', n;
  end if;
  select count(*) into n from public.immunizations where id = imm;
  if n <> 1 then
    raise exception 'the vaccination record is gone despite the refusal';
  end if;

  -- ── As the PARENT: a manager still manages everything ────────────────────
  reset role;
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;

  update public.immunizations set vaccine = 'MMR (booster)' where id = imm;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a parent can no longer correct a vaccination record (%)', n;
  end if;
  delete from public.immunizations where id = imm;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a parent can no longer delete a vaccination record (%)', n;
  end if;

  reset role;
  raise notice 'health-record-write-boundary-check OK: a sibling rewrites nothing; the subject corrects their own logs but cannot erase a medical record; a manager still manages all nine';
end $$;
