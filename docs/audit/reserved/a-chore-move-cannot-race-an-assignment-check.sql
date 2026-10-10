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
-- mover), and the family's parent (the inserter, who files an approved
-- 50-point assignment for the child's sibling). Each runs in its own dblink
-- session as `authenticated` with its own JWT claims. Every remote statement
-- goes through a session-local pg_temp.c0502_try, which returns `OK <rows>` or
-- `<SQLSTATE> [<constraint>]: <message>`, so each step is recorded with its
-- exact outcome (owner review 6097308389). Each timing's whole recorded
-- sequence (every begin/commit result, every statement's outcome, the lock
-- waits, the landed-row counts) must equal its expected sequence exactly; any
-- other outcome, an unexpected error included, is a failure line. Each timing
-- runs on its own fresh chore:
--
--   A. insert first: the parent's insert is open (OK 1); the child's move is
--      refused (42501, the move sentence); after the insert commits, the
--      approved assignment is there with its chore at home (counted).
--   B. move first: the child's move is refused (42501, the move sentence); the
--      parent's insert then lands (OK 1) with its chore at home (counted).
--   C. delete during an insert: the parent's insert is open; the child's DELETE
--      of the empty-looking chore is shown WAITING on a lock (pg_locks), and
--      once the insert commits it is refused (42501, the delete sentence); the
--      assignment is there (counted).
--   D. delete first (the application's rollback shape): the child deletes the
--      empty chore in an open transaction (OK 1); the parent's insert is shown
--      WAITING; the delete commits and the insert fails with 23503 on
--      chore_assignments_chore_id_fkey, exactly; no assignment and no chore
--      remain (counted).
--   E. NEGATIVE CONTROL, only where 0502 is installed: with the guard's move
--      rule swapped for the "refuse only if an assignment is visible" rule of
--      its second cut, timings A and B must reproduce the race step for step:
--      the parent's insert and commit succeed, the move succeeds and commits,
--      ONE approved assignment exists with its chore in the other family before
--      anything is deleted, the child's delete there is OK 1, and afterwards
--      neither the chore nor any assignment on it remains. A run in which the
--      assignment never landed cannot satisfy this (mutations of the second-cut
--      insert fixtures alone turn it red; chore-cascade-runtime.yml runs three).
--
-- Cleanup and its limits. The fixtures, the four synthetic auth users among
-- them, are committed (another session cannot see uncommitted rows) under ids
-- no other probe uses; they are removed at the start and at the end, and the
-- end verifies that none remain. The second cut's rule is installed and removed
-- through a separate, autocommitting connection inside ONE block; the block's
-- exception handler puts the real definition back and removes the fixtures
-- through that connection before re-raising, and on the normal path the
-- definition afterwards must equal the one saved before, byte for byte. An
-- error anywhere else leaves at most the fixtures (no rule is swapped outside
-- that block), which the next run removes before it starts. The swapped body
-- carries a marker; if a run is killed outright inside the block (the server or
-- the client dying), the next run finds the marker and reverses the swap before
-- it starts. That is the whole guarantee: this probe is for disposable
-- databases only.
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

-- ── an interrupted earlier run ──────────────────────────────────────────────
-- The swap below is deterministic, so a body still carrying its marker is put
-- back by reversing it.
create temp table c0502_swap (real_rule text, second_cut_rule text);
insert into c0502_swap values (
$rule$raise exception 'A chore can only be moved out of its family by a family manager'
      using errcode = '42501';$rule$,
$rule$-- c0502 probe: the second cut's rule, swapped in by a-chore-move-cannot-race-an-assignment-check.sql
    if exists (select 1 from public.chore_assignments a where a.chore_id = old.id) then
      raise exception 'A chore can only be moved out of its family by a family manager' using errcode = '42501';
    end if;
    return new;$rule$);

do $$
declare d text; s c0502_swap;
begin
  d := pg_get_functiondef(to_regprocedure('public.chore_with_assignments_is_a_managers_to_remove()'));
  if d is not null and position('-- c0502 probe: the second cut''s rule' in d) > 0 then
    select * into s from c0502_swap;
    execute replace(d, s.second_cut_rule, s.real_rule);
    raise notice 'a-chore-move-cannot-race-an-assignment: reversed the second-cut rule an interrupted run left installed';
  end if;
end
$$;

-- ── fixtures (committed) ────────────────────────────────────────────────────
-- The same statements serve this session and, on an error inside the
-- negative-control block, the autocommitting connection there.
create temp table c0502_cleanup (ord int, sql text);
insert into c0502_cleanup values
  (1, $c$delete from public.chore_assignments where family_id = '00000000-0000-4000-8502-0000000006f1'$c$),
  (2, $c$delete from public.chores where family_id in ('00000000-0000-4000-8502-0000000006f1', '00000000-0000-4000-8502-0000000006f2')$c$),
  (3, $c$delete from public.families where id in ('00000000-0000-4000-8502-0000000006f1', '00000000-0000-4000-8502-0000000006f2')$c$),
  (4, $c$delete from auth.users where id in ('00000000-0000-4000-8502-0000000006a1', '00000000-0000-4000-8502-0000000006a3', '00000000-0000-4000-8502-0000000006a4', '00000000-0000-4000-8502-0000000006b1')$c$);

create or replace procedure pg_temp.c0502_clean(p_conn text default null)
language plpgsql as $proc$
declare q text;
begin
  for q in select sql from c0502_cleanup order by ord loop
    if p_conn is null then
      execute q;
    else
      perform dblink_exec(p_conn, q);
    end if;
  end loop;
end
$proc$;
call pg_temp.c0502_clean();

insert into auth.users (id, email) values
  ('00000000-0000-4000-8502-0000000006a1','race0502-parent@example.com'),
  ('00000000-0000-4000-8502-0000000006a3','race0502-sibling@example.com'),
  ('00000000-0000-4000-8502-0000000006a4','race0502-child@example.com'),
  ('00000000-0000-4000-8502-0000000006b1','race0502-elsewhere@example.com');
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

create temp table c0502_steps (ord serial, stage text, timing text, step text, result text);
create temp table c0502_failures (line text);

-- ── the sessions ────────────────────────────────────────────────────────────
-- Each session gets its own pg_temp.c0502_try, created before it takes the
-- client role. A statement's error is caught there and returned with its
-- SQLSTATE and constraint, and the session's transaction stays usable for the
-- explicit commit or rollback that follows.
create or replace procedure pg_temp.c0502_open(p_conn text, p_uid text)
language plpgsql as $proc$
declare v_conn text := 'dbname=' || current_database()
  || ' host=' || split_part(current_setting('unix_socket_directories'), ',', 1)
  || ' port=' || current_setting('port') || ' user=' || current_user;
begin
  perform dblink_connect(p_conn, v_conn || ' application_name=' || p_conn);
  perform dblink_exec(p_conn, 'set lock_timeout = ''8s''');
  perform dblink_exec(p_conn, $try$
    create function pg_temp.c0502_try(p_sql text) returns text
    language plpgsql as $f$
    declare n bigint; st text; con text; msg text;
    begin
      execute p_sql;
      get diagnostics n = row_count;
      return 'OK ' || n;
    exception when others then
      get stacked diagnostics st = returned_sqlstate, con = constraint_name, msg = message_text;
      return st || case when coalesce(con, '') <> '' then ' [' || con || ']' else '' end || ': ' || msg;
    end
    $f$$try$);
  perform dblink_exec(p_conn, 'set role authenticated');
  perform dblink_exec(p_conn, format('set request.jwt.claim.sub = %L', p_uid));
  perform dblink_exec(p_conn, format('set request.jwt.claims = %L',
    json_build_object('sub', p_uid, 'role', 'authenticated')::text));
end
$proc$;

-- A transaction-control statement's own status (BEGIN, COMMIT, ROLLBACK).
create or replace function pg_temp.c0502_tx(p_conn text, p_sql text) returns text
language plpgsql as $fn$
declare status text;
begin
  status := dblink_exec(p_conn, p_sql, false);
  if status = 'ERROR' then
    return 'ERROR: ' || dblink_error_message(p_conn);
  end if;
  return status;
end
$fn$;

-- A statement's outcome, through the session's c0502_try.
create or replace function pg_temp.c0502_try(p_conn text, p_sql text) returns text
language plpgsql as $fn$
declare r text;
begin
  select t.r into r from dblink(p_conn, format('select pg_temp.c0502_try(%L)', p_sql), false) as t(r text);
  return coalesce(r, 'ERROR: ' || dblink_error_message(p_conn));
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

-- The result of a query sent with dblink_send_query, once it finishes.
create or replace function pg_temp.c0502_collect(p_conn text) returns text
language plpgsql as $fn$
declare r text;
begin
  select t.r into r from dblink_get_result(p_conn, false) as t(r text);
  r := coalesce(r, 'ERROR: ' || dblink_error_message(p_conn));
  perform * from dblink_get_result(p_conn, false) as t(r text);
  return r;
end
$fn$;

create or replace function pg_temp.c0502_note(p_stage text, p_timing text, p_step text, p_result text) returns void
language sql as $$
  insert into c0502_steps (stage, timing, step, result) values (p_stage, p_timing, p_step, p_result);
$$;

-- ── the timings ─────────────────────────────────────────────────────────────
-- One procedure for every timing, so the negative control runs exactly the
-- same race as the real guard. p_member and p_status are the assignment the
-- parent files.
create or replace procedure pg_temp.c0502_timings(p_stage text, p_chore_a uuid, p_chore_b uuid,
                                                  p_member uuid, p_status text, p_with_deletes boolean)
language plpgsql as $proc$
declare
  fam        constant uuid := '00000000-0000-4000-8502-0000000006f1';
  elsewhere  constant uuid := '00000000-0000-4000-8502-0000000006f2';
  chore_c    constant uuid := '00000000-0000-4000-8502-0000000006d3';
  chore_d    constant uuid := '00000000-0000-4000-8502-0000000006d4';
  parent_uid constant text := '00000000-0000-4000-8502-0000000006a1';
  child_uid  constant text := '00000000-0000-4000-8502-0000000006a4';
  t   text;
  got text;
  ins text;
  c   uuid;
begin
  call pg_temp.c0502_open('c0502_parent', parent_uid);
  call pg_temp.c0502_open('c0502_child', child_uid);

  for t, c in select * from (values ('A', p_chore_a), ('B', p_chore_b)) v(t, c) loop
    ins := format('insert into public.chore_assignments (family_id, chore_id, member_id, status, points_awarded) '
                  || 'values (%L, %L, %L, %L, 50)', fam, c, p_member, p_status);
    if t = 'A' then
      -- A: the insert is open while the child moves the chore.
      perform pg_temp.c0502_note(p_stage, t, 'parent begin', pg_temp.c0502_tx('c0502_parent', 'begin'));
      perform pg_temp.c0502_note(p_stage, t, 'parent insert', pg_temp.c0502_try('c0502_parent', ins));
      perform pg_temp.c0502_note(p_stage, t, 'child begin', pg_temp.c0502_tx('c0502_child', 'begin'));
      got := pg_temp.c0502_try('c0502_child', format('update public.chores set family_id = %L where id = %L', elsewhere, c));
      perform pg_temp.c0502_note(p_stage, t, 'child move', got);
      perform pg_temp.c0502_note(p_stage, t, 'child end', pg_temp.c0502_tx('c0502_child', case when got = 'OK 1' then 'commit' else 'rollback' end));
      perform pg_temp.c0502_note(p_stage, t, 'parent commit', pg_temp.c0502_tx('c0502_parent', 'commit'));
    else
      -- B: the move is open while the parent files the assignment.
      perform pg_temp.c0502_note(p_stage, t, 'child begin', pg_temp.c0502_tx('c0502_child', 'begin'));
      got := pg_temp.c0502_try('c0502_child', format('update public.chores set family_id = %L where id = %L', elsewhere, c));
      perform pg_temp.c0502_note(p_stage, t, 'child move', got);
      perform pg_temp.c0502_note(p_stage, t, 'parent insert', pg_temp.c0502_try('c0502_parent', ins));
      perform pg_temp.c0502_note(p_stage, t, 'child end', pg_temp.c0502_tx('c0502_child', case when got = 'OK 1' then 'commit' else 'rollback' end));
    end if;
    -- What landed, before anything is deleted.
    perform pg_temp.c0502_note(p_stage, t, 'approved assignments, chore at home',
      (select count(*) from public.chore_assignments a join public.chores ch on ch.id = a.chore_id
        where a.chore_id = c and a.member_id = p_member and a.status = 'approved' and ch.family_id = fam)::text);
    perform pg_temp.c0502_note(p_stage, t, 'approved assignments, chore in the other family',
      (select count(*) from public.chore_assignments a join public.chores ch on ch.id = a.chore_id
        where a.chore_id = c and a.member_id = p_member and a.status = 'approved' and ch.family_id = elsewhere)::text);
    if got = 'OK 1' then
      -- The move landed: as the other family's parent, the child deletes it.
      perform pg_temp.c0502_note(p_stage, t, 'child delete there', pg_temp.c0502_try('c0502_child', format('delete from public.chores where id = %L', c)));
      perform pg_temp.c0502_note(p_stage, t, 'assignments left', (select count(*) from public.chore_assignments where chore_id = c)::text);
      perform pg_temp.c0502_note(p_stage, t, 'chore left', (select count(*) from public.chores where id = c)::text);
    end if;
  end loop;

  if p_with_deletes then
    -- C. a delete of the empty-looking chore while an insert is open.
    t := 'C';
    perform pg_temp.c0502_note(p_stage, t, 'parent begin', pg_temp.c0502_tx('c0502_parent', 'begin'));
    perform pg_temp.c0502_note(p_stage, t, 'parent insert', pg_temp.c0502_try('c0502_parent', format(
      'insert into public.chore_assignments (family_id, chore_id, member_id, status, points_awarded) values (%L, %L, %L, %L, 50)',
      fam, chore_c, p_member, p_status)));
    perform dblink_send_query('c0502_child', format('select pg_temp.c0502_try(%L)', format('delete from public.chores where id = %L', chore_c)));
    perform pg_temp.c0502_note(p_stage, t, 'child delete waits', pg_temp.c0502_waiting('c0502_child')::text);
    perform pg_temp.c0502_note(p_stage, t, 'parent commit', pg_temp.c0502_tx('c0502_parent', 'commit'));
    perform pg_temp.c0502_note(p_stage, t, 'child delete', pg_temp.c0502_collect('c0502_child'));
    perform pg_temp.c0502_note(p_stage, t, 'approved assignments, chore at home',
      (select count(*) from public.chore_assignments a join public.chores ch on ch.id = a.chore_id
        where a.chore_id = chore_c and a.status = 'approved' and ch.family_id = fam)::text);

    -- D. the rollback shape: the child deletes the empty chore first.
    t := 'D';
    perform pg_temp.c0502_note(p_stage, t, 'child begin', pg_temp.c0502_tx('c0502_child', 'begin'));
    perform pg_temp.c0502_note(p_stage, t, 'child delete', pg_temp.c0502_try('c0502_child', format('delete from public.chores where id = %L', chore_d)));
    perform dblink_send_query('c0502_parent', format('select pg_temp.c0502_try(%L)', format(
      'insert into public.chore_assignments (family_id, chore_id, member_id, status, points_awarded) values (%L, %L, %L, %L, 50)',
      fam, chore_d, p_member, p_status)));
    perform pg_temp.c0502_note(p_stage, t, 'parent insert waits', pg_temp.c0502_waiting('c0502_parent')::text);
    perform pg_temp.c0502_note(p_stage, t, 'child commit', pg_temp.c0502_tx('c0502_child', 'commit'));
    perform pg_temp.c0502_note(p_stage, t, 'parent insert', pg_temp.c0502_collect('c0502_parent'));
    perform pg_temp.c0502_note(p_stage, t, 'assignments left', (select count(*) from public.chore_assignments where chore_id = chore_d)::text);
    perform pg_temp.c0502_note(p_stage, t, 'chore left', (select count(*) from public.chores where id = chore_d)::text);
  end if;

  perform dblink_disconnect('c0502_parent');
  perform dblink_disconnect('c0502_child');
exception when others then
  -- Recorded as a step, so it cannot match any expected sequence.
  insert into c0502_steps (stage, timing, step, result)
    values (p_stage, coalesce(t, '-'), 'the timing run itself failed', sqlstate || ': ' || sqlerrm);
  begin perform dblink_disconnect('c0502_parent'); exception when others then null; end;
  begin perform dblink_disconnect('c0502_child'); exception when others then null; end;
end
$proc$;

-- ── the real guard ──────────────────────────────────────────────────────────
call pg_temp.c0502_timings('real', '00000000-0000-4000-8502-0000000006d1', '00000000-0000-4000-8502-0000000006d2', '00000000-0000-4000-8502-0000000006c3', 'approved', true);

-- ── E. NEGATIVE CONTROL: the second cut's move rule ─────────────────────────
-- Installed and removed through a separate autocommitting connection, so the
-- two sessions see it, inside one block whose handler restores the real
-- definition before re-raising. The second-cut call stays on one line: the
-- workflow's mutations of its insert fixtures edit exactly that line.
create temp table c0502_saved (def text);
do $$
declare
  d text; swapped text; s c0502_swap;
  v_conn text := 'dbname=' || current_database()
    || ' host=' || split_part(current_setting('unix_socket_directories'), ',', 1)
    || ' port=' || current_setting('port') || ' user=' || current_user;
begin
  d := pg_get_functiondef(to_regprocedure('public.chore_with_assignments_is_a_managers_to_remove()'));
  if d is null then
    return;  -- the released schema: nothing to swap
  end if;
  insert into c0502_saved values (d);
  select * into s from c0502_swap;
  swapped := replace(d, s.real_rule, s.second_cut_rule);
  if swapped = d then
    insert into c0502_failures values ('NEGATIVE CONTROL: the guard''s move rule was not where the probe expects it, so the second cut''s rule could not be swapped in');
    return;
  end if;
  perform dblink_connect('c0502_ddl', v_conn || ' application_name=c0502_ddl');
  begin
    perform dblink_exec('c0502_ddl', swapped);
    call pg_temp.c0502_timings('second-cut', '00000000-0000-4000-8502-0000000006d5', '00000000-0000-4000-8502-0000000006d6', '00000000-0000-4000-8502-0000000006c3', 'approved', false);
    perform dblink_exec('c0502_ddl', d);
  exception when others then
    -- Committed through the other connection, so the re-raise below does not
    -- take them back: the real guard first, then the fixtures.
    perform dblink_exec('c0502_ddl', d);
    call pg_temp.c0502_clean('c0502_ddl');
    perform dblink_disconnect('c0502_ddl');
    raise;
  end;
  perform dblink_disconnect('c0502_ddl');
end
$$;

-- ── the verdict ─────────────────────────────────────────────────────────────
do $$
declare
  moved   constant text := '42501: A chore can only be moved out of its family by a family manager';
  removed constant text := '42501: A chore with assignments can only be removed by a family manager';
  fk      constant text := '23503 [chore_assignments_chore_id_fkey]: insert or update on table "chore_assignments" violates foreign key constraint "chore_assignments_chore_id_fkey"';
  -- What each timing must record, step for step.
  real_a  constant text[] := array['parent begin=BEGIN', 'parent insert=OK 1', 'child begin=BEGIN', 'child move=' || moved,
                                   'child end=ROLLBACK', 'parent commit=COMMIT',
                                   'approved assignments, chore at home=1', 'approved assignments, chore in the other family=0'];
  real_b  constant text[] := array['child begin=BEGIN', 'child move=' || moved, 'parent insert=OK 1', 'child end=ROLLBACK',
                                   'approved assignments, chore at home=1', 'approved assignments, chore in the other family=0'];
  real_c  constant text[] := array['parent begin=BEGIN', 'parent insert=OK 1', 'child delete waits=true', 'parent commit=COMMIT',
                                   'child delete=' || removed, 'approved assignments, chore at home=1'];
  real_d  constant text[] := array['child begin=BEGIN', 'child delete=OK 1', 'parent insert waits=true', 'child commit=COMMIT',
                                   'parent insert=' || fk, 'assignments left=0', 'chore left=0'];
  -- The race, as the second cut's rule lets it happen.
  race_a  constant text[] := array['parent begin=BEGIN', 'parent insert=OK 1', 'child begin=BEGIN', 'child move=OK 1',
                                   'child end=COMMIT', 'parent commit=COMMIT',
                                   'approved assignments, chore at home=0', 'approved assignments, chore in the other family=1',
                                   'child delete there=OK 1', 'assignments left=0', 'chore left=0'];
  race_b  constant text[] := array['child begin=BEGIN', 'child move=OK 1', 'parent insert=OK 1', 'child end=COMMIT',
                                   'approved assignments, chore at home=0', 'approved assignments, chore in the other family=1',
                                   'child delete there=OK 1', 'assignments left=0', 'chore left=0'];
  v_timing text;
  want   text[];
  got    text[];
begin
  -- The real guard.
  foreach v_timing in array array['A', 'B', 'C', 'D'] loop
    want := case v_timing when 'A' then real_a when 'B' then real_b when 'C' then real_c else real_d end;
    select coalesce(array_agg(s.step || '=' || s.result order by s.ord), '{}') into got
      from c0502_steps s where s.stage = 'real' and s.timing = v_timing;
    if v_timing = 'A' and got = race_a then
      insert into c0502_failures values ('real A (insert first): with the assignment insert open, the child moved the chore into the family where they are a parent (OK 1) and deleted it there (OK 1); the sibling''s approved assignment left: 0');
    elsif v_timing = 'B' and got = race_b then
      insert into c0502_failures values ('real B (move first): with the move open, the parent''s approved assignment landed beside it (OK 1); the child deleted the chore in the family where they are a parent (OK 1); the sibling''s approved assignment left: 0');
    elsif got is distinct from want then
      insert into c0502_failures values (format('real %s: expected [%s], recorded [%s]', v_timing,
        array_to_string(want, '; '), array_to_string(got, '; ')));
    end if;
  end loop;
  if exists (select 1 from c0502_steps s where s.stage = 'real' and s.timing not in ('A', 'B', 'C', 'D')) then
    insert into c0502_failures values (format('real: unexpected steps [%s]', (select string_agg(s.step || '=' || s.result, '; ' order by s.ord)
      from c0502_steps s where s.stage = 'real' and s.timing not in ('A', 'B', 'C', 'D'))));
  end if;

  -- The negative control, where 0502 is installed: the race, step for step.
  if exists (select 1 from c0502_saved) then
    foreach v_timing in array array['A', 'B'] loop
      want := case v_timing when 'A' then race_a else race_b end;
      select coalesce(array_agg(s.step || '=' || s.result order by s.ord), '{}') into got
        from c0502_steps s where s.stage = 'second-cut' and s.timing = v_timing;
      if got is distinct from want then
        insert into c0502_failures values (format('NEGATIVE CONTROL: under the second cut''s rule, %s did not reproduce the race: expected [%s], recorded [%s]',
          case v_timing when 'A' then 'insert-first' else 'move-first' end,
          array_to_string(want, '; '), array_to_string(got, '; ')));
      end if;
    end loop;
    if exists (select 1 from c0502_steps s where s.stage = 'second-cut' and s.timing not in ('A', 'B')) then
      insert into c0502_failures values (format('NEGATIVE CONTROL: unexpected steps [%s]', (select string_agg(s.step || '=' || s.result, '; ' order by s.ord)
        from c0502_steps s where s.stage = 'second-cut' and s.timing not in ('A', 'B'))));
    end if;
    -- The real guard is back, exactly.
    if pg_get_functiondef(to_regprocedure('public.chore_with_assignments_is_a_managers_to_remove()'))
       is distinct from (select def from c0502_saved) then
      insert into c0502_failures values ('the real guard was not restored, byte for byte, after the negative control');
    end if;
  end if;
end
$$;

-- ── clean up, verify, and the verdict ───────────────────────────────────────
call pg_temp.c0502_clean();

do $$
declare n int; lines text[];
begin
  select (select count(*) from public.families where id in ('00000000-0000-4000-8502-0000000006f1', '00000000-0000-4000-8502-0000000006f2'))
       + (select count(*) from public.family_members where id in ('00000000-0000-4000-8502-0000000006c3', '00000000-0000-4000-8502-0000000006c4', '00000000-0000-4000-8502-0000000006c5'))
       + (select count(*) from public.chores where id::text like '00000000-0000-4000-8502-0000000006d_')
       + (select count(*) from public.chore_assignments where family_id = '00000000-0000-4000-8502-0000000006f1')
       + (select count(*) from auth.users where id in ('00000000-0000-4000-8502-0000000006a1', '00000000-0000-4000-8502-0000000006a3',
                                                      '00000000-0000-4000-8502-0000000006a4', '00000000-0000-4000-8502-0000000006b1'))
    into n;
  if n <> 0 then
    insert into c0502_failures values (format('cleanup: %s fixture rows remain', n));
  end if;
  perform pg_stat_clear_snapshot();
  if exists (select 1 from pg_stat_activity where application_name in ('c0502_parent', 'c0502_child', 'c0502_ddl')) then
    insert into c0502_failures values ('cleanup: a probe session is still connected');
  end if;

  select array_agg(line) into lines from c0502_failures;
  if lines is not null then
    raise exception E'a chore move can race an assignment:\n  - %', array_to_string(lines, E'\n  - ');
  end if;
  raise notice 'a-chore-move-cannot-race-an-assignment: OK (two sessions, the child a parent elsewhere and the parent filing an approved 50-point assignment for the sibling, every step recorded with its exact outcome: insert-first and move-first, the child''s move was refused with 42501 and the move sentence and the assignment landed with its chore at home; a delete of the empty-looking chore waited on the open insert and was then refused with 42501 and the delete sentence, the assignment kept; the rollback shape still works: the child''s delete of an empty chore committed and the parent''s waiting insert failed with 23503 on chore_assignments_chore_id_fkey, nothing left behind; negative control: under the second cut''s rule both timings reproduced the race step for step (insert and commit OK, one approved assignment with its chore in the other family, the delete there OK 1, nothing left); the real guard was restored byte for byte; every fixture, the four synthetic auth users included, was removed)';
end
$$;
