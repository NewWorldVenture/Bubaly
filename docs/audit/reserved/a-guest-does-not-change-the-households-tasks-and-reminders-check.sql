-- ── A guest does not change the household's tasks and reminders (0522) ─────
--
-- 0464 refuses a guest's writes on the eight household resources
-- /family/permissions names, and the held 0498 on calendar_feeds and
-- grocery_lists. The household's tasks and reminders sat outside both lists:
-- a guest created, renamed and deleted to-do and reminder lists, added tasks
-- and reminders, and ticked or completed other members'. The held 0522 wires
-- 0464's own guard onto todo_lists, todo_items, reminder_lists and
-- family_reminders.
--
-- Fixture, List House: a parent, a teen, a child, a caregiver and a guest;
-- written as the table owner, one list of each kind, a task on the to-do list
-- and a reminder.
--
-- What this probe asserts, through PostgREST's role, on each of the four
-- tables:
--
--   1. the guest's INSERT is refused by 0464's guard itself (42501, "A guest
--      can see the household but not change it"), and no row lands;
--   2. the guest's UPDATE of the existing row is refused by the guard, and the
--      row is unchanged;
--   3. the guest's DELETE of the existing row is refused by the guard (on
--      todo_items and family_reminders, 0479's delete policy filters it first:
--      0 rows), and the row remains;
--   4. control: the guest still reads the row;
--   5. control: the parent inserts, updates and deletes a row of their own; the
--      teen, the child and the caregiver each insert and update one (0479's
--      delete rules are theirs, and untouched);
--   6. wiring: each table carries trg_<table>_not_a_guests, enabled, FOR EACH
--      ROW, BEFORE INSERT, UPDATE and DELETE, executing
--      household_write_is_not_a_guests();
--
-- and, only where 0522 is installed, each in a rolled-back subtransaction:
--
--   N1. NEGATIVE CONTROL: with the four guards disabled, the guest's insert
--       lands in each table: the fixture reaches the defect;
--   M1. MUTATION CONTROL: with todo_items' guard on INSERT alone, the guest
--       ticks the task (1 row), so 2. catches the update half going.
--
-- Everything is rolled back.
--
-- HELD with 0522: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/guest-tasks-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0522 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8522-0000000000a1','c0522-parent@example.com'),
  ('00000000-0000-4000-8522-0000000000a3','c0522-teen@example.com'),
  ('00000000-0000-4000-8522-0000000000a4','c0522-child@example.com'),
  ('00000000-0000-4000-8522-0000000000a5','c0522-caregiver@example.com'),
  ('00000000-0000-4000-8522-0000000000a6','c0522-guest@example.com')
  on conflict do nothing;
-- on_family_created files the creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8522-0000000000f1','List House','00000000-0000-4000-8522-0000000000a1');
update public.family_members set role = 'parent', is_active = true
 where user_id = '00000000-0000-4000-8522-0000000000a1';
insert into public.family_members (family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8522-0000000000f1','00000000-0000-4000-8522-0000000000a3','Teen','teen',true),
  ('00000000-0000-4000-8522-0000000000f1','00000000-0000-4000-8522-0000000000a4','Child','child',true),
  ('00000000-0000-4000-8522-0000000000f1','00000000-0000-4000-8522-0000000000a5','Caregiver','caregiver',true),
  ('00000000-0000-4000-8522-0000000000f1','00000000-0000-4000-8522-0000000000a6','Grandma','guest',true);
insert into public.todo_lists (id, family_id, name) values
  ('00000000-0000-4000-8522-0000000000b1','00000000-0000-4000-8522-0000000000f1','Chores');
insert into public.todo_items (id, family_id, list_id, title) values
  ('00000000-0000-4000-8522-0000000000b2','00000000-0000-4000-8522-0000000000f1','00000000-0000-4000-8522-0000000000b1','Pay the plumber');
insert into public.reminder_lists (id, family_id, name) values
  ('00000000-0000-4000-8522-0000000000b3','00000000-0000-4000-8522-0000000000f1','Health');
insert into public.family_reminders (id, family_id, title) values
  ('00000000-0000-4000-8522-0000000000b4','00000000-0000-4000-8522-0000000000f1','Refill the inhaler');

-- One statement as one signed-in user, and exactly what happened.
create or replace function pg_temp.c0522_as(p_uid text, p_sql text) returns text
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
  -- Back to the owner with no user id, so what follows is not this caller's.
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return got;
end
$fn$;

create temp table c0522_tables (label text, tbl text, existing uuid, col text, was text, became text, insert_sql text) on commit drop;
insert into c0522_tables values
  ('to-do list', 'todo_lists', '00000000-0000-4000-8522-0000000000b1', 'name', 'Chores', 'Renamed by Grandma',
   'insert into public.todo_lists (family_id, name) values (''00000000-0000-4000-8522-0000000000f1'', ''%s list'')'),
  ('task', 'todo_items', '00000000-0000-4000-8522-0000000000b2', 'is_done', 'false', 'true',
   'insert into public.todo_items (family_id, list_id, title) values (''00000000-0000-4000-8522-0000000000f1'', ''00000000-0000-4000-8522-0000000000b1'', ''%s list'')'),
  ('reminder list', 'reminder_lists', '00000000-0000-4000-8522-0000000000b3', 'name', 'Health', 'Renamed by Grandma',
   'insert into public.reminder_lists (family_id, name) values (''00000000-0000-4000-8522-0000000000f1'', ''%s list'')'),
  ('reminder', 'family_reminders', '00000000-0000-4000-8522-0000000000b4', 'status', 'active', 'completed',
   'insert into public.family_reminders (family_id, title) values (''00000000-0000-4000-8522-0000000000f1'', ''%s list'')');

do $$
declare
  fam   constant uuid := '00000000-0000-4000-8522-0000000000f1';
  guest constant text := '00000000-0000-4000-8522-0000000000a6';
  guard constant text := '42501: A guest can see the household but not change it';
  failures text[] := '{}';
  bad text[];
  installed boolean;
  t record;
  who record;
  got text;
  n bigint;
  name_col text;
begin
  installed := (select count(*) from pg_trigger
                 where tgfoid = 'public.household_write_is_not_a_guests()'::regprocedure
                   and tgrelid in ('public.todo_lists'::regclass, 'public.todo_items'::regclass,
                                   'public.reminder_lists'::regclass, 'public.family_reminders'::regclass)) = 4;

  for t in select * from c0522_tables loop
    name_col := case when t.tbl in ('todo_lists', 'reminder_lists') then 'name' else 'title' end;

    -- The guest's attempts run in a subtransaction rolled back after they are
    -- examined, so what a guest manages on a schema without the guard (a list
    -- deleted with its tasks) does not reach the controls below.
    begin
    -- 4. Control: the guest reads the row.
    if pg_temp.c0522_as(guest, format('select 1 from public.%I where id = %L', t.tbl, t.existing)) <> 'OK 1' then
      failures := array_append(failures, format('CONTROL: the guest does not read the family''s %s', t.label));
    end if;

    -- 1. INSERT.
    got := pg_temp.c0522_as(guest, format(t.insert_sql, 'Grandma'));
    if got like 'OK%' then
      failures := array_append(failures, format('a guest added a %s (%s)', t.label, got));
    elsif got is distinct from guard then
      failures := array_append(failures, format('the guest''s %s insert was refused, but not by 0464''s guard (%s)', t.label, got));
    end if;

    -- 2. UPDATE.
    got := pg_temp.c0522_as(guest, format('update public.%I set %I = %L where id = %L', t.tbl, t.col, t.became, t.existing));
    if got is distinct from guard then
      failures := array_append(failures, format('the guest''s change of the family''s %s was not refused by 0464''s guard (%s)', t.label, got));
    end if;

    -- 3. DELETE. On todo_items and family_reminders 0479's delete policy
    -- already filters a guest's delete before any BEFORE trigger sees the row,
    -- so there it answers 0 rows; the row-unchanged check below covers both.
    got := pg_temp.c0522_as(guest, format('delete from public.%I where id = %L', t.tbl, t.existing));
    if got is distinct from guard and not (t.tbl in ('todo_items', 'family_reminders') and got = 'OK 0') then
      failures := array_append(failures, format('the guest''s delete of the family''s %s was not refused by 0464''s guard (%s)', t.label, got));
    end if;

    -- Nothing the guest tried changed anything.
    execute format('select count(*) from public.%I where id = %L and %I::text = %L', t.tbl, t.existing, t.col, t.was) into n;
    if n <> 1 then
      failures := array_append(failures, format('the family''s %s was changed or removed by the guest', t.label));
    end if;
    execute format('select count(*) from public.%I where family_id = %L and %I = %L', t.tbl, fam, name_col, 'Grandma list') into n;
    if n <> 0 then
      failures := array_append(failures, format('a guest-made %s is in the family', t.label));
    end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- 5. Control: every other member still writes.
    for who in select * from (values ('Parent', '00000000-0000-4000-8522-0000000000a1', true),
                                     ('Teen', '00000000-0000-4000-8522-0000000000a3', false),
                                     ('Child', '00000000-0000-4000-8522-0000000000a4', false),
                                     ('Caregiver', '00000000-0000-4000-8522-0000000000a5', false)) as w(label, uid, deletes) loop
      bad := array[
        pg_temp.c0522_as(who.uid, format(t.insert_sql, who.label)),
        pg_temp.c0522_as(who.uid, format('update public.%I set %I = %I where family_id = %L and %I = %L', t.tbl, name_col, name_col, fam, name_col, who.label || ' list'))];
      if who.deletes then
        bad := bad || pg_temp.c0522_as(who.uid, format('delete from public.%I where family_id = %L and %I = %L', t.tbl, fam, name_col, who.label || ' list'));
      end if;
      if exists (select 1 from unnest(bad) g where g <> 'OK 1') then
        failures := array_append(failures, format('CONTROL: the %s''s own %s was not inserted, updated%s (%s)',
          lower(who.label), t.label, case when who.deletes then ' and deleted' else '' end, array_to_string(bad, ', ')));
      end if;
    end loop;
  end loop;

  -- 6. Wiring.
  bad := '{}';
  for t in select * from c0522_tables loop
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
    -- N1. The four guards disabled.
    begin
      for t in select * from c0522_tables loop
        execute format('alter table public.%I disable trigger %I', t.tbl, 'trg_' || t.tbl || '_not_a_guests');
      end loop;
      bad := '{}';
      for t in select * from c0522_tables loop
        got := pg_temp.c0522_as(guest, format(t.insert_sql, 'Grandma'));
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

    -- M1. todo_items' guard on INSERT alone.
    begin
      drop trigger trg_todo_items_not_a_guests on public.todo_items;
      create trigger trg_todo_items_not_a_guests before insert on public.todo_items
        for each row execute function public.household_write_is_not_a_guests();
      got := pg_temp.c0522_as(guest, 'update public.todo_items set is_done = true where id = ''00000000-0000-4000-8522-0000000000b2''');
      if got <> 'OK 1' then
        failures := array_append(failures, format('MUTATION CONTROL: with todo_items'' guard on INSERT alone the guest still did not tick the task (%s), so 2. cannot catch the update half going', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a guest changes the household''s tasks or reminders:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-guest-does-not-change-the-households-tasks-and-reminders: OK (as an active guest, inserting and changing a to-do list, a task, a reminder list and a reminder were each refused by 0464''s guard (42501, its own sentence), deleting the lists too and the task and the reminder filtered by 0479, and nothing changed; the guest still reads all four; the parent inserted, updated and deleted a row of their own in each, and the teen, the child and the caregiver each inserted and updated one; each table carries the guard before insert, update and delete; negative control: with the guards disabled the guest''s insert landed in all four; mutation control: with todo_items'' guard on INSERT alone the guest ticked the task)';
end $$;

rollback;
