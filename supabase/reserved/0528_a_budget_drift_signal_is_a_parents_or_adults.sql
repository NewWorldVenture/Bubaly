-- 0528 — A budget-drift signal is a parent's or another adult's.
-- Requested on #771 in comment 6422105432, before any SQL: OPSD-O05 (and
-- DB-TBL-138's per-role check for family_signals, listed as Remaining).
--
-- family_signals (01420) gives select, insert, update and delete to
-- is_family_member(family_id). A budget-drift signal (0157) is the household's
-- money: its title and evidence carry a budget's spend and limit. The app keeps
-- it a parent's or adult's (readsHouseholdMoney, which is isManager): the
-- signals page, the reasoning report and the AI context drop budget_drift rows
-- for anyone else, and detection on a non-manager's Refresh writes none and
-- deletes nothing (lib/intelligence/hard-signals-server.ts, SignalReach).
-- Measured on a replay of main, as a child, one PostgREST statement each, OK 1
-- every time: reading the parents' groceries drift ("Spent 640 of 500"), an
-- unfiltered PATCH dismissing it, inserting a planted drift, deleting it.
--
--   read    a RESTRICTIVE SELECT policy, "A budget drift signal is read by a
--           parent or adult": kind <> 'budget_drift' or
--           can_manage_family(family_id), as 0509 narrowed a guest's reads;
--   write   a_budget_drift_signal_is_written_by_a_parent_or_adult(), BEFORE
--           INSERT, UPDATE and DELETE: for a signed-in caller, a write whose old
--           or new row is a budget drift needs a parent or adult of that row's
--           family (42501). An unfiltered write is held to its own command's
--           policies only, so a restrictive read alone would not stop it.
--
-- Every other kind stays any member's, as the member-reach detection, Restore
-- and Dismiss need. The service role and session-less writers (the nightly
-- model refresh) are exempt. So is the cascade of a member's removal, which may
-- run in that member's own session: emptying member_id (01420's on delete set
-- null) once their row is gone, and changing nothing else. A household deleted
-- by its parent cascades while they are still its parent. SECURITY DEFINER with
-- a pinned search_path, so the member check reads the rows as they are.
--
-- HELD: 0528, requested on #771 in comment 6422105432 and not yet confirmed.
-- It stays in supabase/reserved/ until every number below it has landed.
-- Proven by docs/audit/reserved/a-budget-drift-signal-is-a-parents-or-adults-check.sql
-- and .github/workflows/budget-drift-signal-runtime.yml. Not applied to
-- production by an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

drop policy if exists "A budget drift signal is read by a parent or adult" on public.family_signals;
create policy "A budget drift signal is read by a parent or adult" on public.family_signals
  as restrictive for select to authenticated
  using (kind <> 'budget_drift' or public.can_manage_family(family_id));

create or replace function public.a_budget_drift_signal_is_written_by_a_parent_or_adult()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return case when tg_op = 'DELETE' then old else new end; -- service role / server-side jobs
  end if;
  -- A member's removal emptying member_id, and nothing else.
  if tg_op = 'UPDATE' and old.member_id is not null and new.member_id is null
     and not exists (select 1 from public.family_members m where m.id = old.member_id)
     and (to_jsonb(new) - 'member_id' - 'updated_at') = (to_jsonb(old) - 'member_id' - 'updated_at') then
    return new;
  end if;
  if (tg_op <> 'DELETE' and new.kind = 'budget_drift' and not public.can_manage_family(new.family_id))
     or (tg_op <> 'INSERT' and old.kind = 'budget_drift' and not public.can_manage_family(old.family_id)) then
    raise exception 'A budget drift signal is the household''s money, a parent''s or another adult''s' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

comment on function public.a_budget_drift_signal_is_written_by_a_parent_or_adult() is
  'Refuses (42501) a signed-in caller''s insert, update or delete of a budget_drift family_signals row unless they are a parent or adult of its family (0528). The service role, and a member''s removal emptying member_id, are exempt.';

revoke all on function public.a_budget_drift_signal_is_written_by_a_parent_or_adult() from public, anon;

do $$
begin
  if to_regclass('public.family_signals') is null then
    raise exception '0528 needs public.family_signals (01420)';
  end if;
  if to_regprocedure('public.can_manage_family(uuid)') is null then
    raise exception '0528 needs public.can_manage_family(uuid)';
  end if;
  drop trigger if exists trg_family_signals_budget_drift_parent_or_adult on public.family_signals;
  create trigger trg_family_signals_budget_drift_parent_or_adult before insert or update or delete on public.family_signals
    for each row execute function public.a_budget_drift_signal_is_written_by_a_parent_or_adult();
end
$$;

do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'family_signals'
                    and policyname = 'A budget drift signal is read by a parent or adult'
                    and permissive = 'RESTRICTIVE' and cmd = 'SELECT'
                    and qual = '((kind <> ''budget_drift''::text) OR can_manage_family(family_id))') then
    raise exception '0528: the budget drift read rule is not in place as written';
  end if;
  if not exists (select 1 from pg_trigger g join pg_proc p on p.oid = g.tgfoid
                  where g.tgrelid = 'public.family_signals'::regclass
                    and g.tgfoid = 'public.a_budget_drift_signal_is_written_by_a_parent_or_adult()'::regprocedure
                    and g.tgenabled <> 'D'
                    and (g.tgtype & 1) = 1 and (g.tgtype & 2) = 2 and (g.tgtype & 28) = 28  -- ROW, BEFORE, INSERT/UPDATE/DELETE
                    and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path%') then
    raise exception '0528: the budget drift write guard is not in place';
  end if;
end
$$;
