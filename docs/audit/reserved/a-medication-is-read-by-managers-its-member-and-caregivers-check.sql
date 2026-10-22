-- ── A medication is read by managers, its member and caregivers (0511) ────────
--
-- medications and medication_schedules read with is_family_member(family_id)
-- (0434), so a teen or a child reads every prescription in the household, a
-- parent's antidepressant included. The held 0511 replaces both reads: a
-- medication is read by a manager of its family, the member it is for, or a
-- caregiver, inside is_family_member(family_id); one saved with no member (the
-- Medicines form's default, "Whole family") by a manager or a caregiver; and a
-- schedule exactly when its medication is.
--
-- Fixture, Pill House: a parent and an adult (managers), a teen (who is also
-- the parent of a household of their own), a child, a caregiver, a guest, a
-- ward with no login, and a caregiver since removed (is_active false). Each
-- medication below has one schedule:
--
--   the parent's prescription saved with no member (the form's default)
--   the parent's prescription saved for the parent
--   the ward's, the teen's and the child's
--   in the teen's own household: its ward's
--
-- What this probe asserts, through PostgREST's role, on both tables:
--
--   1. the teen and the child read only their own medication and its
--      schedule (1 and 1), not the parent's with no member, not the parent's
--      own, not the ward's or a sibling's (counted);
--   2. the guest reads none;
--   3. control: the parent, the adult and the caregiver read every Pill House
--      medication and schedule (5 and 5);
--   4. control: the teen reads the medication and schedule in the household
--      they manage (1 and 1), so 1. is the row's family deciding;
--   5. the removed caregiver and a stranger read nothing;
--   6. control: the service role, carrying the child's user id and without
--      one, reads every Pill House medication and schedule;
--   7. control: the writes the screens make still come back: the parent adds a
--      medication and a schedule (insert … returning, OK 1 each), and the child
--      ticks their own dose (OK 1; doses are 0481's and unchanged);
--   8. wiring: one permissive read policy per table, by 0511's names, granted
--      to authenticated, USING exactly 0511's predicates; the only restrictive
--      read is a guest's (the held 0509's);
--
-- and, only where 0511 is installed, each in a rolled-back subtransaction:
--
--   N1. NEGATIVE CONTROL: with the family-wide read put back on medications
--       alone, the child reads the parent's prescription with no member AND
--       its schedule (1 and 1): the fixture reaches the limit, and the
--       schedule follows its medication;
--   N2. NEGATIVE CONTROL: with the family-wide read put back on schedules
--       alone, the child reads that schedule (1) though not the medication
--       (0), so the schedule read is 0511's to close;
--   M1. MUTATION CONTROL: with 0511's outer is_family_member(family_id) taken
--       off medications, the removed caregiver reads the ward's medication (1),
--       so 5. is what catches a rule that forgets a member can leave.
--
-- Everything is rolled back.
--
-- HELD with 0511: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/medication-reads-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0511 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8511-0000000000a1','m0511-parent@example.com'),
  ('00000000-0000-4000-8511-0000000000a2','m0511-adult@example.com'),
  ('00000000-0000-4000-8511-0000000000a3','m0511-teen@example.com'),
  ('00000000-0000-4000-8511-0000000000a4','m0511-child@example.com'),
  ('00000000-0000-4000-8511-0000000000a5','m0511-caregiver@example.com'),
  ('00000000-0000-4000-8511-0000000000a6','m0511-guest@example.com'),
  ('00000000-0000-4000-8511-0000000000a8','m0511-gone@example.com'),
  ('00000000-0000-4000-8511-0000000000a9','m0511-stranger@example.com')
  on conflict do nothing;
-- on_family_created files each creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8511-0000000000f1','Pill House','00000000-0000-4000-8511-0000000000a1'),
  ('00000000-0000-4000-8511-0000000000f2','Teen''s Own House','00000000-0000-4000-8511-0000000000a3'),
  ('00000000-0000-4000-8511-0000000000f3','Next Door','00000000-0000-4000-8511-0000000000a9');
update public.family_members set role = 'parent', is_active = true
 where user_id in ('00000000-0000-4000-8511-0000000000a1','00000000-0000-4000-8511-0000000000a3','00000000-0000-4000-8511-0000000000a9');
update public.family_members set id = '00000000-0000-4000-8511-0000000000c1'
 where family_id = '00000000-0000-4000-8511-0000000000f1' and user_id = '00000000-0000-4000-8511-0000000000a1';
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8511-0000000000c2','00000000-0000-4000-8511-0000000000f1','00000000-0000-4000-8511-0000000000a2','Adult','adult',true),
  ('00000000-0000-4000-8511-0000000000c3','00000000-0000-4000-8511-0000000000f1','00000000-0000-4000-8511-0000000000a3','Teen','teen',true),
  ('00000000-0000-4000-8511-0000000000c4','00000000-0000-4000-8511-0000000000f1','00000000-0000-4000-8511-0000000000a4','Child','child',true),
  ('00000000-0000-4000-8511-0000000000c5','00000000-0000-4000-8511-0000000000f1','00000000-0000-4000-8511-0000000000a5','Caregiver','caregiver',true),
  ('00000000-0000-4000-8511-0000000000c6','00000000-0000-4000-8511-0000000000f1','00000000-0000-4000-8511-0000000000a6','Guest','guest',true),
  ('00000000-0000-4000-8511-0000000000c7','00000000-0000-4000-8511-0000000000f1',null,'Ward','child',true),
  ('00000000-0000-4000-8511-0000000000c8','00000000-0000-4000-8511-0000000000f1','00000000-0000-4000-8511-0000000000a8','Caregiver (removed)','caregiver',false),
  ('00000000-0000-4000-8511-0000000000c9','00000000-0000-4000-8511-0000000000f2',null,'Teen''s ward','child',true);

create temp table m0511_rows (kind text, med uuid, sched uuid) on commit drop;

-- One medication and its schedule, as the Medicines page saves them.
do $$
declare
  f1 constant uuid := '00000000-0000-4000-8511-0000000000f1';
  f2 constant uuid := '00000000-0000-4000-8511-0000000000f2';
  x  record;
  m  uuid;
  sc uuid;
begin
  for x in select * from (values
      ('parent-no-member', f1, null::uuid,                                   'Sertraline'),
      ('parent-own',       f1, '00000000-0000-4000-8511-0000000000c1'::uuid, 'Lisinopril'),
      ('ward',             f1, '00000000-0000-4000-8511-0000000000c7'::uuid, 'Amoxicillin'),
      ('teen',             f1, '00000000-0000-4000-8511-0000000000c3'::uuid, 'Methylphenidate'),
      ('child',            f1, '00000000-0000-4000-8511-0000000000c4'::uuid, 'Cetirizine'),
      ('elsewhere',        f2, '00000000-0000-4000-8511-0000000000c9'::uuid, 'Ibuprofen')) as v(kind, fam, member, name) loop
    insert into public.medications (family_id, member_id, name, dosage, is_active, created_by)
      values (x.fam, x.member, x.name, '10mg', true, '00000000-0000-4000-8511-0000000000a1') returning id into m;
    insert into public.medication_schedules (family_id, medication_id, time_of_day)
      values (x.fam, m, time '08:00') returning id into sc;
    insert into m0511_rows values (x.kind, m, sc);
  end loop;
end $$;

-- The ids of one family's rows in one table, as one caller sees them; null if
-- the read itself was refused.
create or replace function pg_temp.m0511_seen(p_role text, p_uid text, t text, fam uuid) returns uuid[]
language plpgsql as $fn$
declare ids uuid[];
begin
  perform set_config('role', p_role, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), true);
  perform set_config('request.jwt.claims',
    case when p_uid is null then json_build_object('role', p_role)
         else json_build_object('sub', p_uid, 'role', p_role) end::text, true);
  begin
    execute format('select coalesce(array_agg(id), ''{}'') from public.%I where family_id = $1', t) into ids using fam;
  exception when others then
    ids := null;
  end;
  perform set_config('role', 'postgres', true);
  return ids;
end
$fn$;

-- One statement as one signed-in user, and exactly what happened.
create or replace function pg_temp.m0511_as(p_uid text, p_sql text) returns text
language plpgsql as $fn$
declare n bigint; got text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_uid, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  begin
    execute p_sql;
    get diagnostics n = row_count;
    got := 'OK ' || n;
  exception when others then
    got := sqlstate || ': ' || sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  return got;
end
$fn$;

do $$
declare
  f1        constant uuid := '00000000-0000-4000-8511-0000000000f1';
  f2        constant uuid := '00000000-0000-4000-8511-0000000000f2';
  parent    constant text := '00000000-0000-4000-8511-0000000000a1';
  child     constant text := '00000000-0000-4000-8511-0000000000a4';
  carer     constant text := '00000000-0000-4000-8511-0000000000a5';
  gone      constant text := '00000000-0000-4000-8511-0000000000a8';
  med_rule  constant text := '(is_family_member(family_id) AND (can_manage_family(family_id) OR is_self_member(member_id) OR (family_role(family_id) = ''caregiver''::member_role)))';
  installed boolean := exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = 'medications'
                                 and p.policyname = 'A medication is read by a manager, its member or a caregiver');
  failures  text[] := '{}';
  x         record;
  meds      uuid[];
  scheds    uuid[];
  own_m     uuid[];
  own_s     uuid[];
  all_m     uuid[];
  all_s     uuid[];
  bad       text[];
  n         int;
  got       text;
  q         text;
begin
  select array_agg(med), array_agg(sched) into all_m, all_s from m0511_rows where kind <> 'elsewhere';

  -- 1. The teen and the child.
  for x in select * from (values ('teen', '00000000-0000-4000-8511-0000000000a3'),
                                 ('child', '00000000-0000-4000-8511-0000000000a4')) as v(who, uid) loop
    meds := pg_temp.m0511_seen('authenticated', x.uid, 'medications', f1);
    scheds := pg_temp.m0511_seen('authenticated', x.uid, 'medication_schedules', f1);
    select array_agg(med), array_agg(sched) into own_m, own_s from m0511_rows where kind = x.who;
    if meds is null or scheds is null then
      failures := array_append(failures, format('CONTROL: the %s''s read was refused', x.who));
      continue;
    end if;
    select count(*) into n from unnest(meds) s(id) where s.id <> all (own_m);
    if n <> 0 then
      failures := array_append(failures, format('the %s reads %s medications that are not theirs, the parent''s with no member %s',
        x.who, n, case when (select med from m0511_rows where kind = 'parent-no-member') = any (meds) then 'among them' else 'not' end));
    end if;
    select count(*) into n from unnest(scheds) s(id) where s.id <> all (own_s);
    if n <> 0 then
      failures := array_append(failures, format('the %s reads %s schedules of medications that are not theirs', x.who, n));
    end if;
    if not (meds @> own_m and scheds @> own_s) then
      failures := array_append(failures, format('CONTROL: the %s no longer reads their own medication and its schedule', x.who));
    end if;
  end loop;

  -- 2. The guest.
  meds := pg_temp.m0511_seen('authenticated', '00000000-0000-4000-8511-0000000000a6', 'medications', f1);
  scheds := pg_temp.m0511_seen('authenticated', '00000000-0000-4000-8511-0000000000a6', 'medication_schedules', f1);
  if coalesce(cardinality(meds), 0) <> 0 or coalesce(cardinality(scheds), 0) <> 0 then
    failures := array_append(failures, format('the guest reads %s medications and %s schedules', coalesce(cardinality(meds), 0), coalesce(cardinality(scheds), 0)));
  end if;

  -- 3. The managers and the caregiver, and 6. the service role with and without a user id.
  for x in select * from (values ('the parent', 'authenticated', parent),
                                 ('the adult', 'authenticated', '00000000-0000-4000-8511-0000000000a2'),
                                 ('the caregiver', 'authenticated', carer),
                                 ('the service role (with the child''s user id)', 'service_role', child),
                                 ('the service role (no user id)', 'service_role', null)) as v(who, role, uid) loop
    meds := pg_temp.m0511_seen(x.role, x.uid, 'medications', f1);
    scheds := pg_temp.m0511_seen(x.role, x.uid, 'medication_schedules', f1);
    if meds is null or scheds is null or not (meds @> all_m and all_m @> meds and scheds @> all_s and all_s @> scheds) then
      failures := array_append(failures, format('CONTROL: %s does not read every Pill House medication and schedule (%s of 5, %s of 5)',
        x.who, coalesce(cardinality(meds)::text, 'refused'), coalesce(cardinality(scheds)::text, 'refused')));
    end if;
  end loop;

  -- 4. The teen manages a household of their own.
  meds := pg_temp.m0511_seen('authenticated', '00000000-0000-4000-8511-0000000000a3', 'medications', f2);
  scheds := pg_temp.m0511_seen('authenticated', '00000000-0000-4000-8511-0000000000a3', 'medication_schedules', f2);
  if coalesce(cardinality(meds), -1) <> 1 or coalesce(cardinality(scheds), -1) <> 1 then
    failures := array_append(failures, format('CONTROL: the teen does not read the medication and schedule in the household they manage (%s, %s)',
      coalesce(cardinality(meds)::text, 'refused'), coalesce(cardinality(scheds)::text, 'refused')));
  end if;

  -- 5. The removed caregiver and the stranger.
  for x in select * from (values ('the removed caregiver', gone),
                                 ('a stranger', '00000000-0000-4000-8511-0000000000a9')) as v(who, uid) loop
    meds := pg_temp.m0511_seen('authenticated', x.uid, 'medications', f1);
    scheds := pg_temp.m0511_seen('authenticated', x.uid, 'medication_schedules', f1);
    if coalesce(cardinality(meds), 0) <> 0 or coalesce(cardinality(scheds), 0) <> 0 then
      failures := array_append(failures, format('%s reads %s Pill House medications and %s schedules', x.who, coalesce(cardinality(meds), 0), coalesce(cardinality(scheds), 0)));
    end if;
  end loop;

  -- 7. The screens' writes come back.
  got := pg_temp.m0511_as(parent, format(
    'insert into public.medications (family_id, member_id, name, dosage, is_active, created_by) values (%L, %L, %L, %L, true, %L) returning id',
    f1, '00000000-0000-4000-8511-0000000000c4', 'm0511 new', '5ml', parent));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: the parent''s new medication, inserted with returning, did not come back (%s)', got));
  end if;
  got := pg_temp.m0511_as(parent, format(
    'insert into public.medication_schedules (family_id, medication_id, time_of_day) values (%L, %L, %L) returning id',
    f1, (select med from m0511_rows where kind = 'ward'), '20:00'));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: the parent''s new schedule, inserted with returning, did not come back (%s)', got));
  end if;
  select format('insert into public.medication_doses (family_id, medication_id, schedule_id, member_id, scheduled_for, status, taken_at, logged_by) '
                || 'values (%L, %L, %L, %L, now(), ''taken'', now(), %L)',
                f1, r.med, r.sched, '00000000-0000-4000-8511-0000000000c4', child)
    into q from m0511_rows r where r.kind = 'child';
  got := pg_temp.m0511_as(child, q);
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: the child could not tick their own dose (%s)', got));
  end if;

  -- 8. Wiring.
  bad := '{}';
  select count(*) into n from pg_policies p
   where p.schemaname = 'public' and p.tablename = 'medications' and p.permissive = 'PERMISSIVE' and p.cmd in ('SELECT', 'ALL');
  if n <> 1 or not exists (select 1 from pg_policies p
                            where p.schemaname = 'public' and p.tablename = 'medications'
                              and p.policyname = 'A medication is read by a manager, its member or a caregiver'
                              and p.permissive = 'PERMISSIVE' and p.cmd = 'SELECT' and p.roles::text[] = array['authenticated']
                              and replace(p.qual, 'public.', '') = med_rule) then
    bad := array_append(bad, format('medications (%s permissive read polic(ies): %s)', n,
      (select string_agg(p.policyname || ' USING ' || replace(p.qual, 'public.', ''), '; ') from pg_policies p
        where p.schemaname = 'public' and p.tablename = 'medications' and p.permissive = 'PERMISSIVE' and p.cmd in ('SELECT', 'ALL'))));
  end if;
  select count(*) into n from pg_policies p
   where p.schemaname = 'public' and p.tablename = 'medication_schedules' and p.permissive = 'PERMISSIVE' and p.cmd in ('SELECT', 'ALL');
  if n <> 1 or not exists (select 1 from pg_policies p
                            where p.schemaname = 'public' and p.tablename = 'medication_schedules'
                              and p.policyname = 'A schedule is read with its medication'
                              and p.permissive = 'PERMISSIVE' and p.cmd = 'SELECT' and p.roles::text[] = array['authenticated']
                              and regexp_replace(replace(p.qual, 'public.', ''), '\s+', ' ', 'g')
                                  = '(is_family_member(family_id) AND (EXISTS ( SELECT 1 FROM medications m WHERE ((m.id = medication_schedules.medication_id) AND (m.family_id = medication_schedules.family_id)))))') then
    bad := array_append(bad, format('medication_schedules (%s permissive read polic(ies): %s)', n,
      (select string_agg(p.policyname || ' USING ' || regexp_replace(replace(p.qual, 'public.', ''), '\s+', ' ', 'g'), '; ') from pg_policies p
        where p.schemaname = 'public' and p.tablename = 'medication_schedules' and p.permissive = 'PERMISSIVE' and p.cmd in ('SELECT', 'ALL'))));
  end if;
  if exists (select 1 from pg_policies p
              where p.schemaname = 'public' and p.tablename in ('medications', 'medication_schedules')
                and p.permissive = 'RESTRICTIVE' and p.cmd in ('SELECT', 'ALL')
                and p.policyname <> 'A guest does not read ' || p.tablename) then
    bad := array_append(bad, 'a restrictive read policy other than a guest''s');
  end if;
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('the read is not 0511''s on %s', array_to_string(bad, ' | ')));
  end if;

  if installed then
    -- N1. The family-wide read put back on medications alone.
    begin
      create policy m0511_n1 on public.medications for select to authenticated using (public.is_family_member(family_id));
      meds := pg_temp.m0511_seen('authenticated', child, 'medications', f1);
      scheds := pg_temp.m0511_seen('authenticated', child, 'medication_schedules', f1);
      if not ((select med from m0511_rows where kind = 'parent-no-member') = any (coalesce(meds, '{}'))
              and (select sched from m0511_rows where kind = 'parent-no-member') = any (coalesce(scheds, '{}'))) then
        failures := array_append(failures, 'NEGATIVE CONTROL: with the family-wide medication read put back the child did not read the parent''s prescription with no member and its schedule, so this fixture cannot see the limit');
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- N2. The family-wide read put back on schedules alone.
    begin
      create policy m0511_n2 on public.medication_schedules for select to authenticated using (public.is_family_member(family_id));
      meds := pg_temp.m0511_seen('authenticated', child, 'medications', f1);
      scheds := pg_temp.m0511_seen('authenticated', child, 'medication_schedules', f1);
      if (select med from m0511_rows where kind = 'parent-no-member') = any (coalesce(meds, '{}'))
         or not (select sched from m0511_rows where kind = 'parent-no-member') = any (coalesce(scheds, '{}')) then
        failures := array_append(failures, 'NEGATIVE CONTROL: with the family-wide schedule read put back the child did not read the parent''s schedule alone, so the schedule read is not shown to be 0511''s');
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. The outer is_family_member taken off medications.
    begin
      drop policy "A medication is read by a manager, its member or a caregiver" on public.medications;
      create policy "A medication is read by a manager, its member or a caregiver" on public.medications for select to authenticated
        using (public.can_manage_family(family_id) or public.is_self_member(member_id) or public.family_role(family_id) = 'caregiver');
      meds := pg_temp.m0511_seen('authenticated', gone, 'medications', f1);
      if not (select med from m0511_rows where kind = 'ward') = any (coalesce(meds, '{}')) then
        failures := array_append(failures, 'MUTATION CONTROL: without the outer is_family_member the removed caregiver did not read the ward''s medication, so 5. cannot catch that rule');
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a medication is read beyond its managers, its member and a caregiver:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-medication-is-read-by-managers-its-member-and-caregivers: OK (the teen and the child read only their own medication and its schedule, not the parent''s saved with no member, the parent''s own, the ward''s or a sibling''s (counted); the guest reads none; the parent, the adult and the caregiver read every Pill House medication and schedule; the teen reads the household they manage; the removed caregiver and a stranger read nothing; the service role with and without a user id reads every row; the parent''s new medication and schedule come back from insert … returning (OK 1) and the child ticks their own dose (OK 1); one permissive read per table with 0511''s exact predicates and no restrictive read but a guest''s; negative controls: with the medication read put back the child reads the parent''s prescription and its schedule, with the schedule read put back the schedule alone; mutation control: without the outer is_family_member the removed caregiver reads the ward''s medication)';
end $$;

rollback;
