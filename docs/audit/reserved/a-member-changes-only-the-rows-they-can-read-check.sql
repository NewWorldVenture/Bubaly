-- ── A member changes only the rows they can read (0523) ─────────────────────
--
-- The held read rules are SELECT policies; an unfiltered UPDATE or DELETE (no
-- WHERE, no column read: what PostgREST sends for an unfiltered PATCH or
-- DELETE) is checked against its own command's policies only. Where those are
-- still is_family_member(family_id), a member who reads none of a household's
-- rows rewrote or deleted every one. The held 0523 puts one guard, as the
-- caller, before an UPDATE or DELETE (the row being changed must be one they
-- read) and after an UPDATE (the row it leaves must be too), on twelve tables:
--
--   0514  home_warranties, vehicle_registrations (a manager or who added it)
--   0515  wallet_cards, wallet_passes, wallet_rewards (a manager or the member)
--   0517  vacation_documents, voice_commands (a manager or the member)
--   0509  auto_insurance_policies, home_locations, utility_bills,
--         vacation_medical_information (not a guest)
--   0520  family_communications (not a guest)
--
-- PRECONDITION: the read rules above are installed (the workflow applies
-- 0509, 0514, 0515, 0517 and 0520 first). Without them every member reads
-- every row, there is no row a member cannot read, and nothing here applies.
--
-- Fixture, Blind House: a parent (a manager), a teen, a child and a guest.
-- Written as the table owner: on each 0514 table a row the parent added, on
-- each 0517 table a row about the parent, on each 0515 table a row about the
-- teen, and on each guest table one household row; each with a known text.
--
-- What this probe asserts, through PostgREST's role:
--
--   1. the child (the 0514, 0515 and 0517 tables) and the guest (the 0509 and
--      0520 tables), who read none of those rows, are refused an unfiltered
--      UPDATE and an unfiltered DELETE (42501, 0523's sentence, or for the
--      guest 0464's where the held 0524 is installed too; on
--      family_communications the delete is already a manager's: 0 rows);
--   2. every row is still there and reads as written;
--   3. the teen's unfiltered UPDATE cannot hand their own wallet card to the
--      child (the row the update leaves is one they do not read: 42501; with
--      a WHERE clause the new row is already held to the read rule), and the
--      card stays theirs;
--   4. control: the teen still renames their own card (OK 1), and the parent
--      updates and then deletes each row by id (OK 1 each);
--   5. control: the service role's unfiltered UPDATE reaches every row;
--   6. wiring: each table carries trg_<table>_read_before_change (BEFORE
--      UPDATE OR DELETE) and trg_<table>_read_after_change (AFTER UPDATE),
--      enabled, FOR EACH ROW, executing
--      a_row_you_cannot_read_is_not_yours_to_change(), which is SECURITY
--      INVOKER with a pinned search_path and not executable by PUBLIC or anon;
--
-- and, only where 0523 is installed, each in a rolled-back subtransaction:
--
--   N1. NEGATIVE CONTROL: with the triggers disabled, the child's unfiltered
--       DELETE of the warranties removes the parent's (OK 1): the fixture
--       reaches the defect;
--   M1. MUTATION CONTROL: with the guard made SECURITY DEFINER (asked as the
--       owner, who reads every row), the child's unfiltered DELETE lands, so
--       1. is what catches the guard no longer asking as the caller;
--   M2. MUTATION CONTROL: without the AFTER UPDATE triggers, the teen hands
--       their card to the child (OK 1), so 3. catches that half going.
--
-- Everything is rolled back.
--
-- HELD with 0523: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it. .github/workflows/blind-writes-runtime.yml
-- applies the read rules, runs it to show the failure, then applies 0523 and
-- requires a pass. It moves back to docs/audit/ when 0523 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8523-0000000000a1','c0523-parent@example.com'),
  ('00000000-0000-4000-8523-0000000000a3','c0523-teen@example.com'),
  ('00000000-0000-4000-8523-0000000000a4','c0523-child@example.com'),
  ('00000000-0000-4000-8523-0000000000a6','c0523-guest@example.com')
  on conflict do nothing;
-- on_family_created files the creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8523-0000000000f1','Blind House','00000000-0000-4000-8523-0000000000a1');
update public.family_members set id = '00000000-0000-4000-8523-0000000000c1', role = 'parent', is_active = true
 where user_id = '00000000-0000-4000-8523-0000000000a1';
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8523-0000000000c3','00000000-0000-4000-8523-0000000000f1','00000000-0000-4000-8523-0000000000a3','Teen','teen',true),
  ('00000000-0000-4000-8523-0000000000c4','00000000-0000-4000-8523-0000000000f1','00000000-0000-4000-8523-0000000000a4','Child','child',true),
  ('00000000-0000-4000-8523-0000000000c6','00000000-0000-4000-8523-0000000000f1','00000000-0000-4000-8523-0000000000a6','Guest','guest',true);
insert into public.vacations (id, family_id, title) values
  ('00000000-0000-4000-8523-0000000000d1','00000000-0000-4000-8523-0000000000f1','Beach');

-- The twelve tables: who does not read the fixture row, the text column the
-- blind update writes, and the row itself.
create temp table c0523_tables (tbl text, nonreader text, col text, id uuid) on commit drop;
insert into c0523_tables values
  ('home_warranties',              'child', 'name',       '00000000-0000-4000-8523-0000000000e1'),
  ('vehicle_registrations',        'child', 'notes',      '00000000-0000-4000-8523-0000000000e2'),
  ('vacation_documents',           'child', 'title',      '00000000-0000-4000-8523-0000000000e3'),
  ('voice_commands',               'child', 'transcript', '00000000-0000-4000-8523-0000000000e4'),
  ('wallet_cards',                 'child', 'name',       '00000000-0000-4000-8523-0000000000e5'),
  ('wallet_passes',                'child', 'name',       '00000000-0000-4000-8523-0000000000e6'),
  ('wallet_rewards',               'child', 'name',       '00000000-0000-4000-8523-0000000000e7'),
  ('auto_insurance_policies',      'guest', 'notes',      '00000000-0000-4000-8523-0000000000e8'),
  ('home_locations',               'guest', 'notes',      '00000000-0000-4000-8523-0000000000e9'),
  ('utility_bills',                'guest', 'note',       '00000000-0000-4000-8523-0000000000ea'),
  ('vacation_medical_information', 'guest', 'notes',      '00000000-0000-4000-8523-0000000000eb'),
  ('family_communications',        'guest', 'subject',    '00000000-0000-4000-8523-0000000000ec');

insert into public.home_warranties (id, family_id, name, created_by) values
  ('00000000-0000-4000-8523-0000000000e1','00000000-0000-4000-8523-0000000000f1','kept','00000000-0000-4000-8523-0000000000a1');
insert into public.vehicle_registrations (id, family_id, notes, created_by) values
  ('00000000-0000-4000-8523-0000000000e2','00000000-0000-4000-8523-0000000000f1','kept','00000000-0000-4000-8523-0000000000a1');
insert into public.vacation_documents (id, family_id, vacation_id, title, member_id) values
  ('00000000-0000-4000-8523-0000000000e3','00000000-0000-4000-8523-0000000000f1','00000000-0000-4000-8523-0000000000d1','kept','00000000-0000-4000-8523-0000000000c1');
insert into public.voice_commands (id, family_id, transcript, member_id) values
  ('00000000-0000-4000-8523-0000000000e4','00000000-0000-4000-8523-0000000000f1','kept','00000000-0000-4000-8523-0000000000c1');
insert into public.wallet_cards (id, family_id, name, member_id) values
  ('00000000-0000-4000-8523-0000000000e5','00000000-0000-4000-8523-0000000000f1','kept','00000000-0000-4000-8523-0000000000c3');
insert into public.wallet_passes (id, family_id, name, member_id) values
  ('00000000-0000-4000-8523-0000000000e6','00000000-0000-4000-8523-0000000000f1','kept','00000000-0000-4000-8523-0000000000c3');
insert into public.wallet_rewards (id, family_id, name, member_id) values
  ('00000000-0000-4000-8523-0000000000e7','00000000-0000-4000-8523-0000000000f1','kept','00000000-0000-4000-8523-0000000000c3');
insert into public.auto_insurance_policies (id, family_id, notes) values
  ('00000000-0000-4000-8523-0000000000e8','00000000-0000-4000-8523-0000000000f1','kept');
insert into public.home_locations (id, family_id, name, notes) values
  ('00000000-0000-4000-8523-0000000000e9','00000000-0000-4000-8523-0000000000f1','Safe','kept');
insert into public.utility_bills (id, family_id, note) values
  ('00000000-0000-4000-8523-0000000000ea','00000000-0000-4000-8523-0000000000f1','kept');
insert into public.vacation_medical_information (id, family_id, vacation_id, notes) values
  ('00000000-0000-4000-8523-0000000000eb','00000000-0000-4000-8523-0000000000f1','00000000-0000-4000-8523-0000000000d1','kept');
insert into public.family_communications (id, family_id, subject) values
  ('00000000-0000-4000-8523-0000000000ec','00000000-0000-4000-8523-0000000000f1','kept');

-- One statement as one caller (a signed-in user, or the service role with no
-- user id), and exactly what happened; back to the owner with no user id.
create or replace function pg_temp.c0523_as(p_role text, p_uid text, p_sql text) returns text
language plpgsql as $fn$
declare n bigint; got text;
begin
  perform set_config('role', p_role, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), true);
  perform set_config('request.jwt.claims',
    case when p_uid is null then json_build_object('role', p_role)
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

do $$
declare
  uid constant jsonb := jsonb_build_object(
    'parent', '00000000-0000-4000-8523-0000000000a1', 'teen', '00000000-0000-4000-8523-0000000000a3',
    'child', '00000000-0000-4000-8523-0000000000a4', 'guest', '00000000-0000-4000-8523-0000000000a6');
  guard constant text := '42501: A record you cannot see is not yours to change';
  -- Where the held 0524 is installed too, 0464's guest guard fires first on the
  -- guest's tables (its trigger sorts before this one); either is a refusal.
  guest_guard constant text := '42501: A guest can see the household but not change it';
  failures text[] := '{}';
  bad text[];
  installed boolean;
  t record;
  got text;
  n bigint;
  -- Unfiltered: with a WHERE the new row is already held to the read rule.
  handoff constant text := 'update public.wallet_cards set member_id = ''00000000-0000-4000-8523-0000000000c4''';
begin
  -- PRECONDITION: the read rules are installed, so each non-reader reads nothing.
  bad := '{}';
  for t in select * from c0523_tables loop
    got := pg_temp.c0523_as('authenticated', uid ->> t.nonreader, format('select 1 from public.%I where id = %L', t.tbl, t.id));
    if got <> 'OK 0' then
      bad := array_append(bad, format('%s reads %s (%s)', t.nonreader, t.tbl, got));
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'PRECONDITION: the held read rules (0509, 0514, 0515, 0517, 0520) are not all installed, so there is no row a member cannot read: %', array_to_string(bad, ', ');
  end if;

  installed := (select count(*) from pg_trigger
                 where tgfoid = to_regprocedure('public.a_row_you_cannot_read_is_not_yours_to_change()')) = 24;

  for t in select * from c0523_tables loop
    -- 1. The non-reader's unfiltered UPDATE and DELETE, examined and rolled back.
    begin
      got := pg_temp.c0523_as('authenticated', uid ->> t.nonreader, format('update public.%I set %I = %L', t.tbl, t.col, 'blind'));
      if got is distinct from guard and not (t.nonreader = 'guest' and got = guest_guard) then
        failures := array_append(failures, format('the %s, who reads no row of %s, rewrote them blind (%s)', t.nonreader, t.tbl, got));
      end if;
      got := pg_temp.c0523_as('authenticated', uid ->> t.nonreader, format('delete from public.%I', t.tbl));
      if got is distinct from guard and not (t.nonreader = 'guest' and got = guest_guard)
         and not (t.tbl = 'family_communications' and got = 'OK 0') then
        failures := array_append(failures, format('the %s, who reads no row of %s, deleted them blind (%s)', t.nonreader, t.tbl, got));
      end if;
      -- 2. The row is still there and reads as written.
      execute format('select count(*) from public.%I where id = %L and %I = %L', t.tbl, t.id, t.col, 'kept') into n;
      if n <> 1 then
        failures := array_append(failures, format('the household''s %s row was changed or removed by the %s', t.tbl, t.nonreader));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end loop;

  -- 3. The teen does not hand their own card to the child, unfiltered.
  begin
    got := pg_temp.c0523_as('authenticated', uid ->> 'teen', handoff);
    if got is distinct from guard then
      failures := array_append(failures, format('the teen''s unfiltered update handed their own wallet card to the child, a row they then cannot read (%s)', got));
    end if;
    select count(*) into n from public.wallet_cards
     where id = '00000000-0000-4000-8523-0000000000e5' and member_id = '00000000-0000-4000-8523-0000000000c3';
    if n <> 1 then
      failures := array_append(failures, 'the teen''s wallet card is no longer theirs');
    end if;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;

  -- 4. Control: the teen renames their own card; the parent changes and then removes each row.
  begin
    got := pg_temp.c0523_as('authenticated', uid ->> 'teen', 'update public.wallet_cards set name = ''Teen debit'' where id = ''00000000-0000-4000-8523-0000000000e5''');
    if got <> 'OK 1' then
      failures := array_append(failures, format('CONTROL: the teen did not rename their own card (%s)', got));
    end if;
    bad := '{}';
    for t in select * from c0523_tables loop
      got := pg_temp.c0523_as('authenticated', uid ->> 'parent', format('update public.%I set %I = %L where id = %L', t.tbl, t.col, 'by the parent', t.id));
      if got <> 'OK 1' then bad := array_append(bad, format('%s update (%s)', t.tbl, got)); end if;
      got := pg_temp.c0523_as('authenticated', uid ->> 'parent', format('delete from public.%I where id = %L', t.tbl, t.id));
      if got <> 'OK 1' then bad := array_append(bad, format('%s delete (%s)', t.tbl, got)); end if;
    end loop;
    if cardinality(bad) > 0 then
      failures := array_append(failures, format('CONTROL: the parent could not change a row they read: %s', array_to_string(bad, ', ')));
    end if;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;

  -- 5. Control: the service role, with no user id.
  begin
    bad := '{}';
    for t in select * from c0523_tables loop
      got := pg_temp.c0523_as('service_role', null, format('update public.%I set %I = %L where family_id = %L', t.tbl, t.col, 'by the server', '00000000-0000-4000-8523-0000000000f1'));
      if got <> 'OK 1' then bad := array_append(bad, format('%s (%s)', t.tbl, got)); end if;
    end loop;
    if cardinality(bad) > 0 then
      failures := array_append(failures, format('CONTROL: the service role did not update every row: %s', array_to_string(bad, ', ')));
    end if;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;

  -- 6. Wiring.
  bad := '{}';
  for t in select * from c0523_tables loop
    if not exists (select 1 from pg_trigger g
                    where g.tgrelid = ('public.' || t.tbl)::regclass and g.tgname = 'trg_' || t.tbl || '_read_before_change'
                      and g.tgfoid = to_regprocedure('public.a_row_you_cannot_read_is_not_yours_to_change()')
                      and g.tgenabled <> 'D' and (g.tgtype & 1) = 1 and (g.tgtype & 2) = 2 and (g.tgtype & 24) = 24 and (g.tgtype & 4) = 0)
       or not exists (select 1 from pg_trigger g
                       where g.tgrelid = ('public.' || t.tbl)::regclass and g.tgname = 'trg_' || t.tbl || '_read_after_change'
                         and g.tgfoid = to_regprocedure('public.a_row_you_cannot_read_is_not_yours_to_change()')
                         and g.tgenabled <> 'D' and (g.tgtype & 1) = 1 and (g.tgtype & 2) = 0 and (g.tgtype & 16) = 16 and (g.tgtype & 12) = 0) then
      bad := array_append(bad, t.tbl);
    end if;
  end loop;
  if to_regprocedure('public.a_row_you_cannot_read_is_not_yours_to_change()') is null then
    bad := array_append(bad, 'a_row_you_cannot_read_is_not_yours_to_change (missing)');
  elsif exists (select 1 from pg_proc p where p.oid = 'public.a_row_you_cannot_read_is_not_yours_to_change()'::regprocedure
                 and (p.prosecdef or array_to_string(p.proconfig, ',') not like '%search_path%'))
     or has_function_privilege('anon', 'public.a_row_you_cannot_read_is_not_yours_to_change()', 'execute')
     or exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                 where p.oid = 'public.a_row_you_cannot_read_is_not_yours_to_change()'::regprocedure
                   and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    bad := array_append(bad, 'a_row_you_cannot_read_is_not_yours_to_change (SECURITY DEFINER, no pinned search_path, or executable by PUBLIC or anon)');
  end if;
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('0523''s guard is not in place on %s', array_to_string(bad, ', ')));
  end if;

  if installed then
    -- N1. The triggers disabled.
    begin
      alter table public.home_warranties disable trigger trg_home_warranties_read_before_change;
      alter table public.home_warranties disable trigger trg_home_warranties_read_after_change;
      got := pg_temp.c0523_as('authenticated', uid ->> 'child', 'delete from public.home_warranties');
      if got <> 'OK 1' then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the triggers disabled the child''s unfiltered delete still did not remove the parent''s warranty (%s), so this fixture cannot see the defect', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. The guard asked as the owner instead of the caller.
    begin
      alter function public.a_row_you_cannot_read_is_not_yours_to_change() security definer;
      got := pg_temp.c0523_as('authenticated', uid ->> 'child', 'delete from public.home_warranties');
      if got <> 'OK 1' then
        failures := array_append(failures, format('MUTATION CONTROL: with the guard SECURITY DEFINER the child''s unfiltered delete still did not land (%s), so 1. cannot catch the guard no longer asking as the caller', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M2. No AFTER UPDATE triggers.
    begin
      drop trigger trg_wallet_cards_read_after_change on public.wallet_cards;
      got := pg_temp.c0523_as('authenticated', uid ->> 'teen', handoff);
      if got <> 'OK 1' then
        failures := array_append(failures, format('MUTATION CONTROL: without the AFTER UPDATE trigger the teen still did not hand their card to the child (%s), so 3. cannot catch that half going', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a member changes rows they cannot read:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-member-changes-only-the-rows-they-can-read: OK (the child on the 0514, 0515 and 0517 tables and the guest on the 0509 and 0520 tables, who read none of the rows, were refused an unfiltered update and delete (42501, its own sentence; the Hub''s delete already a manager''s), and every row reads as written; the teen could not hand their own card to the child, and renamed it; the parent updated and deleted each row by id; the service role updated every row; 24 triggers before and after with a SECURITY INVOKER guard, search_path pinned, not executable by PUBLIC or anon; negative control: without the triggers the child deleted the parent''s warranty; mutation controls: with the guard SECURITY DEFINER the child''s delete landed, and without the AFTER UPDATE trigger the teen handed the card on)';
end $$;

rollback;
