-- ── The websocket surface: what an unauthenticated subscriber receives ──────
--
-- 61 tables are in the `supabase_realtime` publication, and they include the
-- ones this session has spent its time on: `location_events`, `member_locations`,
-- `call_logs`, `family_messages`, `trust_audit_logs`, `permission_grants`,
-- `trust_policies`, `trust_delegations`, `emergency_sessions`.
--
-- Realtime evaluates RLS per subscriber, so a channel opened WITHOUT a user
-- token is evaluated as `anon`. The question this asks is therefore not about
-- the application's own subscriptions (which carry the user's JWT) but about
-- the floor underneath them: if a token is missing, expired, or never set,
-- does the stream fall silent or start talking?
--
-- Measured: anon reads 0 rows from all 61 published tables. That is the right
-- answer, and it is NOT a vacuous one — 29 of the 61 hold rows, several of them
-- hundreds (`call_logs` 500, `location_events` 500, `family_messages` 500), so
-- the instrument could have found something.
--
-- This exists as a ratchet rather than a finding. A future migration that grants
-- `anon` a read, or writes a policy `to public` whose predicate does not depend
-- on `auth.uid()`, turns the websocket into a public feed of whichever table it
-- touched, and nothing else in this repository would notice.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/realtime-anon-stream-check.sql
--
-- Audit C1-S8-11.
do $$
declare
  r record;
  n int;
  published int;
  populated int := 0;
  leaks text[] := '{}';
begin
  select count(*) into published
    from pg_publication_tables where pubname='supabase_realtime' and schemaname='public';
  if published < 40 then
    raise exception 'realtime: only % table(s) published — this probe is not looking at what it claims', published;
  end if;

  -- First, establish that the tables have something to leak. A check that
  -- passes because every table is empty is the vacuity this audit keeps
  -- finding in its own instruments (C4-S5-01), so it is ruled out up front.
  for r in select tablename from pg_publication_tables
            where pubname='supabase_realtime' and schemaname='public' loop
    execute format('select count(*) from public.%I', r.tablename) into n;
    if n > 0 then populated := populated + 1; end if;
  end loop;
  if populated < 10 then
    raise exception 'realtime: only % published table(s) hold rows — seed the harness before trusting this result', populated;
  end if;

  -- Now the question itself.
  set local role anon;
  for r in select tablename from pg_publication_tables
            where pubname='supabase_realtime' and schemaname='public' order by tablename loop
    begin
      execute format('select count(*) from public.%I', r.tablename) into n;
      if n > 0 then
        leaks := leaks || format('%s (%s rows)', r.tablename, n);
      end if;
    -- No privilege at all is the safest possible answer, not a failure.
    exception when insufficient_privilege then null;
    end;
  end loop;
  reset role;

  if array_length(leaks, 1) is not null then
    raise exception 'realtime: anon can read published table(s), so an unauthenticated websocket is a public feed: %',
      array_to_string(leaks, '; ');
  end if;
  raise notice 'realtime OK — anon reads 0 rows from all % published tables (% of them hold rows)', published, populated;
end $$;
