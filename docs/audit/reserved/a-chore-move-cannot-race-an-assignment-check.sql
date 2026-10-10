-- ── A chore move cannot race an assignment (0502, two sessions) ────────────
--
-- 0502 keeps a chore with assignments a manager's to remove. Owner review
-- 6097190516 asked for the overlapping timings to be shown with two real
-- sessions before concurrency is claimed: a family_id change is a non-key
-- update, its row lock (FOR NO KEY UPDATE) does not wait for an assignment
-- insert in flight (whose foreign key holds KEY SHARE on the chore), and 0311's
-- reference check reads the chore's family without a lock. So a guard that
-- refused a move only when an assignment was VISIBLE could be raced: the chore
-- slips into a family where the mover is a parent, the assignment commits
-- beside it, and that family's manager deletes the chore and the assignment
-- with it. 0502 therefore refuses a non-manager's move outright, and keeps the
-- empty-chore DELETE (the application's rollback), whose FOR UPDATE row lock
-- does wait for the insert.
--
-- The cast: a child of the family who is a PARENT of another family (the
-- mover), and the family's parent (the inserter, who may file an approved
-- 50-point assignment for the child's sibling). Each runs in its own dblink
-- session as `authenticated` with its own JWT claims. The probe asserts, each
-- timing on its own fresh chore:
--
--   A. insert first: the parent's assignment insert is open; the child moves
--      the chore. Refused (42501, the move sentence, exact); after the insert
--      commits, the assignment is there and the chore is home (counted).
--   B. move first: the child's move is refused at once; the parent's insert
--      then lands (counted) and the chore is home.
--   C. delete during an insert: the parent's insert is open; the child's
--      DELETE of the empty-looking chore is shown WAITING on a lock (pg_locks),
--      and once the insert commits it is refused (42501, the delete sentence,
--      exact); the assignment is there (counted).
--   D. delete first (the rollback shape): the child deletes the empty chore in
--      an open transaction; the parent's insert is shown WAITING; the delete
--      commits (1 row) and the insert fails on the foreign key (23503), so no
--      assignment outlives its chore (counted).
--   E. NEGATIVE CONTROL, only where 0502 is installed: with the guard's move
--      rule swapped for the "refuse only if an assignment is visible" rule of
--      its second cut, timings A and B reproduce the race: the move lands, the
--      insert lands, and the mover, as the other family's parent, deletes the
--      chore and the sibling's approved assignment with it (counted). The real
--      guard is put back before the verdict, whatever happened.
--
-- The fixtures are committed (another session cannot see uncommitted rows),
-- under ids no other probe uses, and removed at the start and at the end.
--
-- HELD with 0502: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/chore-cascade-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0502 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

\set ON_ERROR_STOP on

create extension if not exists dblink;

-- As in wallet-concurrency-check.sql: only this probe, as the owner, calls
-- dblink, so no client role keeps any of it.
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure
    from pg_proc p
    join pg_depend d on d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
    join pg_extension e on e.oid = d.refobjid
    where e.extname = 'dblink'
      and p.proowner = (select oid from pg_roles where rolname = current_user)
      and (has_function_privilege('anon', p.oid, 'execute')
           or has_function_privilege('authenticated', p.oid, 'execute'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end
$$;

-- ── fixtures (committed) ────────────────────────────────────────────────────
delete from public.chore_assignments where family_id = '00000000-0000-4000-8502-0000000006f1';
delete from public.chores where family_id in ('00000000-0000-4000-8502-0000000006f1', '00000000-0000-4000-8502-0000000006f2');
delete from public.families where id in ('00000000-0000-4000-8502-0000000006f1', '00000000-0000-4000-8502-0000000006f2');

insert into auth.users (id, email) values
  ('00000000-0000-4000-8502-0000000006a1','race0502-parent@example.com'),
  ('00000000-0000-4000-8502-0000000006a3','race0502-sibling@example.com'),
  ('00000000-0000-4000-8502-0000000006a4','race0502-child@example.com'),
  ('00000000-0000-4000-8502-0000000006b1','race0502-elsewhere@example.com')
  on conflict do nothing;
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8502-0000000006f1','Race House','00000000-0000-4000-8502-0000000006a1'),
  ('00000000-0000-4000-8502-0000000006f2','Where the child is a parent','00000000-0000-4000-8502-0000000006b1');
update public.family_members set role = 'parent', is_active = true
 where user_id in ('00000000-0000-4000-8502-0000000006a1','00000000-0000-4000-8502-0000000006b1');
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8502-0000000006c3','00000000-0000-4000-8502-0000000006f1','00000000-0000-4000-8502-0000000006a3','Sibling','teen',true),
  ('00000000-0000-4000-8502-0000000006c4','00000000-0000-4000-8502-0000000006f1','00000000-0000-4000-8502-0000000006a4','Child','child',true),
  ('00000000-0000-4000-8502-0000000006c5','00000000-0000-4000-8502-0000000006f2','00000000-0000-4000-8502-0000000006a4','Child (a parent there)','parent',true);
insert into public.chores (id, family_id, title) values
  ('00000000-0000-4000-8502-0000000006d1','00000000-0000-4000-8502-0000000006f1','A: insert first'),
  ('00000000-0000-4000-8502-0000000006d2','00000000-0000-4000-8502-0000000006f1','B: move first'),
  ('00000000-0000-4000-8502-0000000006d3','00000000-0000-4000-8502-0000000006f1','C: delete during an insert'),
  ('00000000-0000-4000-8502-0000000006d4','00000000-0000-4000-8502-0000000006f1','D: delete first'),
  ('00000000-0000-4000-8502-0000000006d5','00000000-0000-4000-8502-0000000006f1','E: insert first, second-cut rule'),
  ('00000000-0000-4000-8502-0000000006d6','00000000-0000-4000-8502-0000000006f1','E: move first, second-cut rule');

create temp table c0502_failures (line text);
create temp table c0502_saved (def text);

-- ── the timings ─────────────────────────────────────────────────────────────
-- One procedure for every timing, so the negative control runs exactly the
-- same race as the real guard.
create or replace procedure pg_temp.c0502_open(p_conn text, p_uid text)
language plpgsql as $proc$
declare v_conn text := 'dbname=' || current_database()
  || ' host=' || split_part(current_setting('unix_socket_directories'), ',', 1)
  || ' port=' || current_setting('port') || ' user=' || current_user;
begin
  perform dblink_connect(p_conn, v_conn || ' application_name=' || p_conn);
  perform dblink_exec(p_conn, 'set lock_timeout = ''8s''');
  perform dblink_exec(p_conn, 'set role authenticated');
  perform dblink_exec(p_conn, format('set request.jwt.claim.sub = %L', p_uid));
  perform dblink_exec(p_conn, format('set request.jwt.claims = %L',
    json_build_object('sub', p_uid, 'role', 'authenticated')::text));
end
$proc$;

create or replace function pg_temp.c0502_run(p_conn text, p_sql text) returns text
language plpgsql as $fn$
declare status text;
begin
  status := dblink_exec(p_conn, p_sql, false);
  if status = 'ERROR' then
    -- dblink_error_message carries the remote "ERROR:  " prefix itself.
    return dblink_error_message(p_conn);
  end if;
  return status;
end
$fn$;

-- Whether the session is queued behind a lock. pg_locks is read live; the
-- pg_stat_activity snapshot that names the session is cleared on every pass,
-- since it is otherwise held for the whole transaction.
create or replace function pg_temp.c0502_waiting(p_conn text) returns boolean
language plpgsql as $fn$
declare n int; waited int := 0;
begin
  loop
    perform pg_stat_clear_snapshot();
    select count(*) into n
      from pg_locks l join pg_stat_activity a on a.pid = l.pid
     where a.application_name = p_conn and not l.granted;
    exit when n > 0 or waited >= 5000;
    perform pg_sleep(0.01);
    waited := waited + 10;
  end loop;
  return n > 0;
end
$fn$;

create or replace procedure pg_temp.c0502_timings(p_stage text, p_chore_a uuid, p_chore_b uuid, p_with_deletes boolean)
language plpgsql as $proc$
declare
  fam      constant uuid := '00000000-0000-4000-8502-0000000006f1';
  elsewhere constant uuid := '00000000-0000-4000-8502-0000000006f2';
  sibling  constant uuid := '00000000-0000-4000-8502-0000000006c3';
  moved    constant text := 'A chore can only be moved out of its family by a family manager';
  removed  constant text := 'A chore with assignments can only be removed by a family manager';
  parent_uid constant text := '00000000-0000-4000-8502-0000000006a1';
  child_uid  constant text := '00000000-0000-4000-8502-0000000006a4';
  got text; got2 text; n int; waited boolean;
  ins text;
begin
  call pg_temp.c0502_open('c0502_parent', parent_uid);
  call pg_temp.c0502_open('c0502_child', child_uid);

  -- A. insert first, then the move.
  ins := format('insert into public.chore_assignments (family_id, chore_id, member_id, status, points_awarded) values (%L, %L, %L, ''approved'', 50)', fam, p_chore_a, sibling);
  perform pg_temp.c0502_run('c0502_parent', 'begin');
  got := pg_temp.c0502_run('c0502_parent', ins);
  if got not like 'INSERT 0 1' then
    insert into c0502_failures values (format('%s A: CONTROL: the parent''s assignment insert did not land (%s)', p_stage, got));
  end if;
  perform pg_temp.c0502_run('c0502_child', 'begin');
  got := pg_temp.c0502_run('c0502_child', format('update public.chores set family_id = %L where id = %L', elsewhere, p_chore_a));
  perform pg_temp.c0502_run('c0502_child', case when got like 'ERROR%' then 'rollback' else 'commit' end);
  perform pg_temp.c0502_run('c0502_parent', 'commit');
  if got like 'UPDATE 1' then
    -- The move landed: as the other family's parent, the child deletes it.
    got2 := pg_temp.c0502_run('c0502_child', format('delete from public.chores where id = %L', p_chore_a));
    select count(*) into n from public.chore_assignments where chore_id = p_chore_a and member_id = sibling;
    insert into c0502_failures values (format('%s A (insert first): the child moved the chore while the assignment insert was open (%s), then deleted it there (%s); the sibling''s approved assignment left: %s', p_stage, got, got2, n));
  elsif position(moved in got) = 0 then
    insert into c0502_failures values (format('%s A (insert first): the move was refused, but not with the move sentence (%s)', p_stage, got));
  else
    select count(*) into n from public.chore_assignments a join public.chores c on c.id = a.chore_id
     where a.chore_id = p_chore_a and a.member_id = sibling and c.family_id = fam;
    if n <> 1 then
      insert into c0502_failures values (format('%s A: the assignment is not there with its chore at home (%s)', p_stage, n));
    end if;
  end if;

  -- B. move first, then the insert.
  perform pg_temp.c0502_run('c0502_child', 'begin');
  got := pg_temp.c0502_run('c0502_child', format('update public.chores set family_id = %L where id = %L', elsewhere, p_chore_b));
  ins := format('insert into public.chore_assignments (family_id, chore_id, member_id, status, points_awarded) values (%L, %L, %L, ''approved'', 50)', fam, p_chore_b, sibling);
  got2 := pg_temp.c0502_run('c0502_parent', ins);
  perform pg_temp.c0502_run('c0502_child', case when got like 'ERROR%' then 'rollback' else 'commit' end);
  if got like 'UPDATE 1' then
    n := 0;
    perform pg_temp.c0502_run('c0502_child', format('delete from public.chores where id = %L', p_chore_b));
    select count(*) into n from public.chore_assignments where chore_id = p_chore_b and member_id = sibling;
    insert into c0502_failures values (format('%s B (move first): the child''s move landed (%s), the assignment insert beside it %s, and after the child deleted the chore there the sibling''s approved assignment left: %s', p_stage, got, got2, n));
  elsif position(moved in got) = 0 then
    insert into c0502_failures values (format('%s B (move first): the move was refused, but not with the move sentence (%s)', p_stage, got));
  else
    select count(*) into n from public.chore_assignments a join public.chores c on c.id = a.chore_id
     where a.chore_id = p_chore_b and a.member_id = sibling and c.family_id = fam;
    if got2 not like 'INSERT 0 1' or n <> 1 then
      insert into c0502_failures values (format('%s B: CONTROL: after the refused move the parent''s insert did not land at home (%s; %s rows)', p_stage, got2, n));
    end if;
  end if;

  if p_with_deletes then
    -- C. a delete of the empty-looking chore while an insert is open.
    perform pg_temp.c0502_run('c0502_parent', 'begin');
    got := pg_temp.c0502_run('c0502_parent', format('insert into public.chore_assignments (family_id, chore_id, member_id, status, points_awarded) values (%L, %L, %L, ''approved'', 50)', fam, '00000000-0000-4000-8502-0000000006d3', sibling));
    perform dblink_send_query('c0502_child', format('delete from public.chores where id = %L', '00000000-0000-4000-8502-0000000006d3'));
    waited := pg_temp.c0502_waiting('c0502_child');
    perform pg_temp.c0502_run('c0502_parent', 'commit');
    select coalesce(string_agg(r, ' '), '') into got2 from dblink_get_result('c0502_child', false) as t(r text);
    got2 := case when dblink_error_message('c0502_child') = 'OK' then got2 else dblink_error_message('c0502_child') end;
    perform * from dblink_get_result('c0502_child', false) as t(r text);
    if not waited then
      insert into c0502_failures values (format('%s C: CONTROL: the child''s delete never waited on the open insert, so this timing did not overlap', p_stage));
    end if;
    if position(removed in got2) = 0 then
      insert into c0502_failures values (format('%s C (delete during an insert): the child''s delete was not refused with the delete sentence once the insert committed (%s)', p_stage, got2));
    end if;
    select count(*) into n from public.chore_assignments where chore_id = '00000000-0000-4000-8502-0000000006d3';
    if n <> 1 then
      insert into c0502_failures values (format('%s C: the assignment that committed during the delete is not there (%s)', p_stage, n));
    end if;

    -- D. the rollback shape: the child deletes the empty chore first.
    perform pg_temp.c0502_run('c0502_child', 'begin');
    got := pg_temp.c0502_run('c0502_child', format('delete from public.chores where id = %L', '00000000-0000-4000-8502-0000000006d4'));
    perform dblink_send_query('c0502_parent', format('insert into public.chore_assignments (family_id, chore_id, member_id, status, points_awarded) values (%L, %L, %L, ''approved'', 50)', fam, '00000000-0000-4000-8502-0000000006d4', sibling));
    waited := pg_temp.c0502_waiting('c0502_parent');
    perform pg_temp.c0502_run('c0502_child', 'commit');
    perform * from dblink_get_result('c0502_parent', false) as t(r text);
    got2 := dblink_error_message('c0502_parent');
    perform * from dblink_get_result('c0502_parent', false) as t(r text);
    if got not like 'DELETE 1' then
      insert into c0502_failures values (format('%s D: CONTROL: the child could not delete an empty chore (%s)', p_stage, got));
    end if;
    if not waited then
      insert into c0502_failures values (format('%s D: CONTROL: the parent''s insert never waited on the open delete', p_stage));
    end if;
    if got2 !~ 'foreign key' then
      insert into c0502_failures values (format('%s D: the insert after the delete did not fail on the foreign key (%s)', p_stage, got2));
    end if;
    select count(*) into n from public.chore_assignments where chore_id = '00000000-0000-4000-8502-0000000006d4';
    if n <> 0 then
      insert into c0502_failures values (format('%s D: %s assignments outlived their chore', p_stage, n));
    end if;
  end if;

  perform dblink_disconnect('c0502_parent');
  perform dblink_disconnect('c0502_child');
exception when others then
  insert into c0502_failures values (format('%s: the timing run itself failed (%s: %s)', p_stage, sqlstate, sqlerrm));
  begin perform dblink_disconnect('c0502_parent'); exception when others then null; end;
  begin perform dblink_disconnect('c0502_child'); exception when others then null; end;
end
$proc$;

-- ── the real guard ──────────────────────────────────────────────────────────
call pg_temp.c0502_timings('real',
  '00000000-0000-4000-8502-0000000006d1', '00000000-0000-4000-8502-0000000006d2', true);

-- ── E. NEGATIVE CONTROL: the second cut's move rule ─────────────────────────
-- Committed DDL (each statement here is its own transaction), so the dblink
-- sessions see it; the real definition is saved first and put back below
-- whatever happens in between.
do $$
declare d text;
begin
  if to_regprocedure('public.chore_with_assignments_is_a_managers_to_remove()') is null then
    return;
  end if;
  d := pg_get_functiondef(to_regprocedure('public.chore_with_assignments_is_a_managers_to_remove()'));
  insert into c0502_saved values (d);
  execute replace(d,
    'raise exception ''A chore can only be moved out of its family by a family manager''
      using errcode = ''42501'';',
    'if exists (select 1 from public.chore_assignments a where a.chore_id = old.id) then
      raise exception ''A chore can only be moved out of its family by a family manager'' using errcode = ''42501'';
    end if;
    return new;');
end
$$;

do $$
begin
  if exists (select 1 from c0502_saved) then
    -- Run the race against the second-cut rule, collecting into a scratch list.
    alter table c0502_failures rename to c0502_real;
    create temp table c0502_failures (line text);
  end if;
end
$$;

do $$
begin
  if exists (select 1 from c0502_saved) then
    call pg_temp.c0502_timings('second-cut',
      '00000000-0000-4000-8502-0000000006d5', '00000000-0000-4000-8502-0000000006d6', false);
  end if;
end
$$;

-- Put the real guard back, whatever happened above.
do $$
declare d text;
begin
  select def into d from c0502_saved limit 1;
  if d is not null then
    execute d;
  end if;
end
$$;

do $$
declare n_a int; n_b int; neg text[];
begin
  if to_regclass('pg_temp.c0502_real') is not null then
    -- The negative control must have REPRODUCED the race on both timings.
    select array_agg(line) into neg from c0502_failures;
    drop table c0502_failures;
    alter table c0502_real rename to c0502_failures;
    select count(*) into n_a from unnest(neg) l where l like 'second-cut A (insert first): the child moved the chore%left: 0';
    select count(*) into n_b from unnest(neg) l where l like 'second-cut B (move first): the child''s move landed%left: 0';
    if n_a <> 1 then
      insert into c0502_failures values (format('NEGATIVE CONTROL: under the second cut''s rule, insert-first did not reproduce the race (%s)', coalesce(array_to_string(neg, ' | '), 'nothing recorded')));
    end if;
    if n_b <> 1 then
      insert into c0502_failures values (format('NEGATIVE CONTROL: under the second cut''s rule, move-first did not reproduce the race (%s)', coalesce(array_to_string(neg, ' | '), 'nothing recorded')));
    end if;
  end if;
  -- The real guard is back.
  if to_regprocedure('public.chore_with_assignments_is_a_managers_to_remove()') is not null
     and pg_get_functiondef(to_regprocedure('public.chore_with_assignments_is_a_managers_to_remove()'))
         !~ 'raise exception ''A chore can only be moved out of its family by a family manager''\s+using errcode = ''42501'';\s+end if;\s+-- A family being deleted' then
    insert into c0502_failures values ('the real guard was not restored after the negative control');
  end if;
end
$$;

-- ── clean up and verdict ────────────────────────────────────────────────────
delete from public.chore_assignments where family_id = '00000000-0000-4000-8502-0000000006f1';
delete from public.chores where family_id in ('00000000-0000-4000-8502-0000000006f1', '00000000-0000-4000-8502-0000000006f2');
delete from public.families where id in ('00000000-0000-4000-8502-0000000006f1', '00000000-0000-4000-8502-0000000006f2');

do $$
declare lines text[];
begin
  select array_agg(line) into lines from c0502_failures;
  if lines is not null then
    raise exception E'a chore move can race an assignment:\n  - %', array_to_string(lines, E'\n  - ');
  end if;
  raise notice 'a-chore-move-cannot-race-an-assignment: OK (two sessions, the child a parent elsewhere and the parent filing an approved 50-point assignment for the sibling: insert-first and move-first, the child''s move was refused with the move sentence and the assignment landed with its chore at home; a delete of the empty-looking chore waited on the open insert and was then refused with the delete sentence, the assignment kept; the rollback shape still works: the child''s delete of an empty chore committed and the parent''s waiting insert failed on the foreign key, no assignment left behind; negative control: under the second cut''s rule both timings reproduced the race and the sibling''s assignment was deleted; the real guard was restored)';
end
$$;
