-- 0534 — Telemetry is dated by the server and written by its signed-in writer.
-- Requested on #771 in comment 6561275883, before any SQL: TEL-O1 (N1, N2, N4,
-- N16), TEL-O10 (N17, corrected) and the limit half of TEL-O8 (N16's residual),
-- as one file. Applied as the register writes them, TEL-O1 and TEL-O10 define
-- the same function twice, with different bodies, under two sets of trigger
-- names, which leaves two stamping triggers on a table each calling whichever
-- body was created last.
--
-- onboarding_events (0133) and activation_events (0146) take inserts from anon,
-- and from any signed-in account under its own user_id or none, with any step,
-- meta, family, session, clock or created_at; journey_events (0124) takes any
-- created_at from any member. The funnel, the TTFV clock and /dashboard/journeys
-- read those dates and values: a member could backdate their own household's
-- milestone, forge ms_since_signup, or date a journey row in the future so it
-- stays in every window. Measured on a replay of main, each landing as sent:
-- anon filed an onboarding row and an activation row; a signed-in user filed an
-- onboarding row with no user dated 2020, one with a step the wizard has not
-- got ('free-money') and a meta, an activation for a household they are not in
-- with session_index 9, ms_since_signup -5 and a 2020 date, and a journey row
-- dated 2099.
--
-- What the app writes is already what this allows (main 66cf73651): the wizard
-- (trackOnboarding) sends the signed-in owner's user_id, a session id, one of
-- the seven ONBOARDING_STEPS, a phase and a duration, and no meta; activation
-- (trackActivationOnce, recordActivationServer) sends session_id = family_id,
-- session_index from sessionIndexFromMs (1 to 3) and ms_since_signup from
-- recordableMsSinceSignup (null or at least 0); a row with no user is never
-- counted (lib/analytics/activation-attestation.ts), so refusing one loses
-- nothing. useJourney sets neither id nor created_at.
--
--   stamp   telemetry_row_is_stamped_by_the_server(), SECURITY INVOKER as the
--           register writes it: for a role that does not bypass row-level
--           security, id and created_at are the server's; the service role and
--           the seeds keep theirs. One <table>_stamped_by_the_server BEFORE
--           INSERT trigger on each of the three tables; TEL-O10's
--           <table>_created_at_is_the_servers is dropped if it is there;
--   anon    loses insert, update, delete and truncate on onboarding_events and
--           activation_events;
--   insert  onboarding_events_insert and activation_events_insert become
--           TEL-O1's, for authenticated: the writer's own user_id, the wizard's
--           steps, no meta, a duration within a week; and the household the
--           writer is in, one cohort per family, session 1 to 3, no negative
--           clock, no meta;
--   limit   onboarding_events_per_account_limit() (TEL-O8): 200 rows a day per
--           account, with the (user_id, created_at) index it counts on. Not
--           TEL-O8's second, restrictive insert policy: its one-day duration
--           bound would refuse a wizard left open overnight, and TEL-O1's policy
--           already names the writer.
--
-- Reads are unchanged. The register's one-off cleanup of rows already dated
-- out of range is not here: it deletes production rows, and is recorded in
-- docs/PENDING_PROD_MIGRATIONS.md as an optional owner step. No application
-- change.
--
-- HELD: 0534, requested on #771 in comment 6561275883 and not yet confirmed.
-- It stays in supabase/reserved/ until every number below it has landed.
-- Proven by docs/audit/reserved/telemetry-is-dated-by-the-server-check.sql and
-- .github/workflows/telemetry-writer-runtime.yml. Not applied to production by
-- an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
begin
  if to_regclass('public.onboarding_events') is null or to_regclass('public.activation_events') is null
     or to_regclass('public.journey_events') is null then
    raise exception '0534 needs public.onboarding_events (0133), public.activation_events (0146) and public.journey_events (0124)';
  end if;
end
$$;

create or replace function public.telemetry_row_is_stamped_by_the_server()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_bypass boolean;
begin
  select r.rolsuper or r.rolbypassrls into v_bypass from pg_catalog.pg_roles r where r.rolname = current_user;
  if coalesce(v_bypass, false) then
    return new; -- the service role, the seeds and the owner date their own rows
  end if;
  new.id := gen_random_uuid();
  new.created_at := now();
  return new;
end
$$;

comment on function public.telemetry_row_is_stamped_by_the_server() is
  'Stamps a telemetry row''s id and created_at with the server''s for any role that does not bypass row-level security (0534, TEL-O1 and TEL-O10).';

revoke all on function public.telemetry_row_is_stamped_by_the_server() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['onboarding_events', 'activation_events', 'journey_events'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_created_at_is_the_servers', t);
    execute format('drop trigger if exists %I on public.%I', t || '_stamped_by_the_server', t);
    execute format('create trigger %I before insert on public.%I for each row execute function public.telemetry_row_is_stamped_by_the_server()',
                   t || '_stamped_by_the_server', t);
  end loop;
end
$$;

revoke insert, update, delete, truncate on public.onboarding_events, public.activation_events from anon;

drop policy if exists onboarding_events_insert on public.onboarding_events;
create policy onboarding_events_insert on public.onboarding_events for insert to authenticated
  with check (user_id = auth.uid()
              and meta = '{}'::jsonb
              and step in ('profile', 'family', 'value', 'about', 'members', 'pin', 'done')
              and (duration_ms is null or duration_ms between 0 and 604800000));

drop policy if exists activation_events_insert on public.activation_events;
create policy activation_events_insert on public.activation_events for insert to authenticated
  with check (user_id = auth.uid()
              and family_id is not null
              and public.is_family_member(family_id)
              and session_id = family_id::text
              and session_index between 1 and 3
              and (ms_since_signup is null or ms_since_signup >= 0)
              and meta = '{}'::jsonb);

create index if not exists idx_onboarding_events_user_created on public.onboarding_events (user_id, created_at);

create or replace function public.onboarding_events_per_account_limit()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_bypass boolean;
begin
  select r.rolsuper or r.rolbypassrls into v_bypass from pg_catalog.pg_roles r where r.rolname = current_user;
  if coalesce(v_bypass, false) then
    return new;
  end if;
  -- Runs as the inserting role, which reads its own rows (0133's select policy).
  if (select count(*) from public.onboarding_events e
       where e.user_id = new.user_id and e.created_at > now() - interval '1 day') >= 200 then
    raise exception 'onboarding telemetry limit reached' using errcode = '42501';
  end if;
  return new;
end
$$;

comment on function public.onboarding_events_per_account_limit() is
  'Refuses (42501) a signed-in account''s 201st onboarding_events row within a day (0534, TEL-O8). Roles that bypass row-level security are exempt.';

revoke all on function public.onboarding_events_per_account_limit() from public, anon, authenticated;

drop trigger if exists onboarding_events_per_account_limit on public.onboarding_events;
create trigger onboarding_events_per_account_limit before insert on public.onboarding_events
  for each row execute function public.onboarding_events_per_account_limit();

do $$
begin
  if (select count(*) from pg_trigger g
       where g.tgfoid = 'public.telemetry_row_is_stamped_by_the_server()'::regprocedure
         and g.tgenabled <> 'D' and (g.tgtype & 7) = 7    -- FOR EACH ROW, BEFORE, INSERT
         and g.tgrelid in ('public.onboarding_events'::regclass, 'public.activation_events'::regclass,
                           'public.journey_events'::regclass)) <> 3 then
    raise exception '0534: each telemetry table must carry the server''s stamp';
  end if;
  if exists (select 1 from pg_trigger g
              where g.tgname like '%\_created\_at\_is\_the\_servers'
                and g.tgrelid in ('public.onboarding_events'::regclass, 'public.activation_events'::regclass,
                                  'public.journey_events'::regclass)) then
    raise exception '0534: a second stamping trigger is still on a telemetry table';
  end if;
  if not exists (select 1 from pg_trigger g
                  where g.tgrelid = 'public.onboarding_events'::regclass
                    and g.tgfoid = 'public.onboarding_events_per_account_limit()'::regprocedure
                    and g.tgenabled <> 'D' and (g.tgtype & 7) = 7) then
    raise exception '0534: the per-account onboarding limit is not in place';
  end if;
  if has_table_privilege('anon', 'public.onboarding_events', 'insert')
     or has_table_privilege('anon', 'public.activation_events', 'insert') then
    raise exception '0534: anon still inserts telemetry';
  end if;
  if (select count(*) from pg_policy p
       where p.polrelid in ('public.onboarding_events'::regclass, 'public.activation_events'::regclass)
         and p.polname in ('onboarding_events_insert', 'activation_events_insert')
         and p.polroles = array[(select r.oid from pg_roles r where r.rolname = 'authenticated')]
         and pg_get_expr(p.polwithcheck, p.polrelid) like '%(user_id = auth.uid())%') <> 2 then
    raise exception '0534: the telemetry insert policies do not name the signed-in writer';
  end if;
end
$$;
