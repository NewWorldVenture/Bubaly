-- ── The household's day is written by a parent or another adult (0529) ───────
--
-- OPSD-O06 and COORD-O01: family_operating_index, reasoning_snapshots and
-- workload_snapshots are the day and the week the parents trend, written by the
-- app only from a household-reach load (a parent's or adult's) or the service
-- role, and their policies let any member write them. The held 0529 puts a
-- parent-or-adult guard on all three.
--
-- Fixture, Day House: a parent, an adult, a teen, a child and a caregiver;
-- today's operating index and reasoning snapshot, and this week's workload row
-- for the child.
--
-- What this probe asserts, through PostgREST's role, each attempt in its own
-- rolled-back subtransaction:
--
--   1. as the teen, the child and the caregiver, each refused by 0529's guard
--      (42501, its own sentence), on each table: an unfiltered rewrite, a new
--      row, and an unfiltered delete (where the table has a delete policy, or
--      none, the delete answering OK 0 is accepted);
--   2. control: the parent and the adult each rewrite, file and delete on all
--      three (the household-reach upserts); every member still reads all three;
--      the server (service_role, no user) files on all three; the child's
--      member row removed in the child's own session takes their workload rows
--      with it; the household deleted in the parent's session takes all three;
--   3. wiring: each table carries the guard, enabled, FOR EACH ROW, BEFORE
--      INSERT, UPDATE and DELETE, SECURITY DEFINER;
--
-- and, only where 0529 is installed:
--
--   N1. NEGATIVE CONTROL: with the guards disabled, the child's rewrites land
--       on all three: the fixture reaches the defect;
--   M1. MUTATION CONTROL: with the guard checking the new row only, the
--       child's unfiltered workload delete lands, so 1. catches the delete
--       half going.
--
-- Everything is rolled back. This needs none of the other held files.
--
-- HELD with 0529: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/household-day-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0529 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8529-0000000000a1','c0529-parent@example.com'),
  ('00000000-0000-4000-8529-0000000000a2','c0529-adult@example.com'),
  ('00000000-0000-4000-8529-0000000000a3','c0529-teen@example.com'),
  ('00000000-0000-4000-8529-0000000000a4','c0529-child@example.com'),
  ('00000000-0000-4000-8529-0000000000a5','c0529-caregiver@example.com')
  on conflict do nothing;
-- on_family_created files the creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8529-0000000000f1','Day House','00000000-0000-4000-8529-0000000000a1');
update public.family_members set role = 'parent', is_active = true
 where user_id = '00000000-0000-4000-8529-0000000000a1';
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8529-0000000000d2','00000000-0000-4000-8529-0000000000f1','00000000-0000-4000-8529-0000000000a2','Adult','adult',true),
  ('00000000-0000-4000-8529-0000000000d3','00000000-0000-4000-8529-0000000000f1','00000000-0000-4000-8529-0000000000a3','Teen','teen',true),
  ('00000000-0000-4000-8529-0000000000d4','00000000-0000-4000-8529-0000000000f1','00000000-0000-4000-8529-0000000000a4','Child','child',true),
  ('00000000-0000-4000-8529-0000000000d5','00000000-0000-4000-8529-0000000000f1','00000000-0000-4000-8529-0000000000a5','Caregiver','caregiver',true);
insert into public.family_operating_index (family_id, as_of_date, composite, band) values
  ('00000000-0000-4000-8529-0000000000f1', date '2026-10-26', 72, 'steady');
insert into public.reasoning_snapshots (family_id, as_of_date, all_clear, attention_count) values
  ('00000000-0000-4000-8529-0000000000f1', date '2026-10-26', false, 3);
insert into public.workload_snapshots (family_id, member_id, week_start, load_score, share_pct) values
  ('00000000-0000-4000-8529-0000000000f1', '00000000-0000-4000-8529-0000000000d4', date '2026-10-26', 40, 25);

-- One statement as one caller, and exactly what happened; back to the owner
-- with no user id. p_uid '' is a caller with no user (the service role).
create or replace function pg_temp.c0529_as(p_role text, p_uid text, p_sql text) returns text
language plpgsql as $fn$
declare n bigint; got text;
begin
  perform set_config('role', p_role, true);
  perform set_config('request.jwt.claim.sub', p_uid, true);
  perform set_config('request.jwt.claims', case when p_uid = '' then json_build_object('role', p_role)
                                                 else json_build_object('sub', p_uid, 'role', p_role) end::text, true);
  begin
    execute p_sql;
    get diagnostics n = row_count;
    got := 'OK ' || n;
  exception when others then
    got := sqlstate || ': ' || sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return got;
end
$fn$;

-- The same, undone afterwards, so no attempt changes what the next one sees.
create or replace function pg_temp.c0529_try(p_role text, p_uid text, p_sql text) returns text
language plpgsql as $fn$
declare got text;
begin
  begin
    got := pg_temp.c0529_as(p_role, p_uid, p_sql);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  return got;
end
$fn$;

-- Each table, its unfiltered rewrite, a new row, and whether a member's delete
-- has a policy at all (without one RLS answers OK 0 before any trigger runs).
create temp table c0529_tables (tbl text, rewrite text, new_row text, delete_policy boolean) on commit drop;
insert into c0529_tables values
  ('family_operating_index',
   'update public.family_operating_index set composite = 100, band = ''thriving''',
   'insert into public.family_operating_index (family_id, as_of_date, composite, band) values (''00000000-0000-4000-8529-0000000000f1'', date ''2026-10-27'', 100, ''thriving'')',
   false),
  ('reasoning_snapshots',
   'update public.reasoning_snapshots set all_clear = true, attention_count = 0',
   'insert into public.reasoning_snapshots (family_id, as_of_date, all_clear, attention_count) values (''00000000-0000-4000-8529-0000000000f1'', date ''2026-10-27'', true, 0)',
   false),
  ('workload_snapshots',
   'update public.workload_snapshots set share_pct = 90, load_score = 100',
   'insert into public.workload_snapshots (family_id, member_id, week_start, load_score, share_pct) values (''00000000-0000-4000-8529-0000000000f1'', ''00000000-0000-4000-8529-0000000000d3'', date ''2026-10-26'', 100, 90)',
   true);

do $$
declare
  guard constant text := '42501: The household''s day is kept by a parent or another adult';
  parent constant text := '00000000-0000-4000-8529-0000000000a1';
  child constant text := '00000000-0000-4000-8529-0000000000a4';
  failures text[] := '{}';
  bad text[];
  installed boolean;
  m record;
  t record;
  got text;
  n bigint;
begin
  installed := (select count(*) from pg_trigger g
                 where g.tgfoid = to_regprocedure('public.a_household_day_is_written_by_a_parent_or_adult()')) = 3;

  -- 1. What the teen, the child and the caregiver may not do.
  for m in select * from (values ('teen', '00000000-0000-4000-8529-0000000000a3'),
                                 ('child', '00000000-0000-4000-8529-0000000000a4'),
                                 ('caregiver', '00000000-0000-4000-8529-0000000000a5')) v(role, uid) loop
    for t in select * from c0529_tables loop
      got := pg_temp.c0529_try('authenticated', m.uid, t.rewrite);
      if got like 'OK%' then
        failures := array_append(failures, format('the %s rewrote %s (%s)', m.role, t.tbl, got));
      elsif got is distinct from guard then
        failures := array_append(failures, format('the %s''s rewrite of %s was refused, but not by 0529''s guard (%s)', m.role, t.tbl, got));
      end if;
      got := pg_temp.c0529_try('authenticated', m.uid, t.new_row);
      if got like 'OK%' then
        failures := array_append(failures, format('the %s filed a row in %s (%s)', m.role, t.tbl, got));
      elsif got is distinct from guard then
        failures := array_append(failures, format('the %s''s new row in %s was refused, but not by 0529''s guard (%s)', m.role, t.tbl, got));
      end if;
      got := pg_temp.c0529_try('authenticated', m.uid, format('delete from public.%I', t.tbl));
      if t.delete_policy and got like 'OK%' then
        failures := array_append(failures, format('the %s deleted %s (%s)', m.role, t.tbl, got));
      elsif not t.delete_policy and got <> 'OK 0' then
        failures := array_append(failures, format('the %s''s delete of %s, which has no delete policy, answered %s', m.role, t.tbl, got));
      elsif t.delete_policy and got is distinct from guard then
        failures := array_append(failures, format('the %s''s delete of %s was refused, but not by 0529''s guard (%s)', m.role, t.tbl, got));
      end if;
    end loop;
  end loop;

  -- 2. Controls.
  bad := '{}';
  for m in select * from (values ('parent', '00000000-0000-4000-8529-0000000000a1'),
                                 ('adult', '00000000-0000-4000-8529-0000000000a2')) v(role, uid) loop
    for t in select * from c0529_tables loop
      got := pg_temp.c0529_try('authenticated', m.uid, t.rewrite);
      if got <> 'OK 1' then bad := array_append(bad, format('the %s could not rewrite %s (%s)', m.role, t.tbl, got)); end if;
      got := pg_temp.c0529_try('authenticated', m.uid, t.new_row);
      if got <> 'OK 1' then bad := array_append(bad, format('the %s could not file a row in %s (%s)', m.role, t.tbl, got)); end if;
      if t.delete_policy then
        got := pg_temp.c0529_try('authenticated', m.uid, format('delete from public.%I', t.tbl));
        if got <> 'OK 1' then bad := array_append(bad, format('the %s could not delete %s (%s)', m.role, t.tbl, got)); end if;
      end if;
    end loop;
  end loop;
  for m in select * from (values ('teen', '00000000-0000-4000-8529-0000000000a3'),
                                 ('child', '00000000-0000-4000-8529-0000000000a4'),
                                 ('caregiver', '00000000-0000-4000-8529-0000000000a5')) v(role, uid) loop
    for t in select * from c0529_tables loop
      got := pg_temp.c0529_try('authenticated', m.uid, format('select id from public.%I', t.tbl));
      if got <> 'OK 1' then bad := array_append(bad, format('the %s could not read %s (%s)', m.role, t.tbl, got)); end if;
    end loop;
  end loop;
  for t in select * from c0529_tables loop
    got := pg_temp.c0529_try('service_role', '', t.new_row);
    if got <> 'OK 1' then bad := array_append(bad, format('the server could not file a row in %s (%s)', t.tbl, got)); end if;
  end loop;
  -- The child's member row, removed in the child's own session.
  begin
    perform set_config('request.jwt.claim.sub', child, true);
    perform set_config('request.jwt.claims', json_build_object('sub', child, 'role', 'authenticated')::text, true);
    begin
      delete from public.family_members where id = '00000000-0000-4000-8529-0000000000d4';
      if exists (select 1 from public.workload_snapshots where member_id = '00000000-0000-4000-8529-0000000000d4') then
        bad := array_append(bad, 'removing the child''s member row left their workload rows');
      end if;
    exception when others then
      bad := array_append(bad, format('removing the child''s member row in their session failed (%s: %s)', sqlstate, sqlerrm));
    end;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  -- The household, deleted in the parent's session.
  begin
    perform set_config('request.jwt.claim.sub', parent, true);
    perform set_config('request.jwt.claims', json_build_object('sub', parent, 'role', 'authenticated')::text, true);
    begin
      delete from public.families where id = '00000000-0000-4000-8529-0000000000f1';
      select (select count(*) from public.family_operating_index where family_id = '00000000-0000-4000-8529-0000000000f1')
           + (select count(*) from public.reasoning_snapshots where family_id = '00000000-0000-4000-8529-0000000000f1')
           + (select count(*) from public.workload_snapshots where family_id = '00000000-0000-4000-8529-0000000000f1') into n;
      if n <> 0 then
        bad := array_append(bad, format('deleting the household left %s of its rows', n));
      end if;
    exception when others then
      bad := array_append(bad, format('deleting the household in the parent''s session failed (%s: %s)', sqlstate, sqlerrm));
    end;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  if cardinality(bad) > 0 then
    failures := array_append(failures, 'CONTROL: ' || array_to_string(bad, '; '));
  end if;

  -- 3. Wiring.
  bad := '{}';
  for t in select * from c0529_tables loop
    if not exists (select 1 from pg_trigger g join pg_proc p on p.oid = g.tgfoid
                    where g.tgrelid = ('public.' || t.tbl)::regclass
                      and g.tgname = 'trg_' || t.tbl || '_parent_or_adult'
                      and g.tgfoid = to_regprocedure('public.a_household_day_is_written_by_a_parent_or_adult()')
                      and g.tgenabled <> 'D' and (g.tgtype & 1) = 1 and (g.tgtype & 2) = 2 and (g.tgtype & 28) = 28
                      and p.prosecdef) then
      bad := array_append(bad, t.tbl);
    end if;
  end loop;
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('0529''s guard is not in place on %s', array_to_string(bad, ', ')));
  end if;

  if installed then
    -- N1. The guards disabled.
    begin
      for t in select * from c0529_tables loop
        execute format('alter table public.%I disable trigger %I', t.tbl, 'trg_' || t.tbl || '_parent_or_adult');
      end loop;
      bad := '{}';
      for t in select * from c0529_tables loop
        got := pg_temp.c0529_try('authenticated', child, t.rewrite);
        if got <> 'OK 1' then bad := array_append(bad, format('%s (%s)', t.tbl, got)); end if;
      end loop;
      if cardinality(bad) > 0 then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the guards disabled the child''s rewrite still did not land on %s, so this fixture cannot see the defect', array_to_string(bad, ', ')));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. The guard checking the new row only.
    begin
      create or replace function public.a_household_day_is_written_by_a_parent_or_adult()
      returns trigger language plpgsql security definer set search_path = public, pg_temp as $m$
      begin
        if auth.uid() is null then return case when tg_op = 'DELETE' then old else new end; end if;
        if tg_op <> 'DELETE' and not public.can_manage_family(new.family_id) then
          raise exception 'The household''s day is kept by a parent or another adult' using errcode = '42501';
        end if;
        return case when tg_op = 'DELETE' then old else new end;
      end $m$;
      got := pg_temp.c0529_try('authenticated', child, 'delete from public.workload_snapshots');
      if got <> 'OK 1' then
        failures := array_append(failures, format('MUTATION CONTROL: with the guard checking the new row only the child''s workload delete still did not land (%s), so 1. cannot catch the delete half going', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'the household''s day is not only a parent''s or adult''s to write:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'the-households-day-is-written-by-a-parent-or-adult: OK (as the teen, the child and the caregiver, rewriting, filing and deleting the operating index, the reasoning snapshot and the workload history were each refused by 0529''s guard, or found no delete policy; parents and adults rewrite, file and delete all three; everyone still reads them; the server files them; a member''s removal in their own session and the household''s deletion still go through; the guard is on all three; negative control: with the guards disabled the child''s rewrites landed; mutation control: with the guard checking the new row only the child''s delete landed)';
end $$;

rollback;
