-- ── A chore with assignments is a manager's to remove ──────────────────────
--
-- 0374 made deleting a chore assignment a manager's only, but `chores` stayed
-- deletable by any member and chore_assignments.chore_id cascades, so a child
-- erased a sibling's approved points by deleting the chore. The held 0502 adds
-- a BEFORE DELETE guard on chores: a signed-in non-manager deletes a chore only
-- while it has no assignments.
--
-- What this probe asserts, through PostgREST's role, with three chores in one
-- family: "Mow the lawn" holding a sibling's APPROVED 50-point assignment,
-- "Feed the cat" holding the child's own OPEN assignment, and "New chore" with
-- no assignment (the shape every application rollback deletes):
--
--   1. as the child, deleting "Mow the lawn" and "Feed the cat" is refused by
--      the guard (42501, its own sentence, matched exactly), and both chores
--      and both assignments remain (counted);
--   2. control: the child still deletes "New chore" (1 row);
--   3. control: a parent deletes "Mow the lawn", and its assignment goes with
--      it (counted);
--   4. control: the family's admin deletes the whole family, and every chore
--      and assignment goes with it (counted);
--   5. control: the service role (carrying a user id, so only the guard's
--      service-role branch can exempt it) and, separately, a session-less
--      writer with a null auth.uid() each delete a chore with assignments
--      (counted);
--   6. the guard is wired: an enabled BEFORE DELETE row trigger on chores;
--   7. NEGATIVE CONTROL: with the guard disabled inside the transaction, the
--      child's delete of "Mow the lawn" lands and the sibling's approved
--      assignment is gone. That proves the fixture reaches the defect.
--
-- Everything is rolled back.
--
-- HELD with 0502: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/chore-cascade-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0502 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8502-0000000002a1','c0502-parent@example.com'),
  ('00000000-0000-4000-8502-0000000002a3','c0502-sibling@example.com'),
  ('00000000-0000-4000-8502-0000000002a4','c0502-child@example.com')
  on conflict do nothing;
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8502-0000000002f1','Chore Cascade House','00000000-0000-4000-8502-0000000002a1')
  on conflict do nothing;
update public.family_members set role = 'parent', is_active = true
 where user_id = '00000000-0000-4000-8502-0000000002a1';
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8502-0000000002c3','00000000-0000-4000-8502-0000000002f1','00000000-0000-4000-8502-0000000002a3','Sibling','teen',true),
  ('00000000-0000-4000-8502-0000000002c4','00000000-0000-4000-8502-0000000002f1','00000000-0000-4000-8502-0000000002a4','Child','child',true);
insert into public.chores (id, family_id, title) values
  ('00000000-0000-4000-8502-0000000002d1','00000000-0000-4000-8502-0000000002f1','Mow the lawn'),
  ('00000000-0000-4000-8502-0000000002d2','00000000-0000-4000-8502-0000000002f1','Feed the cat'),
  ('00000000-0000-4000-8502-0000000002d3','00000000-0000-4000-8502-0000000002f1','New chore');
insert into public.chore_assignments (id, family_id, chore_id, member_id, status, points_awarded) values
  ('00000000-0000-4000-8502-0000000002e1','00000000-0000-4000-8502-0000000002f1','00000000-0000-4000-8502-0000000002d1','00000000-0000-4000-8502-0000000002c3','approved',50);
insert into public.chore_assignments (id, family_id, chore_id, member_id) values
  ('00000000-0000-4000-8502-0000000002e2','00000000-0000-4000-8502-0000000002f1','00000000-0000-4000-8502-0000000002d2','00000000-0000-4000-8502-0000000002c4');

do $$
declare
  fam      constant uuid := '00000000-0000-4000-8502-0000000002f1';
  mow      constant uuid := '00000000-0000-4000-8502-0000000002d1';
  cat      constant uuid := '00000000-0000-4000-8502-0000000002d2';
  fresh    constant uuid := '00000000-0000-4000-8502-0000000002d3';
  guard    constant text := '42501: A chore with assignments can only be removed by a family manager';
  failures text[] := '{}';
  t        record;
  got      text;
  n        int;
  installed boolean := to_regprocedure('public.chore_with_assignments_is_a_managers_to_remove()') is not null;
begin
  -- 1. As the child.
  for t in select * from (values
      (mow, 'the chore holding a sibling''s approved 50-point assignment', '00000000-0000-4000-8502-0000000002e1'::uuid),
      (cat, 'the chore holding their own open assignment',                 '00000000-0000-4000-8502-0000000002e2'::uuid)
    ) as v(chore, what, assignment) loop
    begin
      perform set_config('role','authenticated', true);
      perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8502-0000000002a4', true);
      perform set_config('request.jwt.claims', json_build_object('sub','00000000-0000-4000-8502-0000000002a4','role','authenticated')::text, true);
      delete from public.chores where id = t.chore;
      get diagnostics n = row_count;
      got := format('%s row(s)', n);
      raise exception using errcode = 'P0R01';
    exception
      when sqlstate 'P0R01' then null;
      when others then got := sqlstate || ': ' || sqlerrm;
    end;
    perform set_config('role','postgres', true);
    if got is distinct from guard then
      failures := array_append(failures, format('a child deleted %s, and its assignment with it (%s)', t.what, got));
    end if;
    select count(*) into n from public.chore_assignments where id = t.assignment;
    if n <> 1 then
      failures := array_append(failures, format('%s: its assignment is gone after the child''s attempt', t.what));
    end if;
  end loop;

  -- 2. The rollback shape: a chore with no assignment.
  begin
    perform set_config('role','authenticated', true);
    perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8502-0000000002a4', true);
    perform set_config('request.jwt.claims', json_build_object('sub','00000000-0000-4000-8502-0000000002a4','role','authenticated')::text, true);
    delete from public.chores where id = fresh;
    get diagnostics n = row_count;
    perform set_config('role','postgres', true);
    if n <> 1 then
      failures := array_append(failures, format('CONTROL: the child''s delete of a chore with no assignment removed %s rows, not 1', n));
    end if;
    raise exception using errcode = 'P0R01';
  exception
    when sqlstate 'P0R01' then null;
    when others then failures := array_append(failures, format('CONTROL: the child could not delete a chore with no assignment (%s: %s)', sqlstate, sqlerrm));
  end;
  perform set_config('role','postgres', true);

  -- 3. A parent removes a chore and its assignment.
  begin
    perform set_config('role','authenticated', true);
    perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8502-0000000002a1', true);
    perform set_config('request.jwt.claims', json_build_object('sub','00000000-0000-4000-8502-0000000002a1','role','authenticated')::text, true);
    delete from public.chores where id = mow;
    get diagnostics n = row_count;
    perform set_config('role','postgres', true);
    select n + 10 * (select count(*) from public.chore_assignments where chore_id = mow) into n;
    if n <> 1 then
      failures := array_append(failures, format('CONTROL: the parent''s delete of the chore did not remove it and its assignment (code %s)', n));
    end if;
    raise exception using errcode = 'P0R01';
  exception
    when sqlstate 'P0R01' then null;
    when others then failures := array_append(failures, format('CONTROL: a parent could not delete a chore with assignments (%s: %s)', sqlstate, sqlerrm));
  end;
  perform set_config('role','postgres', true);

  -- 4. The family's admin deletes the family; its chores and assignments go.
  begin
    perform set_config('role','authenticated', true);
    perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8502-0000000002a1', true);
    perform set_config('request.jwt.claims', json_build_object('sub','00000000-0000-4000-8502-0000000002a1','role','authenticated')::text, true);
    delete from public.families where id = fam;
    get diagnostics n = row_count;
    perform set_config('role','postgres', true);
    if n <> 1 then
      failures := array_append(failures, format('CONTROL: the admin''s family delete removed %s rows, not 1', n));
    end if;
    select count(*) into n from public.chores where family_id = fam;
    if n <> 0 then
      failures := array_append(failures, format('CONTROL: %s chores outlived their family', n));
    end if;
    select count(*) into n from public.chore_assignments where family_id = fam;
    if n <> 0 then
      failures := array_append(failures, format('CONTROL: %s assignments outlived their family', n));
    end if;
    raise exception using errcode = 'P0R01';
  exception
    when sqlstate 'P0R01' then null;
    when others then failures := array_append(failures, format('CONTROL: the family''s admin could not delete the family (%s: %s)', sqlstate, sqlerrm));
  end;
  perform set_config('role','postgres', true);

  -- 5. The exemptions, each counted and each on its own.
  begin
    perform set_config('role','service_role', true);
    perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8502-0000000002a4', true);
    perform set_config('request.jwt.claims', json_build_object('sub','00000000-0000-4000-8502-0000000002a4','role','service_role')::text, true);
    if auth.uid() is null then
      failures := array_append(failures, 'CONTROL (service role): auth.uid() is null, so this does not separate the service-role exemption from the null-uid one');
    end if;
    delete from public.chores where id = mow;
    get diagnostics n = row_count;
    perform set_config('role','postgres', true);
    if n <> 1 then
      failures := array_append(failures, format('CONTROL (service role): its delete removed %s rows, not 1', n));
    end if;
    raise exception using errcode = 'P0R01';
  exception
    when sqlstate 'P0R01' then null;
    when others then failures := array_append(failures, format('CONTROL (service role): refused (%s: %s)', sqlstate, sqlerrm));
  end;
  begin
    perform set_config('role','postgres', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    if auth.uid() is not null then
      failures := array_append(failures, 'CONTROL (session-less writer): auth.uid() is not null, so this is not the null-uid case');
    end if;
    delete from public.chores where id = mow;
    get diagnostics n = row_count;
    if n <> 1 then
      failures := array_append(failures, format('CONTROL (session-less writer, null uid): its delete removed %s rows, not 1', n));
    end if;
    raise exception using errcode = 'P0R01';
  exception
    when sqlstate 'P0R01' then null;
    when others then failures := array_append(failures, format('CONTROL (session-less writer, null uid): refused (%s: %s)', sqlstate, sqlerrm));
  end;
  perform set_config('role','postgres', true);

  -- 6. Wiring.
  if not exists (select 1 from pg_trigger tr
                  where tr.tgrelid = 'public.chores'::regclass
                    and tr.tgname = 'trg_chore_with_assignments_is_a_managers'
                    and tr.tgenabled <> 'D'
                    and (tr.tgtype & 2) = 2 and (tr.tgtype & 1) = 1 and (tr.tgtype & 8) = 8) then
    failures := array_append(failures, 'chores carries no enabled BEFORE DELETE row guard for its assignments');
  end if;

  -- 7. NEGATIVE CONTROL.
  if installed then
    begin
      alter table public.chores disable trigger trg_chore_with_assignments_is_a_managers;
      perform set_config('role','authenticated', true);
      perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8502-0000000002a4', true);
      perform set_config('request.jwt.claims', json_build_object('sub','00000000-0000-4000-8502-0000000002a4','role','authenticated')::text, true);
      begin
        delete from public.chores where id = mow;
        get diagnostics n = row_count;
        got := format('%s row(s)', n);
      exception when others then got := sqlstate || ': ' || sqlerrm;
      end;
      perform set_config('role','postgres', true);
      select count(*) into n from public.chore_assignments where id = '00000000-0000-4000-8502-0000000002e1';
      if got is distinct from '1 row(s)' or n <> 0 then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the guard disabled the child''s delete did not take the sibling''s assignment (%s; %s left)', got, n));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
    perform set_config('role','postgres', true);
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a chore''s delete clears assignments its deleter could not:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-chore-with-assignments-is-a-managers-to-remove: OK (as a child: deleting the chore holding a sibling''s approved 50-point assignment and the one holding their own open assignment were each refused with the guard''s own sentence (42501), and both assignments remain; the child still deletes a chore with no assignment (1 row); a parent deletes a chore with its assignment, and the admin deletes the family with all of it; the service role (with a user id) and, separately, a null-uid session-less writer each delete a chore with assignments (1 row each); the guard is an enabled BEFORE DELETE row trigger; negative control: with it disabled the child''s delete took the sibling''s assignment)';
end $$;

rollback;
