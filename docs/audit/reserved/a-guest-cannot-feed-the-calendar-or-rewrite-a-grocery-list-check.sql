-- ── A guest cannot feed the calendar or rewrite a grocery list ─────────────
--
-- 0464 refuses a guest's writes on the eight household resources
-- /family/permissions names. calendar_feeds and grocery_lists sit just outside
-- that list: a guest subscribed the family to any ICS URL (whose events the
-- nightly service-role sync imports into the family calendar) and created,
-- renamed and deleted grocery lists. The held 0498 wires 0464's own guard onto
-- both tables.
--
-- What this probe asserts, as an active guest of the family through
-- PostgREST's role, on each of the two tables:
--
--   1. INSERT is refused by 0464's guard itself (42501, "A guest can see the
--      household but not change it"), and no row lands;
--   2. UPDATE of an existing row is refused by the guard, and the row is
--      unchanged;
--   3. DELETE of an existing row is refused by the guard, and the row remains;
--   4. control: the guest still READS the rows;
--   5. control: a parent and a child still insert, update and delete (0498
--      narrows the guest, not the household);
--   6. NEGATIVE CONTROL: with the grocery_lists guard disabled inside the
--      transaction, the guest's insert lands. That proves the fixture reaches
--      the defect.
--
-- Everything is rolled back.
--
-- HELD with 0498: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/guest-household-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0498 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8498-0000000000a1','m0498-parent@example.com'),
  ('00000000-0000-4000-8498-0000000000a4','m0498-child@example.com'),
  ('00000000-0000-4000-8498-0000000000a6','m0498-guest@example.com')
  on conflict do nothing;
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8498-0000000000f1','Guest Feed House','00000000-0000-4000-8498-0000000000a1')
  on conflict do nothing;
update public.family_members set role = 'parent', is_active = true
 where user_id = '00000000-0000-4000-8498-0000000000a1';
insert into public.family_members (family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8498-0000000000f1','00000000-0000-4000-8498-0000000000a4','Kid','child',true),
  ('00000000-0000-4000-8498-0000000000f1','00000000-0000-4000-8498-0000000000a6','Grandma','guest',true);
-- One existing row in each table for the guest to try to change.
insert into public.calendar_feeds (id, family_id, name, url) values
  ('00000000-0000-4000-8498-0000000000c1','00000000-0000-4000-8498-0000000000f1','School','https://example.com/school.ics');
insert into public.grocery_lists (id, family_id, name) values
  ('00000000-0000-4000-8498-0000000000e1','00000000-0000-4000-8498-0000000000f1','Weekly');

do $$
declare
  fam      uuid := '00000000-0000-4000-8498-0000000000f1';
  guard    constant text := '42501: A guest can see the household but not change it';
  failures text[] := '{}';
  t        record;
  who      record;
  got      text;
  n        int;
begin
  for t in select * from (values
      ('calendar feed', 'calendar_feeds', '00000000-0000-4000-8498-0000000000c1'::uuid, 'School',
       format('insert into public.calendar_feeds (family_id, name, url) values (%L, %L, %L)', fam, 'Guest feed', 'https://example.com/guest.ics')),
      ('grocery list', 'grocery_lists', '00000000-0000-4000-8498-0000000000e1'::uuid, 'Weekly',
       format('insert into public.grocery_lists (family_id, name) values (%L, %L)', fam, 'Guest list'))
    ) as v(label, tbl, existing, existing_name, insert_sql) loop

    -- As the guest.
    perform set_config('role','authenticated', true);
    perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8498-0000000000a6', true);
    perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8498-0000000000a6', 'role', 'authenticated')::text, true);
    if public.family_role(fam) is distinct from 'guest' then
      raise exception 'CONTROL: not acting as a guest of the family; nothing below is a boundary';
    end if;

    -- 4. The guest still reads.
    execute format('select count(*) from public.%I where id = %L', t.tbl, t.existing) into n;
    if n <> 1 then failures := array_append(failures, format('CONTROL: the guest cannot read the family''s %s', t.label)); end if;

    -- 1. INSERT.
    begin execute t.insert_sql; got := 'landed';
    exception when others then got := sqlstate || ': ' || sqlerrm; end;
    if got = 'landed' then
      failures := array_append(failures, format('a guest added a %s', t.label));
    elsif got is distinct from guard then
      failures := array_append(failures, format('the guest''s %s insert was refused, but not by 0464''s guard (%s)', t.label, got));
    end if;

    -- 2. UPDATE.
    begin
      execute format('update public.%I set name = %L where id = %L', t.tbl, 'Renamed by guest', t.existing);
      get diagnostics n = row_count;
      got := format('updated %s row(s)', n);
    exception when others then got := sqlstate || ': ' || sqlerrm; end;
    if got is distinct from guard then
      failures := array_append(failures, format('a guest renamed the family''s %s (%s)', t.label, got));
    end if;

    -- 3. DELETE.
    begin
      execute format('delete from public.%I where id = %L', t.tbl, t.existing);
      get diagnostics n = row_count;
      got := format('deleted %s row(s)', n);
    exception when others then got := sqlstate || ': ' || sqlerrm; end;
    if got is distinct from guard then
      failures := array_append(failures, format('a guest deleted the family''s %s (%s)', t.label, got));
    end if;

    -- Nothing the guest tried changed anything.
    perform set_config('role','postgres', true);
    execute format('select count(*) from public.%I where id = %L and name = %L', t.tbl, t.existing, t.existing_name) into n;
    if n <> 1 then failures := array_append(failures, format('the family''s %s was changed or removed by the guest', t.label)); end if;
    execute format('select count(*) from public.%I where family_id = %L and name like %L', t.tbl, fam, 'Guest %') into n;
    if n <> 0 then failures := array_append(failures, format('a guest-made %s is in the family', t.label)); end if;

    -- 5. A parent and a child still write.
    for who in select * from (values
        ('parent', '00000000-0000-4000-8498-0000000000a1'),
        ('child',  '00000000-0000-4000-8498-0000000000a4')
      ) as w(label, uid) loop
      perform set_config('role','authenticated', true);
      perform set_config('request.jwt.claim.sub', who.uid, true);
      perform set_config('request.jwt.claims', json_build_object('sub', who.uid, 'role', 'authenticated')::text, true);
      begin
        -- Its own row (its own name and URL), so this control does not depend
        -- on what the guest managed to do above on a schema without the guard.
        execute replace(replace(t.insert_sql, 'Guest', initcap(who.label)), 'guest', who.label);
        execute format('update public.%I set name = name where family_id = %L and name like %L', t.tbl, fam, initcap(who.label) || ' %');
        get diagnostics n = row_count;
        if n <> 1 then
          failures := array_append(failures, format('CONTROL: the %s''s update of the %s matched %s rows', who.label, t.label, n));
        end if;
        execute format('delete from public.%I where family_id = %L and name like %L', t.tbl, fam, initcap(who.label) || ' %');
        get diagnostics n = row_count;
        if n <> 1 then
          failures := array_append(failures, format('CONTROL: the %s''s own %s was not deleted (%s rows)', who.label, t.label, n));
        end if;
      exception when others then
        failures := array_append(failures, format('CONTROL: the %s was refused on the %s (%s: %s)', who.label, t.label, sqlstate, sqlerrm));
      end;
      perform set_config('role','postgres', true);
    end loop;
  end loop;

  -- 6. NEGATIVE CONTROL: without the grocery_lists guard, the guest's insert lands.
  if exists (select 1 from pg_trigger where tgrelid = 'public.grocery_lists'::regclass and tgname = 'trg_grocery_lists_not_a_guests') then
    alter table public.grocery_lists disable trigger trg_grocery_lists_not_a_guests;
    perform set_config('role','authenticated', true);
    perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8498-0000000000a6', true);
    perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8498-0000000000a6', 'role', 'authenticated')::text, true);
    begin insert into public.grocery_lists (family_id, name) values (fam, 'Unguarded guest list'); exception when others then null; end;
    perform set_config('role','postgres', true);
    alter table public.grocery_lists enable trigger trg_grocery_lists_not_a_guests;
    select count(*) into n from public.grocery_lists where family_id = fam and name = 'Unguarded guest list';
    if n <> 1 then
      failures := array_append(failures, 'NEGATIVE CONTROL: with the guard disabled the guest''s grocery list still did not land, so this fixture cannot see the defect');
    end if;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a guest can rewrite the household:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-guest-cannot-feed-the-calendar-or-rewrite-a-grocery-list: OK (as an active guest: inserting, renaming and deleting a calendar feed and a grocery list were each refused by 0464''s guard (42501, its own sentence), and nothing changed; the guest still reads both; a parent and a child still insert, update and delete both; negative control: with the grocery_lists guard disabled the guest''s list landed)';
end $$;

rollback;
