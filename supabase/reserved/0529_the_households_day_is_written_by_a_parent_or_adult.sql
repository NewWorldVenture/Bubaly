-- 0529 — The household's day is written by a parent or another adult.
-- Requested on #771 in comment 6422372306, before any SQL: OPSD-O06 (0125's
-- family_operating_index and 0149's reasoning_snapshots "still allow any member
-- to write the household's day directly over PostgREST") and COORD-O01
-- ("Writes to workload_snapshots are not restricted to managers at the
-- database").
--
-- These three are the day and the week the parents trend: the Family Operating
-- Index, the reasoning report's "since yesterday", and who carried the
-- household's work. The app writes them only from a load that reads the
-- household, which is a parent's or adult's (readsHouseholdMoney, which is
-- isManager), or from the service role: loadOperatingIndex upserts only when
-- reach is 'household', loadAndSnapshotReasoning returns before its upsert for
-- 'member', and saveWorkloadSnapshotAction returns unless isManager. Their
-- policies are is_family_member(family_id). Measured on a replay of main, as a
-- child, one PostgREST statement each, OK 1 every time: today's index rewritten
-- to 100 "thriving", tomorrow's filed, the reasoning snapshot rewritten to all
-- clear with nothing needing attention, another filed, the workload share
-- rewritten to 90%, the workload history deleted.
--
-- One SECURITY DEFINER trigger function,
-- a_household_day_is_written_by_a_parent_or_adult(), BEFORE INSERT, UPDATE and
-- DELETE on family_operating_index, reasoning_snapshots and workload_snapshots:
-- for a signed-in caller, a write needs can_manage_family of the row's family,
-- old and new (42501). The service role and session-less writers (the crons)
-- are exempt, and so is a member's removal cascading into workload_snapshots
-- (its member_id is on delete cascade), which may run in that member's own
-- session: a delete whose member row is already gone. Reads are unchanged. The
-- body reads member_id through to_jsonb(old), so it resolves on all three
-- tables (docs/audit/plpgsql-bodies-resolve-check.sql).
--
-- HELD: 0529, requested on #771 in comment 6422372306 and not yet confirmed.
-- It stays in supabase/reserved/ until every number below it has landed.
-- Proven by docs/audit/reserved/the-households-day-is-written-by-a-parent-or-adult-check.sql
-- and .github/workflows/household-day-runtime.yml. Not applied to production by
-- an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

create or replace function public.a_household_day_is_written_by_a_parent_or_adult()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return case when tg_op = 'DELETE' then old else new end; -- service role / server-side jobs
  end if;
  -- A member's removal cascading into their workload history.
  if tg_op = 'DELETE' and (to_jsonb(old) ->> 'member_id') is not null
     and not exists (select 1 from public.family_members m where m.id = (to_jsonb(old) ->> 'member_id')::uuid) then
    return old;
  end if;
  if (tg_op <> 'DELETE' and not public.can_manage_family(new.family_id))
     or (tg_op <> 'INSERT' and not public.can_manage_family(old.family_id)) then
    raise exception 'The household''s day is kept by a parent or another adult' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

comment on function public.a_household_day_is_written_by_a_parent_or_adult() is
  'Refuses (42501) a signed-in caller''s write to family_operating_index, reasoning_snapshots or workload_snapshots unless they are a parent or adult of the row''s family (0529). The service role, and a member''s removal cascading into workload_snapshots, are exempt.';

revoke all on function public.a_household_day_is_written_by_a_parent_or_adult() from public, anon;

do $$
declare
  t text;
begin
  if to_regprocedure('public.can_manage_family(uuid)') is null then
    raise exception '0529 needs public.can_manage_family(uuid)';
  end if;
  foreach t in array array['family_operating_index', 'reasoning_snapshots', 'workload_snapshots'] loop
    if to_regclass('public.' || t) is null then
      raise exception '0529 needs public.%', t;
    end if;
    execute format('drop trigger if exists %I on public.%I', 'trg_' || t || '_parent_or_adult', t);
    execute format('create trigger %I before insert or update or delete on public.%I '
                   'for each row execute function public.a_household_day_is_written_by_a_parent_or_adult()',
                   'trg_' || t || '_parent_or_adult', t);
  end loop;
end
$$;

do $$
declare
  n int;
begin
  select count(*) into n
    from pg_trigger g join pg_proc p on p.oid = g.tgfoid
   where g.tgrelid in ('public.family_operating_index'::regclass, 'public.reasoning_snapshots'::regclass,
                       'public.workload_snapshots'::regclass)
     and g.tgfoid = 'public.a_household_day_is_written_by_a_parent_or_adult()'::regprocedure
     and g.tgenabled <> 'D'
     and (g.tgtype & 1) = 1 and (g.tgtype & 2) = 2 and (g.tgtype & 28) = 28  -- ROW, BEFORE, INSERT/UPDATE/DELETE
     and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path%';
  if n <> 3 then
    raise exception '0529: % of 3 tables carry the parent-or-adult guard', n;
  end if;
end
$$;
