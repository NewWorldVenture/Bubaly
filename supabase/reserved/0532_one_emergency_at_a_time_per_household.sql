-- 0532 — One emergency at a time per household.
-- Requested on #771 in comment 6561084910, before any SQL: OPSD-O03 (N10).
--
-- activateEmergencyAction (app/(app)/dashboard/trust/actions.ts) keeps one
-- emergency at a time with a read and then an insert, and emergency_sessions
-- (0093, 0260) carries no rule of its own: two managers activating at the same
-- instant both get in, and the trust engine (lib/trust/server.ts) applies the
-- union of both sessions' elevated domains while the console names one. A
-- manager can also PATCH an ended session's ended_at back to null beside an
-- open one. The app's writers are that action and endEmergencyAction.
--
-- Not the partial unique index the register suggests: an index predicate
-- cannot read now(), so an expired-but-unended session, which the app already
-- treats as stopped, would block every new activation unless production rows
-- were ended first, and the index would not build where the race has already
-- left two open sessions in a household.
--
-- one_emergency_at_a_time(), SECURITY DEFINER with a pinned search_path, BEFORE
-- INSERT and UPDATE: when the new row is open (ended_at null, expires_at after
-- now()) and the old row was not the same open session, the household's
-- activations queue on one transaction-scoped advisory lock, and an open
-- session already there refuses the write (23505, "Emergency mode is already
-- on for this household"). PostgREST runs READ COMMITTED and the guard is
-- VOLATILE, so the check after the lock sees an earlier activation once it
-- commits. Every writer is held to it, the service role too: it is a rule of
-- the data, not a permission. Ending a session, an expired session, a change
-- that keeps the same session open, reads and the rows already there are
-- unchanged; no data changes. No application change.
--
-- HELD: 0532, requested on #771 in comment 6561084910 and not yet confirmed.
-- It stays in supabase/reserved/ until every number below it has landed.
-- Proven by docs/audit/reserved/one-emergency-at-a-time-per-household-check.sql
-- and .github/workflows/emergency-session-runtime.yml. Not applied to
-- production by an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

create or replace function public.one_emergency_at_a_time()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Not open: ending a session, or one already past its expiry.
  if new.ended_at is not null or new.expires_at <= now() then
    return new;
  end if;
  -- The same session, open before and after, in the same household (it is the
  -- open session the check below would find).
  if tg_op = 'UPDATE' and old.ended_at is null and old.expires_at > now()
     and old.family_id = new.family_id then
    return new;
  end if;
  -- One activation at a time per household, then count what is committed.
  perform pg_advisory_xact_lock(hashtextextended('emergency session admission ' || new.family_id::text, 0));
  if exists (select 1 from public.emergency_sessions s
              where s.family_id = new.family_id
                and s.ended_at is null
                and s.expires_at > now()) then
    raise exception 'Emergency mode is already on for this household' using errcode = '23505';
  end if;
  return new;
end
$$;

comment on function public.one_emergency_at_a_time() is
  'Refuses (23505) an emergency_sessions insert or update that would open a second live session in a household (0532, OPSD-O03). Activations queue on a per-household advisory lock. An ended or expired session does not count. Every writer is held to it.';

revoke all on function public.one_emergency_at_a_time() from public, anon;

do $$
begin
  if to_regclass('public.emergency_sessions') is null then
    raise exception '0532 needs public.emergency_sessions (0093)';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'emergency_sessions'
         and column_name in ('family_id', 'ended_at', 'expires_at')) <> 3 then
    raise exception '0532 needs emergency_sessions'' family_id, ended_at and expires_at';
  end if;
  drop trigger if exists trg_emergency_sessions_one_at_a_time on public.emergency_sessions;
  create trigger trg_emergency_sessions_one_at_a_time before insert or update on public.emergency_sessions
    for each row execute function public.one_emergency_at_a_time();
end
$$;

do $$
begin
  if not exists (select 1 from pg_trigger g join pg_proc p on p.oid = g.tgfoid
                  where g.tgrelid = 'public.emergency_sessions'::regclass
                    and g.tgfoid = 'public.one_emergency_at_a_time()'::regprocedure
                    and g.tgenabled <> 'D'
                    and (g.tgtype & 1) = 1 and (g.tgtype & 2) = 2        -- FOR EACH ROW, BEFORE
                    and (g.tgtype & 4) = 4 and (g.tgtype & 16) = 16      -- INSERT, UPDATE
                    and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path%') then
    raise exception '0532: the one-emergency guard is not in place';
  end if;
end
$$;
