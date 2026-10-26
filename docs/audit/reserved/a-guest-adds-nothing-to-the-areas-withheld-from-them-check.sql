-- ── A guest adds nothing to the areas withheld from them (0524) ──────────────
--
-- 0464 (ROLE-M03): a guest views the household and does not rewrite it. The
-- held 0509 and 0520 withhold the household's insurance, bills, storage
-- locations, driving, travel medical details, wallet hub and Communications
-- Hub from a guest, page and rows; nine of those tables still took a guest's
-- INSERT. The held 0524 wires 0464's own guard onto them.
--
-- Fixture, Withheld House: a parent, a child and a guest, and one vacation
-- (vacation_medical_information hangs off one).
--
-- What this probe asserts, through PostgREST's role, on each of the nine:
--
--   1. the guest's INSERT is refused by 0464's guard itself (42501, "A guest
--      can see the household but not change it"), and no guest row lands;
--   2. control: the parent and the child each still insert a row (OK 1);
--   3. wiring: each table carries trg_<table>_not_a_guests, enabled, FOR EACH
--      ROW, BEFORE INSERT, UPDATE and DELETE, executing
--      household_write_is_not_a_guests();
--
-- and, only where 0524 is installed, each in a rolled-back subtransaction:
--
--   N1. NEGATIVE CONTROL: with the nine guards disabled, the guest's insert
--       lands in every table: the fixture reaches the defect;
--   M1. MUTATION CONTROL: with utility_bills' guard on UPDATE and DELETE only,
--       the guest's bill lands, so 1. is what catches the insert half going.
--
-- Everything is rolled back. This needs none of the other held files: a guest
-- writing is the defect whatever they read.
--
-- HELD with 0524: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/guest-withheld-writes-runtime.yml runs it there to show
-- the failure, then applies the held migration and requires it to pass. It
-- moves back to docs/audit/ when 0524 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8524-0000000000a1','c0524-parent@example.com'),
  ('00000000-0000-4000-8524-0000000000a4','c0524-child@example.com'),
  ('00000000-0000-4000-8524-0000000000a6','c0524-guest@example.com')
  on conflict do nothing;
-- on_family_created files the creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8524-0000000000f1','Withheld House','00000000-0000-4000-8524-0000000000a1');
update public.family_members set role = 'parent', is_active = true
 where user_id = '00000000-0000-4000-8524-0000000000a1';
insert into public.family_members (family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8524-0000000000f1','00000000-0000-4000-8524-0000000000a4','Child','child',true),
  ('00000000-0000-4000-8524-0000000000f1','00000000-0000-4000-8524-0000000000a6','Grandma','guest',true);
insert into public.vacations (id, family_id, title) values
  ('00000000-0000-4000-8524-0000000000d1','00000000-0000-4000-8524-0000000000f1','Beach');

-- Each table, the text column its row is marked in, and its insert (%s: the mark).
create temp table c0524_tables (tbl text, col text, insert_sql text) on commit drop;
insert into c0524_tables values
  ('auto_insurance_policies', 'notes', 'insert into public.auto_insurance_policies (family_id, notes) values (''00000000-0000-4000-8524-0000000000f1'', %L)'),
  ('driving_trips', 'notes', 'insert into public.driving_trips (family_id, notes) values (''00000000-0000-4000-8524-0000000000f1'', %L)'),
  ('family_communications', 'subject', 'insert into public.family_communications (family_id, subject) values (''00000000-0000-4000-8524-0000000000f1'', %L)'),
  ('home_locations', 'name', 'insert into public.home_locations (family_id, name) values (''00000000-0000-4000-8524-0000000000f1'', %L)'),
  ('utility_bills', 'note', 'insert into public.utility_bills (family_id, note) values (''00000000-0000-4000-8524-0000000000f1'', %L)'),
  ('vacation_medical_information', 'notes', 'insert into public.vacation_medical_information (family_id, vacation_id, notes) values (''00000000-0000-4000-8524-0000000000f1'', ''00000000-0000-4000-8524-0000000000d1'', %L)'),
  ('wallet_cards', 'name', 'insert into public.wallet_cards (family_id, name) values (''00000000-0000-4000-8524-0000000000f1'', %L)'),
  ('wallet_passes', 'name', 'insert into public.wallet_passes (family_id, name) values (''00000000-0000-4000-8524-0000000000f1'', %L)'),
  ('wallet_rewards', 'name', 'insert into public.wallet_rewards (family_id, name) values (''00000000-0000-4000-8524-0000000000f1'', %L)');

-- One statement as one signed-in user, and exactly what happened; back to the
-- owner with no user id.
create or replace function pg_temp.c0524_as(p_uid text, p_sql text) returns text
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
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return got;
end
$fn$;

do $$
declare
  guest constant text := '00000000-0000-4000-8524-0000000000a6';
  guard constant text := '42501: A guest can see the household but not change it';
  failures text[] := '{}';
  bad text[];
  installed boolean;
  t record;
  got text;
  n bigint;
begin
  installed := (select count(*) from pg_trigger g
                 where g.tgfoid = 'public.household_write_is_not_a_guests()'::regprocedure
                   and g.tgrelid in (select ('public.' || tbl)::regclass from c0524_tables)) = 9;

  for t in select * from c0524_tables loop
    -- 1. The guest's insert.
    got := pg_temp.c0524_as(guest, format(t.insert_sql, 'Grandma''s'));
    if got like 'OK%' then
      failures := array_append(failures, format('a guest added a row to %s, an area withheld from them (%s)', t.tbl, got));
    elsif got is distinct from guard then
      failures := array_append(failures, format('the guest''s insert into %s was refused, but not by 0464''s guard (%s)', t.tbl, got));
    end if;
    execute format('select count(*) from public.%I where %I = %L', t.tbl, t.col, 'Grandma''s') into n;
    if n <> 0 then
      failures := array_append(failures, format('a guest''s row is in %s', t.tbl));
    end if;

    -- 2. Control: the parent and the child still insert.
    bad := array[pg_temp.c0524_as('00000000-0000-4000-8524-0000000000a1', format(t.insert_sql, 'The parent''s')),
                 pg_temp.c0524_as('00000000-0000-4000-8524-0000000000a4', format(t.insert_sql, 'The child''s'))];
    if exists (select 1 from unnest(bad) g where g <> 'OK 1') then
      failures := array_append(failures, format('CONTROL: the parent or the child could not add a row to %s (%s)', t.tbl, array_to_string(bad, ', ')));
    end if;
  end loop;

  -- 3. Wiring.
  bad := '{}';
  for t in select * from c0524_tables loop
    if not exists (select 1 from pg_trigger g
                    where g.tgrelid = ('public.' || t.tbl)::regclass and g.tgname = 'trg_' || t.tbl || '_not_a_guests'
                      and g.tgfoid = 'public.household_write_is_not_a_guests()'::regprocedure
                      and g.tgenabled <> 'D' and (g.tgtype & 1) = 1 and (g.tgtype & 2) = 2 and (g.tgtype & 28) = 28) then
      bad := array_append(bad, t.tbl);
    end if;
  end loop;
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('0464''s guard is not on insert, update and delete of %s', array_to_string(bad, ', ')));
  end if;

  if installed then
    -- N1. The nine guards disabled.
    begin
      for t in select * from c0524_tables loop
        execute format('alter table public.%I disable trigger %I', t.tbl, 'trg_' || t.tbl || '_not_a_guests');
      end loop;
      bad := '{}';
      for t in select * from c0524_tables loop
        got := pg_temp.c0524_as(guest, format(t.insert_sql, 'Unguarded'));
        if got <> 'OK 1' then
          bad := array_append(bad, format('%s (%s)', t.tbl, got));
        end if;
      end loop;
      if cardinality(bad) > 0 then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the guards disabled the guest''s insert still did not land in %s, so this fixture cannot see the defect', array_to_string(bad, ', ')));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. utility_bills' guard on UPDATE and DELETE only.
    begin
      drop trigger trg_utility_bills_not_a_guests on public.utility_bills;
      create trigger trg_utility_bills_not_a_guests before update or delete on public.utility_bills
        for each row execute function public.household_write_is_not_a_guests();
      got := pg_temp.c0524_as(guest, 'insert into public.utility_bills (family_id, note) values (''00000000-0000-4000-8524-0000000000f1'', ''Mutated'')');
      if got <> 'OK 1' then
        failures := array_append(failures, format('MUTATION CONTROL: with utility_bills'' guard off INSERT the guest''s bill still did not land (%s), so 1. cannot catch the insert half going', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a guest adds to the areas withheld from them:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-guest-adds-nothing-to-the-areas-withheld-from-them: OK (as an active guest, an insert into each of the nine tables was refused by 0464''s guard (42501, its own sentence) and no guest row landed; the parent and the child each still added one; each table carries the guard before insert, update and delete; negative control: with the guards disabled the guest''s insert landed in all nine; mutation control: with utility_bills'' guard off INSERT the guest''s bill landed)';
end $$;

rollback;
