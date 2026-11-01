-- ── Telemetry is dated by the server and written by its signed-in writer (0534) ──
--
-- TEL-O1, TEL-O10 and the limit half of TEL-O8. onboarding_events (0133) and
-- activation_events (0146) took inserts from anon and from any signed-in
-- account with no user, any step, meta, family, session, clock or created_at;
-- journey_events (0124) took any created_at from any member. The held 0534
-- stamps id and created_at on the server, takes writes from anon, narrows both
-- insert policies to the signed-in writer as TEL-O1 writes them, and limits an
-- account to 200 onboarding rows a day.
--
-- Fixture: Ada, the parent of Tel House, where Kit is a teen; Bo, the parent of
-- Other House.
--
-- What this probe asserts, through PostgREST's role, each attempt in its own
-- rolled-back subtransaction:
--
--   1. refused: anon filing an onboarding row and an activation row; as Ada,
--      an onboarding row with no user, a step the wizard has not got, a meta,
--      or a duration out of range, and an activation row with no user, for
--      Other House, with a session that is not the family, session_index 0 or
--      4, a negative clock, or a meta; and her 201st onboarding row within a
--      day; and dated by the server: Ada's onboarding and activation rows sent
--      as 2020 and Kit's journey row sent as 2099 are stored with now(), the
--      onboarding row under a new id;
--   2. control: the wizard's row (trackOnboarding), the activation row as
--      trackActivationOnce sends and reads it back and as
--      recordActivationServer sends it, and Kit's journey row (useJourney)
--      land; Ada's 200th row within a day lands, and Bo's rows do not count
--      against her; Ada reads her own onboarding rows; the server
--      (service_role) files a row dated 2020 and keeps that date;
--   3. wiring: each table carries one stamp and no second one, the limit is in
--      place, anon cannot insert either table, and both insert policies are
--      authenticated's and name the writer;
--
-- and, only where 0534 is installed:
--
--   N1. NEGATIVE CONTROL: with the stamps disabled, Ada's activation row sent
--       as 2020 keeps that date: the fixture reaches the defect;
--   M1. MUTATION CONTROL: with the step list taken out of the onboarding
--       policy, Ada's made-up step lands, so 1. catches the step going.
--
-- Everything is rolled back. This needs none of the other held files.
--
-- HELD with 0534: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/telemetry-writer-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0534 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8534-0000000000a1','c0534-ada@example.com'),
  ('00000000-0000-4000-8534-0000000000a2','c0534-bo@example.com'),
  ('00000000-0000-4000-8534-0000000000a3','c0534-kit@example.com')
  on conflict do nothing;
-- on_family_created files the creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8534-0000000000f1','Tel House','00000000-0000-4000-8534-0000000000a1'),
  ('00000000-0000-4000-8534-0000000000f2','Other House','00000000-0000-4000-8534-0000000000a2');
update public.family_members set role = 'parent', is_active = true
 where user_id in ('00000000-0000-4000-8534-0000000000a1', '00000000-0000-4000-8534-0000000000a2');
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8534-0000000000d3','00000000-0000-4000-8534-0000000000f1','00000000-0000-4000-8534-0000000000a3','Kit','teen',true);

-- One statement as one caller, and exactly what happened; back to the owner
-- with no user id. p_uid '' is a caller with no user (anon or the service role).
create or replace function pg_temp.c0534_as(p_role text, p_uid text, p_sql text) returns text
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
create or replace function pg_temp.c0534_try(p_role text, p_uid text, p_sql text) returns text
language plpgsql as $fn$
declare got text;
begin
  begin
    got := pg_temp.c0534_as(p_role, p_uid, p_sql);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  return got;
end
$fn$;

do $$
declare
  ada constant text := '00000000-0000-4000-8534-0000000000a1';
  bo constant text := '00000000-0000-4000-8534-0000000000a2';
  kit constant text := '00000000-0000-4000-8534-0000000000a3';
  onboarding constant text := 'insert into public.onboarding_events (user_id, session_id, step, phase, duration_ms, meta) values (%s, ''c0534-run'', %L, ''step'', %s, %L::jsonb)';
  activation constant text := 'insert into public.activation_events (user_id, family_id, session_id, milestone, session_index, ms_since_signup, meta) values (%s, %L, %L, ''first_outcome_viewed'', %s, %s, %L::jsonb)';
  failures text[] := '{}';
  bad text[];
  installed boolean;
  r record;
  got text;
  stamped_at timestamptz;
  kept_id boolean;
begin
  installed := exists (select 1 from pg_trigger g
                        where g.tgfoid = to_regprocedure('public.telemetry_row_is_stamped_by_the_server()'));

  -- 1. Refused.
  for r in select * from (values
      ('anon filed an onboarding row', 'anon', '',
       'insert into public.onboarding_events (session_id, step, phase) values (''c0534-anon'', ''profile'', ''started'')'),
      ('anon filed an activation row', 'anon', '',
       'insert into public.activation_events (session_id, milestone, session_index) values (''c0534-anon'', ''first_outcome_viewed'', 1)'),
      ('Ada filed an onboarding row with no user', 'authenticated', ada, format(onboarding, 'null', 'profile', '10', '{}')),
      ('Ada filed an onboarding row with a step the wizard has not got', 'authenticated', ada, format(onboarding, quote_literal(ada), 'free-money', '10', '{}')),
      ('Ada filed an onboarding row with a meta', 'authenticated', ada, format(onboarding, quote_literal(ada), 'profile', '10', '{"x": 1}')),
      ('Ada filed an onboarding row with a negative duration', 'authenticated', ada, format(onboarding, quote_literal(ada), 'profile', '-1', '{}')),
      ('Ada filed an onboarding row lasting longer than a week', 'authenticated', ada, format(onboarding, quote_literal(ada), 'profile', '604800001', '{}')),
      ('Ada filed an activation row with no user', 'authenticated', ada,
       format(activation, 'null', '00000000-0000-4000-8534-0000000000f1', '00000000-0000-4000-8534-0000000000f1', '1', 'null', '{}')),
      ('Ada filed an activation row for Other House', 'authenticated', ada,
       format(activation, quote_literal(ada), '00000000-0000-4000-8534-0000000000f2', '00000000-0000-4000-8534-0000000000f2', '1', 'null', '{}')),
      ('Ada filed an activation row whose session is not the family', 'authenticated', ada,
       format(activation, quote_literal(ada), '00000000-0000-4000-8534-0000000000f1', 'cohort-x', '1', 'null', '{}')),
      ('Ada filed an activation row in session 0', 'authenticated', ada,
       format(activation, quote_literal(ada), '00000000-0000-4000-8534-0000000000f1', '00000000-0000-4000-8534-0000000000f1', '0', 'null', '{}')),
      ('Ada filed an activation row in session 4', 'authenticated', ada,
       format(activation, quote_literal(ada), '00000000-0000-4000-8534-0000000000f1', '00000000-0000-4000-8534-0000000000f1', '4', 'null', '{}')),
      ('Ada filed an activation row with a negative clock', 'authenticated', ada,
       format(activation, quote_literal(ada), '00000000-0000-4000-8534-0000000000f1', '00000000-0000-4000-8534-0000000000f1', '1', '-5', '{}')),
      ('Ada filed an activation row with a meta', 'authenticated', ada,
       format(activation, quote_literal(ada), '00000000-0000-4000-8534-0000000000f1', '00000000-0000-4000-8534-0000000000f1', '1', 'null', '{"x": 1}'))) v(what, role, uid, stmt) loop
    got := pg_temp.c0534_try(r.role, r.uid, r.stmt);
    if got like 'OK%' then
      failures := array_append(failures, format('%s (%s)', r.what, got));
    elsif got not like '42501: %' then
      failures := array_append(failures, format('refused, but not by 0534''s rule: %s (%s)', r.what, got));
    end if;
  end loop;

  -- 1b. Ada's 201st onboarding row within a day.
  begin
    insert into public.onboarding_events (user_id, session_id, step, phase, created_at)
    select ada::uuid, 'c0534-earlier', 'profile', 'step', now() - interval '1 hour' from generate_series(1, 200);
    got := pg_temp.c0534_as('authenticated', ada, format(onboarding, quote_literal(ada), 'profile', '10', '{}'));
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  if got like 'OK%' then
    failures := array_append(failures, format('Ada filed her 201st onboarding row within a day (%s)', got));
  elsif got is distinct from '42501: onboarding telemetry limit reached' then
    failures := array_append(failures, format('refused, but not by 0534''s limit: Ada''s 201st onboarding row within a day (%s)', got));
  end if;

  -- 1c. Dated by the server.
  for r in select * from (values
      ('Ada''s onboarding row sent as 2020', 'onboarding_events', ada,
       'insert into public.onboarding_events (id, user_id, session_id, step, phase, created_at) values (''00000000-0000-4000-8534-0000000000e1'', ''00000000-0000-4000-8534-0000000000a1'', ''c0534-dated'', ''profile'', ''started'', ''2020-01-01'')'),
      ('Ada''s activation row sent as 2020', 'activation_events', ada,
       'insert into public.activation_events (user_id, family_id, session_id, milestone, session_index, created_at) values (''00000000-0000-4000-8534-0000000000a1'', ''00000000-0000-4000-8534-0000000000f1'', ''00000000-0000-4000-8534-0000000000f1'', ''signup'', 1, ''2020-01-01'')'),
      ('Kit''s journey row sent as 2099', 'journey_events', kit,
       'insert into public.journey_events (family_id, member_id, journey, phase, session_id, created_at) values (''00000000-0000-4000-8534-0000000000f1'', ''00000000-0000-4000-8534-0000000000d3'', ''c0534-journey'', ''started'', ''c0534-dated'', ''2099-01-01'')')) v(what, tbl, uid, stmt) loop
    begin
      got := pg_temp.c0534_as('authenticated', r.uid, r.stmt);
      execute format('select max(created_at) from public.%I where session_id in (''c0534-dated'', ''00000000-0000-4000-8534-0000000000f1'')', r.tbl) into stamped_at;
      kept_id := exists (select 1 from public.onboarding_events where id = '00000000-0000-4000-8534-0000000000e1');
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
    if got <> 'OK 1' then
      failures := array_append(failures, format('CONTROL: %s did not land (%s)', r.what, got));
    elsif stamped_at is distinct from now() then
      failures := array_append(failures, format('%s kept the date sent (%s)', r.what, stamped_at));
    elsif r.tbl = 'onboarding_events' and kept_id then
      failures := array_append(failures, format('%s kept the id sent', r.what));
    end if;
  end loop;

  -- 2. Controls.
  bad := '{}';
  for r in select * from (values
      ('the wizard''s row (trackOnboarding)', ada,
       format(onboarding, quote_literal(ada), 'profile', '1234', '{}')),
      ('the activation row as trackActivationOnce sends and reads it back', ada,
       format(activation, quote_literal(ada), '00000000-0000-4000-8534-0000000000f1', '00000000-0000-4000-8534-0000000000f1', '2', '90000000', '{}') || ' returning id'),
      ('the activation row as recordActivationServer sends it', ada,
       format(activation, quote_literal(ada), '00000000-0000-4000-8534-0000000000f1', '00000000-0000-4000-8534-0000000000f1', '3', 'null', '{}')),
      ('Kit''s journey row (useJourney)', kit,
       'insert into public.journey_events (family_id, member_id, journey, phase, step, session_id, duration_ms) values (''00000000-0000-4000-8534-0000000000f1'', ''00000000-0000-4000-8534-0000000000d3'', ''add-event'', ''completed'', 2, ''c0534-journey'', 4200)'),
      ('Ada reads her own onboarding rows', ada,
       'select 1 from public.onboarding_events where user_id = ''00000000-0000-4000-8534-0000000000a1''')) v(what, uid, stmt) loop
    got := pg_temp.c0534_try('authenticated', r.uid, r.stmt);
    if r.what like 'Ada reads%' then
      if got not like 'OK%' then
        bad := array_append(bad, format('%s: %s', r.what, got));
      end if;
    elsif got <> 'OK 1' then
      bad := array_append(bad, format('%s did not land (%s)', r.what, got));
    end if;
  end loop;
  begin
    insert into public.onboarding_events (user_id, session_id, step, phase, created_at)
    select ada::uuid, 'c0534-earlier', 'profile', 'step', now() - interval '1 hour' from generate_series(1, 199);
    insert into public.onboarding_events (user_id, session_id, step, phase, created_at)
    select bo::uuid, 'c0534-bo', 'profile', 'step', now() - interval '1 hour' from generate_series(1, 200);
    got := pg_temp.c0534_as('authenticated', ada, format(onboarding, quote_literal(ada), 'profile', '10', '{}'));
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  if got <> 'OK 1' then
    bad := array_append(bad, format('Ada''s 200th onboarding row within a day, with Bo''s 200 beside it, did not land (%s)', got));
  end if;
  begin
    got := pg_temp.c0534_as('service_role', '',
      'insert into public.onboarding_events (user_id, session_id, step, phase, created_at) values (null, ''c0534-server'', ''profile'', ''started'', ''2020-01-01'')');
    select max(created_at) into stamped_at from public.onboarding_events where session_id = 'c0534-server';
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  if got <> 'OK 1' or stamped_at is distinct from timestamptz '2020-01-01' then
    bad := array_append(bad, format('the server''s row dated 2020 did not keep its date (%s, %s)', got, stamped_at));
  end if;
  if cardinality(bad) > 0 then
    failures := array_append(failures, 'CONTROL: ' || array_to_string(bad, '; '));
  end if;

  -- 3. Wiring.
  if (select count(*) from pg_trigger g
       where g.tgfoid = to_regprocedure('public.telemetry_row_is_stamped_by_the_server()')
         and g.tgenabled <> 'D' and (g.tgtype & 7) = 7
         and g.tgrelid in ('public.onboarding_events'::regclass, 'public.activation_events'::regclass,
                           'public.journey_events'::regclass)) <> 3
     or exists (select 1 from pg_trigger g
                 where g.tgrelid in ('public.onboarding_events'::regclass, 'public.activation_events'::regclass,
                                     'public.journey_events'::regclass)
                   and g.tgname like '%\_created\_at\_is\_the\_servers')
     or not exists (select 1 from pg_trigger g
                     where g.tgrelid = 'public.onboarding_events'::regclass
                       and g.tgfoid = to_regprocedure('public.onboarding_events_per_account_limit()')
                       and g.tgenabled <> 'D' and (g.tgtype & 7) = 7)
     or has_table_privilege('anon', 'public.onboarding_events', 'insert')
     or has_table_privilege('anon', 'public.activation_events', 'insert')
     or (select count(*) from pg_policy p
          where p.polrelid in ('public.onboarding_events'::regclass, 'public.activation_events'::regclass)
            and p.polname in ('onboarding_events_insert', 'activation_events_insert')
            and p.polroles = array[(select o.oid from pg_roles o where o.rolname = 'authenticated')]
            and pg_get_expr(p.polwithcheck, p.polrelid) like '%(user_id = auth.uid())%') <> 2 then
    failures := array_append(failures, '0534 is not in place: the stamps, the limit, anon''s writes or the insert policies');
  end if;

  if installed then
    -- N1. The stamps disabled.
    begin
      alter table public.activation_events disable trigger activation_events_stamped_by_the_server;
      got := pg_temp.c0534_as('authenticated', ada,
        'insert into public.activation_events (user_id, family_id, session_id, milestone, session_index, created_at) values (''00000000-0000-4000-8534-0000000000a1'', ''00000000-0000-4000-8534-0000000000f1'', ''00000000-0000-4000-8534-0000000000f1'', ''signup'', 1, ''2020-01-01'')');
      select max(created_at) into stamped_at from public.activation_events where session_id = '00000000-0000-4000-8534-0000000000f1';
      if got <> 'OK 1' or stamped_at is distinct from timestamptz '2020-01-01' then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the stamp disabled Ada''s activation row did not keep the date she sent (%s, %s), so this fixture cannot see the defect', got, stamped_at));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. The step list taken out of the onboarding policy.
    begin
      drop policy onboarding_events_insert on public.onboarding_events;
      create policy onboarding_events_insert on public.onboarding_events for insert to authenticated
        with check (user_id = auth.uid() and meta = '{}'::jsonb
                    and (duration_ms is null or duration_ms between 0 and 604800000));
      got := pg_temp.c0534_as('authenticated', ada, format(onboarding, quote_literal(ada), 'free-money', '10', '{}'));
      if got <> 'OK 1' then
        failures := array_append(failures, format('MUTATION CONTROL: with the step list taken out Ada''s made-up step still did not land (%s), so 1. cannot catch the step going', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'telemetry is not dated by the server and written by its signed-in writer:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'telemetry-is-dated-by-the-server: OK (anon''s onboarding and activation rows, Ada''s onboarding rows with no user, a made-up step, a meta or a duration out of range, her activation rows with no user, for another household, with a session that is not the family, in session 0 or 4, with a negative clock or a meta, and her 201st onboarding row in a day were each refused; her onboarding and activation rows sent as 2020 and Kit''s journey row sent as 2099 were dated now(), the onboarding row under a new id; the wizard''s, both activation writers'' and useJourney''s rows land, Ada''s 200th lands beside Bo''s 200, she reads her own rows, and the server keeps its own date; the stamps, the limit, anon''s writes and the insert policies are in place; negative control: with the stamp disabled her 2020 activation row kept its date; mutation control: with the step list taken out her made-up step landed)';
end $$;

rollback;
