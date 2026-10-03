-- ── Eight AI requests sent together at 9 of 10 admit exactly one (0477, F19) ──
--
-- an-ai-request-is-admitted-under-the-allowance-check.sql proves the decision a
-- single session makes. This proves the property 0477 exists for: that
-- CONCURRENT sessions cannot all read 9 and all file. Eight real backends
-- (dblink) call `admit_ai_request` for one Free family seeded with 9 metered
-- rows this month, and exactly one is admitted.
--
-- ── HOW CONCURRENCY IS PROVEN RATHER THAN HOPED FOR ─────────────────────────
-- `dblink_send_query` returns immediately, so eight of them LOOK simultaneous
-- and may not overlap at all on a busy runner (a-child-cannot-spend-the-same-
-- dollar-twice-check.sql measured exactly that). So the parent holds the very
-- lock the function serialises on — the per-family advisory key
-- hashtextextended('ai_requests_admission:' || family, 0) — EXCLUSIVELY, at
-- session level, before sending anything. Every racer then reaches the
-- function's `pg_advisory_xact_lock` and parks. The parent polls `pg_locks`
-- until it has SEEN all eight queued on that key — eight backends waiting on
-- one lock is what "concurrent" means here, and CPU starvation cannot fake it —
-- and only then lets go.
--
-- ── NEGATIVE CONTROL ────────────────────────────────────────────────────────
-- The same eight sessions, released together from a gate, run a naive
-- count-then-insert (what every route did before 0477) with a short pause
-- between the two. They must overshoot: more than 10 rows. A probe that cannot
-- show the race it guards against proves nothing when it passes.
--
-- Seed rows and helpers are written by top-level statements so psql commits
-- them and the racing sessions can see them. Everything is removed at the end.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/eight-ai-requests-at-the-cap-admit-one-check.sql

\set FAM '00000000-0000-4000-8000-00000000f1a0'
\set FAM2 '00000000-0000-4000-8000-00000000f1a1'
\set USR '00000000-0000-4000-8000-00000000f1a2'

create extension if not exists dblink;
-- As the wallet race probe explains: on a CI database pg-bootstrap's default
-- privileges hand dblink's functions (including the SECURITY DEFINER
-- dblink_connect_u) to anon and authenticated. Only this probe, as owner, calls
-- dblink; no client role keeps any of it.
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
end $$;

-- One run at a time on a shared database (session-level; a killed run releases it).
do $solo$
declare waited_ms int := 0;
begin
  while not pg_try_advisory_lock(47700) loop
    if waited_ms >= 60000 then
      raise exception 'f19-race: another run of this probe has held advisory key 47700 for 60s; wait for it or use a throwaway instance';
    end if;
    perform pg_sleep(0.05);
    waited_ms := waited_ms + 50;
  end loop;
end
$solo$;

-- ── Seed (committed) ────────────────────────────────────────────────────────
delete from public.ai_requests where family_id in (:'FAM', :'FAM2');
delete from public.families where id in (:'FAM', :'FAM2');
insert into auth.users (id, email) values (:'USR', 'f19-race-probe@example.com') on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FAM', 'F19 Race House', :'USR'), (:'FAM2', 'F19 Naive House', :'USR');
insert into public.ai_requests (family_id, kind, feature, request_text, status)
  select f, 'feature', 'probe.seed', 'Probe seed', 'completed'
  from unnest(array[:'FAM'::uuid, :'FAM2'::uuid]) f, generate_series(1, 9);

-- ── Racer helpers (committed) ───────────────────────────────────────────────
-- The admission, as the ledger client calls it.
create or replace function public.f19_probe_admit(p_family uuid, p_i int) returns text
language plpgsql as $fn$
declare r record;
begin
  perform set_config('role', 'service_role', true);
  select * into r from public.admit_ai_request(p_family, 10, 'feature', 'Probe race', p_feature => 'probe.race.' || p_i);
  return r.outcome;
end
$fn$;

-- The naive count-then-insert every route used before 0477, gated so the
-- eight start together, with the round trip between count and insert.
create or replace function public.f19_probe_naive(p_family uuid, p_gate bigint, p_i int) returns text
language plpgsql as $fn$
declare used int;
begin
  perform pg_advisory_lock_shared(p_gate);
  perform pg_advisory_unlock_shared(p_gate);
  select count(*) into used from public.ai_requests
   where family_id = p_family and metered and created_at >= date_trunc('month', now(), 'UTC');
  perform pg_sleep(0.3);
  if used < 10 then
    insert into public.ai_requests (family_id, kind, feature, request_text, status)
      values (p_family, 'feature', 'probe.naive.' || p_i, 'Probe naive', 'completed');
    return 'filed';
  end if;
  return 'refused';
end
$fn$;

-- ── The race ────────────────────────────────────────────────────────────────
do $race$
declare
  fam   constant uuid := '00000000-0000-4000-8000-00000000f1a0';
  fam2  constant uuid := '00000000-0000-4000-8000-00000000f1a1';
  racers constant int := 8;
  admission_key bigint := hashtextextended('ai_requests_admission:' || fam::text, 0);
  gate_key constant bigint := 47701;
  v_conn text;
  i int;
  waiters int;
  seen int := 0;
  waited_ms int := 0;
  outcome text;
  admitted int := 0;
  refused int := 0;
  other text[] := '{}';
  naive_filed int := 0;
  n int;
  failures text[] := '{}';
begin
  v_conn := 'dbname=' || current_database()
    || ' host=' || split_part(current_setting('unix_socket_directories'), ',', 1)
    || ' port=' || current_setting('port')
    || ' user=' || current_user;

  -- Hold the family's admission lock: every racer will queue on it.
  perform pg_advisory_lock(admission_key);
  for i in 1..racers loop
    perform dblink_connect('f19_r' || i, v_conn || ' application_name=f19_racer_' || i);
    perform dblink_send_query('f19_r' || i, format('select public.f19_probe_admit(%L, %s)', fam, i));
  end loop;

  -- Evidence of concurrency: all eight parked on the one key at once.
  while waited_ms < 20000 loop
    select count(*) into waiters
      from pg_locks l
     where l.locktype = 'advisory'
       and l.classid  = ((admission_key >> 32) & 4294967295)::oid
       and l.objid    = (admission_key & 4294967295)::oid
       and l.objsubid = 1
       and not l.granted
       and l.database = (select oid from pg_database where datname = current_database());
    if waiters > seen then seen := waiters; end if;
    exit when seen >= racers;
    perform pg_sleep(0.005);
    waited_ms := waited_ms + 5;
  end loop;
  perform pg_advisory_unlock(admission_key);

  for i in 1..racers loop
    select v into outcome from dblink_get_result('f19_r' || i) as t(v text);
    perform * from dblink_get_result('f19_r' || i) as t(v text);
    perform dblink_disconnect('f19_r' || i);
    if outcome = 'admitted' then admitted := admitted + 1;
    elsif outcome = 'refused' then refused := refused + 1;
    else other := array_append(other, coalesce(outcome, 'null'));
    end if;
  end loop;

  if seen < racers then
    failures := array_append(failures, format('only %s of %s racers were ever seen queued on the admission lock together: the race was not exercised', seen, racers));
  end if;
  if admitted <> 1 or refused <> racers - 1 or array_length(other, 1) > 0 then
    failures := array_append(failures, format('%s racers at 9 of 10: admitted %s, refused %s, other %s (expected 1 admitted, %s refused)', racers, admitted, refused, other, racers - 1));
  end if;
  select count(*) into n from public.ai_requests where family_id = fam and metered and created_at >= date_trunc('month', now(), 'UTC');
  if n <> 10 then
    failures := array_append(failures, format('the family holds %s metered rows after the race; its cap is 10', n));
  end if;

  -- NEGATIVE CONTROL: the naive count-then-insert, eight sessions released together.
  perform pg_advisory_lock(gate_key);
  for i in 1..racers loop
    perform dblink_connect('f19_n' || i, v_conn || ' application_name=f19_naive_' || i);
    perform dblink_send_query('f19_n' || i, format('select public.f19_probe_naive(%L, %s, %s)', fam2, gate_key, i));
  end loop;
  seen := 0; waited_ms := 0;
  while waited_ms < 20000 loop
    select count(*) into waiters
      from pg_locks l
     where l.locktype = 'advisory' and l.objid = (gate_key & 4294967295)::oid and l.objsubid = 1 and not l.granted
       and l.database = (select oid from pg_database where datname = current_database());
    if waiters > seen then seen := waiters; end if;
    exit when seen >= racers;
    perform pg_sleep(0.005);
    waited_ms := waited_ms + 5;
  end loop;
  perform pg_advisory_unlock(gate_key);
  for i in 1..racers loop
    select v into outcome from dblink_get_result('f19_n' || i) as t(v text);
    perform * from dblink_get_result('f19_n' || i) as t(v text);
    perform dblink_disconnect('f19_n' || i);
    if outcome = 'filed' then naive_filed := naive_filed + 1; end if;
  end loop;
  select count(*) into n from public.ai_requests where family_id = fam2;
  if naive_filed < 2 or n <= 10 then
    failures := array_append(failures, format('negative control: the naive count-then-insert filed %s of %s (family at %s rows) — it should overshoot the cap; without that the race above is not shown to be observable', naive_filed, racers, n));
  end if;

  if array_length(failures, 1) > 0 then
    raise exception E'0477 race probe failed:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice '0477 race probe: % racers seen queued together; 1 admitted, % refused, 10 metered rows. Negative control: naive count-then-insert filed % (family at % rows).', racers, racers - 1, naive_filed, n;
end
$race$;

-- ── Cleanup ─────────────────────────────────────────────────────────────────
drop function if exists public.f19_probe_admit(uuid, int);
drop function if exists public.f19_probe_naive(uuid, bigint, int);
delete from public.ai_requests where family_id in (:'FAM', :'FAM2');
delete from public.families where id in (:'FAM', :'FAM2');
delete from auth.users where id = :'USR';
select pg_advisory_unlock(47700);
