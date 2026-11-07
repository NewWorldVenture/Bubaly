-- ── One emergency at a time per household (0532) ─────────────────────────────
--
-- OPSD-O03: activateEmergencyAction keeps one emergency at a time with a read
-- and then an insert, and emergency_sessions (0093, 0260) carries no rule of
-- its own, so two managers activating at the same instant both got in and the
-- trust engine applied the union of their elevated domains. The held 0532 puts
-- the rule on the table: an open session (ended_at null, expires_at after now())
-- refuses a second, and activations queue on a per-household lock.
--
-- Fixture: Emergency House, with a parent, an adult and a teen, an emergency
-- ended yesterday and one that expired an hour ago without being ended; Other
-- House, with its own parent and an open emergency.
--
-- What this probe asserts, through PostgREST's role, each attempt in its own
-- rolled-back subtransaction:
--
--   1. refused by 0532's guard (23505, its own sentence), each beside the
--      parent's open emergency: the adult activating a second; the adult
--      reopening yesterday's ended emergency; the server (service_role, no
--      user) opening a second; and the adult's activation sent from another
--      session while the parent's is still in flight, which must wait for it;
--   2. control: the parent activates although an ended, an expired and another
--      household's open emergency are there; the adult ends the parent's
--      emergency and activates a new one; the parent changes their open
--      emergency's reason; the server activates one where none is open;
--   3. wiring: the guard, enabled, FOR EACH ROW, BEFORE INSERT and UPDATE,
--      SECURITY DEFINER with a pinned search_path;
--
-- and, only where 0532 is installed:
--
--   N1. NEGATIVE CONTROL: with the guard disabled, the adult's second
--       activation lands: the fixture reaches the defect;
--   M1. MUTATION CONTROL: with the guard firing on INSERT only, the adult's
--       reopening of an ended emergency lands, so 1. catches the UPDATE half.
--
-- Everything is rolled back. This needs none of the other held files.
--
-- HELD with 0532: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/emergency-session-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0532 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8532-0000000000a1','c0532-parent@example.com'),
  ('00000000-0000-4000-8532-0000000000a2','c0532-adult@example.com'),
  ('00000000-0000-4000-8532-0000000000a3','c0532-teen@example.com'),
  ('00000000-0000-4000-8532-0000000000a4','c0532-other-parent@example.com')
  on conflict do nothing;
-- on_family_created files the creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8532-0000000000f1','Emergency House','00000000-0000-4000-8532-0000000000a1'),
  ('00000000-0000-4000-8532-0000000000f2','Other House','00000000-0000-4000-8532-0000000000a4');
update public.family_members set role = 'parent', is_active = true
 where user_id in ('00000000-0000-4000-8532-0000000000a1', '00000000-0000-4000-8532-0000000000a4');
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8532-0000000000d2','00000000-0000-4000-8532-0000000000f1','00000000-0000-4000-8532-0000000000a2','Adult','adult',true),
  ('00000000-0000-4000-8532-0000000000d3','00000000-0000-4000-8532-0000000000f1','00000000-0000-4000-8532-0000000000a3','Teen','teen',true);
insert into public.emergency_sessions (id, family_id, kind, activated_at, ended_at, expires_at, elevated_domains) values
  ('00000000-0000-4000-8532-0000000000e1','00000000-0000-4000-8532-0000000000f1','medical', now() - interval '1 day 2 hours', now() - interval '1 day', now() - interval '1 day' + interval '2 hours', '{health}'),
  ('00000000-0000-4000-8532-0000000000e2','00000000-0000-4000-8532-0000000000f1','severe_weather', now() - interval '5 hours', null, now() - interval '1 hour', '{calendar}'),
  ('00000000-0000-4000-8532-0000000000e3','00000000-0000-4000-8532-0000000000f2','general', now() - interval '10 minutes', null, now() + interval '4 hours', '{calendar}');

-- One statement as one caller, and exactly what happened; back to the owner
-- with no user id. p_uid '' is a caller with no user (the service role).
create or replace function pg_temp.c0532_as(p_role text, p_uid text, p_sql text) returns text
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

-- The parent's activation, as activateEmergencyAction inserts it.
create or replace function pg_temp.c0532_parent_activates() returns text
language sql as $fn$
  select pg_temp.c0532_as('authenticated', '00000000-0000-4000-8532-0000000000a1',
    'insert into public.emergency_sessions (id, family_id, kind, activated_by, elevated_domains) values (''00000000-0000-4000-8532-0000000000e9'', ''00000000-0000-4000-8532-0000000000f1'', ''medical'', (select id from public.family_members where user_id = ''00000000-0000-4000-8532-0000000000a1''), ''{health}'')');
$fn$;

-- A second session, for the concurrent activation (1d). dblink lands in public,
-- and the harness's default privileges would hand its functions to the client
-- roles; this whole probe is rolled back, so neither the extension nor any
-- grant outlives it (see a-child-cannot-spend-the-same-dollar-twice-check.sql).
create extension if not exists dblink;

do $$
declare
  guard constant text := '23505: Emergency mode is already on for this household';
  adult constant text := '00000000-0000-4000-8532-0000000000a2';
  parent constant text := '00000000-0000-4000-8532-0000000000a1';
  failures text[] := '{}';
  bad text[];
  installed boolean;
  r record;
  got text;
  got2 text;
  got3 text;
  other_pid int;
  waited boolean;
  n int;
begin
  installed := exists (select 1 from pg_trigger g
                        where g.tgfoid = to_regprocedure('public.one_emergency_at_a_time()'));

  -- 1. Beside the parent's open emergency.
  for r in select * from (values
      ('the adult activated a second emergency', 'authenticated', adult,
       'insert into public.emergency_sessions (family_id, kind, activated_by, elevated_domains) values (''00000000-0000-4000-8532-0000000000f1'', ''missing_person'', ''00000000-0000-4000-8532-0000000000d2'', ''{location}'')'),
      ('the adult reopened yesterday''s ended emergency', 'authenticated', adult,
       'update public.emergency_sessions set ended_at = null, expires_at = now() + interval ''4 hours'' where id = ''00000000-0000-4000-8532-0000000000e1'''),
      ('the server opened a second emergency', 'service_role', '',
       'insert into public.emergency_sessions (family_id, kind, elevated_domains) values (''00000000-0000-4000-8532-0000000000f1'', ''general'', ''{calendar}'')')) v(what, role, uid, stmt) loop
    begin
      got := pg_temp.c0532_parent_activates();
      got2 := pg_temp.c0532_as(r.role, r.uid, r.stmt);
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
    if got <> 'OK 1' then
      failures := array_append(failures, format('CONTROL: the parent could not activate before %s was tried (%s)', r.what, got));
    elsif got2 like 'OK%' then
      failures := array_append(failures, format('%s beside the parent''s open one (%s)', r.what, got2));
    elsif got2 is distinct from guard then
      failures := array_append(failures, format('refused, but not by 0532''s guard: %s beside the parent''s open one (%s)', r.what, got2));
    end if;
  end loop;

  -- 1d. Two managers at the same instant: while the parent's activation is in
  -- flight, the adult's, sent from another session, waits for it, so it sees
  -- the parent's once that is committed (READ COMMITTED, as PostgREST runs,
  -- takes each statement's snapshot afresh). The second session cannot see this
  -- transaction's fixtures, so its insert is refused after the wait either way;
  -- it is always rolled back, and gives up after lock_timeout.
  begin
    got := pg_temp.c0532_parent_activates();
    begin
      perform dblink_connect('c0532_other', 'dbname=' || current_database()
        || ' host=' || split_part(current_setting('unix_socket_directories'), ',', 1)
        || ' port=' || current_setting('port') || ' user=' || current_user
        || ' application_name=c0532_other');
      select t.pid into other_pid from dblink('c0532_other', 'select pg_backend_pid()') as t(pid int);
      perform dblink_send_query('c0532_other', format($q$
        do $d$
        begin
          perform set_config('lock_timeout', '20s', true);
          perform set_config('role', 'authenticated', true);
          perform set_config('request.jwt.claims', %L, true);
          insert into public.emergency_sessions (family_id, kind, elevated_domains) values (%L, 'missing_person', '{location}');
          raise exception using errcode = 'P0R01';
        end
        $d$
      $q$, json_build_object('sub', adult, 'role', 'authenticated')::text, '00000000-0000-4000-8532-0000000000f1'));
      for n in 1 .. 100 loop
        exit when dblink_is_busy('c0532_other') = 0
               or exists (select 1 from pg_locks l where l.pid = other_pid and not l.granted);
        perform pg_sleep(0.1);
      end loop;
      waited := exists (select 1 from pg_locks l where l.pid = other_pid and not l.granted);
    exception when others then
      waited := null;
      failures := array_append(failures, format('CONTROL: the adult''s activation could not be sent from another session (%s: %s)', sqlstate, sqlerrm));
    end;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  -- That rollback ends the parent's activation; the second goes on, and is
  -- rolled back by its own block.
  begin
    perform * from dblink_get_result('c0532_other') as t(status text);
  exception when others then null;
  end;
  begin perform dblink_disconnect('c0532_other'); exception when others then null; end;
  if got <> 'OK 1' then
    failures := array_append(failures, format('CONTROL: the parent could not activate the emergency held in flight (%s)', got));
  elsif waited is not null and not waited then
    failures := array_append(failures, 'the adult''s activation from another session went ahead while the parent''s was in flight, so both would open');
  end if;

  -- 2. Controls.
  bad := '{}';
  begin
    got := pg_temp.c0532_parent_activates();
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  if got <> 'OK 1' then
    bad := array_append(bad, format('the parent could not activate beside an ended, an expired and another household''s open emergency (%s)', got));
  end if;
  begin
    got := pg_temp.c0532_parent_activates();
    got2 := pg_temp.c0532_as('authenticated', adult,
      'update public.emergency_sessions set ended_at = now(), ended_by = ''00000000-0000-4000-8532-0000000000d2'' where id = ''00000000-0000-4000-8532-0000000000e9'' and ended_at is null');
    got3 := pg_temp.c0532_as('authenticated', adult,
      'insert into public.emergency_sessions (family_id, kind, activated_by, elevated_domains) values (''00000000-0000-4000-8532-0000000000f1'', ''missing_person'', ''00000000-0000-4000-8532-0000000000d2'', ''{location}'')');
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  if got <> 'OK 1' or got2 <> 'OK 1' or got3 <> 'OK 1' then
    bad := array_append(bad, format('the parent''s activation, the adult ending it and the adult''s new one did not all go through (%s, %s, %s)', got, got2, got3));
  end if;
  begin
    got := pg_temp.c0532_parent_activates();
    got2 := pg_temp.c0532_as('authenticated', parent,
      'update public.emergency_sessions set reason = ''Kit fell off the climbing frame'' where id = ''00000000-0000-4000-8532-0000000000e9''');
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  if got <> 'OK 1' or got2 <> 'OK 1' then
    bad := array_append(bad, format('the parent could not change their open emergency''s reason (%s, %s)', got, got2));
  end if;
  begin
    got := pg_temp.c0532_as('service_role', '',
      'insert into public.emergency_sessions (family_id, kind, elevated_domains) values (''00000000-0000-4000-8532-0000000000f1'', ''general'', ''{calendar}'')');
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  if got <> 'OK 1' then
    bad := array_append(bad, format('the server could not activate where none is open (%s)', got));
  end if;
  if cardinality(bad) > 0 then
    failures := array_append(failures, 'CONTROL: ' || array_to_string(bad, '; '));
  end if;

  -- 3. Wiring.
  if not exists (select 1 from pg_trigger g join pg_proc p on p.oid = g.tgfoid
                  where g.tgrelid = 'public.emergency_sessions'::regclass
                    and g.tgname = 'trg_emergency_sessions_one_at_a_time'
                    and g.tgfoid = to_regprocedure('public.one_emergency_at_a_time()')
                    and g.tgenabled <> 'D'
                    and (g.tgtype & 1) = 1 and (g.tgtype & 2) = 2 and (g.tgtype & 4) = 4 and (g.tgtype & 16) = 16
                    and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path%') then
    failures := array_append(failures, '0532''s guard is not in place on emergency_sessions');
  end if;

  if installed then
    -- N1. The guard disabled.
    begin
      alter table public.emergency_sessions disable trigger trg_emergency_sessions_one_at_a_time;
      got := pg_temp.c0532_parent_activates();
      got2 := pg_temp.c0532_as('authenticated', adult,
        'insert into public.emergency_sessions (family_id, kind, activated_by, elevated_domains) values (''00000000-0000-4000-8532-0000000000f1'', ''missing_person'', ''00000000-0000-4000-8532-0000000000d2'', ''{location}'')');
      if got <> 'OK 1' or got2 <> 'OK 1' then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the guard disabled the adult''s second activation still did not land (%s, %s), so this fixture cannot see the defect', got, got2));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. The guard firing on INSERT only.
    begin
      drop trigger trg_emergency_sessions_one_at_a_time on public.emergency_sessions;
      create trigger trg_emergency_sessions_one_at_a_time before insert on public.emergency_sessions
        for each row execute function public.one_emergency_at_a_time();
      got := pg_temp.c0532_parent_activates();
      got2 := pg_temp.c0532_as('authenticated', adult,
        'update public.emergency_sessions set ended_at = null, expires_at = now() + interval ''4 hours'' where id = ''00000000-0000-4000-8532-0000000000e1''');
      if got <> 'OK 1' or got2 <> 'OK 1' then
        failures := array_append(failures, format('MUTATION CONTROL: with the guard firing on INSERT only the adult''s reopening still did not land (%s, %s), so 1. cannot catch the UPDATE half going', got, got2));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a household can have more than one emergency at a time:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'one-emergency-at-a-time-per-household: OK (beside the parent''s open emergency, the adult''s second activation, the adult reopening an ended one and the server opening a second were each refused by 0532''s guard, and the adult''s activation from another session waited while the parent''s was in flight; the parent activates beside an ended, an expired and another household''s open emergency, the adult ends it and activates a new one, the parent changes their open emergency''s reason, and the server activates where none is open; the guard is in place; negative control: with it disabled the adult''s second activation landed; mutation control: with it firing on INSERT only the adult''s reopening landed)';
end $$;

rollback;
