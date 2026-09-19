-- Bubaly :: 0330 - a behaviour note belongs to whoever wrote it
-- ----------------------------------------------------------------------------
-- Renumbered from 0302. main landed `0302_one_live_system_policy.sql` for a
-- different finding while this was in flight — the SEVENTH collision between
-- the two sessions, and the third in a row: every merge since 0300 has brought
-- one. Only the number changed; this touches `child_logins` and
-- `behavior_logs`, which nothing between 0303 and 0329 goes near.
-- ----------------------------------------------------------------------------
-- `behavior_logs` is filed in the repo's own SENSITIVE_TABLES
-- (lib/ai/context/policy.ts:68) as "behaviour notes about children", and carried
-- one `FOR ALL … is_family_member` policy. So the child a note is ABOUT could
-- edit or delete it, and the module offers the controls to every member because
-- it has no role gate at all.
--
-- It gets the rule 0301 gave `grades`, for the same reason. RECORDING a note is
-- plausibly any member's to do — a child logging "tidied the kitchen" is the
-- feature — while REWRITING someone else's is not. `behavior_logs.logged_by`
-- makes the narrow rule expressible:
--
--   INSERT           any member (is_family_member)
--   UPDATE / DELETE  the row's own author, or a manager
--
-- A null `logged_by` (rows predating the column, or the trusted server's) is a
-- manager's to edit, not anyone's.
--
-- `points` here feeds AI insight summaries only — it is not an economy — so this
-- is the integrity of a record rather than money.
--
-- WHAT THIS MIGRATION NO LONGER DOES, and why. It was written to fix
-- `child_logins` as well: its ALL policy was NAMED "Managers manage
-- child_logins" and predicated on `is_family_member`, so a child could delete a
-- sibling's login row. A parallel session found the same defect independently
-- and fixed it first, in 0297, with a fuller account of the impact — the
-- username is an INPUT to the child's credential derivation, so renaming a
-- sibling's row locks that sibling out until an adult repairs it.
--
-- 0297 keeps the policy's NAME and re-predicates it on can_manage_family. This
-- migration's sweep-by-shape would have dropped that policy and replaced it with
-- differently-named ones — the same boundary, but churning a deliberately named
-- policy and its documentation for nothing. So child_logins is left to 0297.
-- docs/audit/access-record-write-boundary-check.sql still asserts both halves;
-- it now proves 0297's fix as well as this one.
--
-- NOT INCLUDED, deliberately:
--   kid_progress   XP and streaks are written by lib/chores/server.ts as part of
--                  a child completing a chore. A child's own progress row being
--                  written on the child's action is the feature. Narrowing it
--                  needs the chore-reward path traced first, and a guess here
--                  would break what chores exist for.
--   habit_logs     A habit log is the logger's own record by construction.

do $$
declare
  pol       record;
  swept     int := 0;
  remaining int;
begin
  if to_regclass('public.behavior_logs') is null then
    return;
  end if;

  alter table public.behavior_logs enable row level security;

  drop policy if exists behavior_logs_select on public.behavior_logs;
  create policy behavior_logs_select on public.behavior_logs
    for select to authenticated using (public.is_family_member(family_id));
  drop policy if exists behavior_logs_insert on public.behavior_logs;
  create policy behavior_logs_insert on public.behavior_logs
    for insert to authenticated with check (public.is_family_member(family_id));
  drop policy if exists behavior_logs_author_or_manager_update on public.behavior_logs;
  create policy behavior_logs_author_or_manager_update on public.behavior_logs
    for update to authenticated
    using (public.can_manage_family(family_id) or logged_by = auth.uid())
    with check (public.can_manage_family(family_id) or logged_by = auth.uid());
  drop policy if exists behavior_logs_author_or_manager_delete on public.behavior_logs;
  create policy behavior_logs_author_or_manager_delete on public.behavior_logs
    for delete to authenticated
    using (public.can_manage_family(family_id) or logged_by = auth.uid());

  -- RESTRICTIVE guards are ANDed with every permissive policy, so a stray one
  -- re-added later cannot reopen the boundary by itself. This is what 0254 gave
  -- the wallet ledger and what 0217's by-name narrowing lacked.
  drop policy if exists behavior_logs_author_update_guard on public.behavior_logs;
  create policy behavior_logs_author_update_guard on public.behavior_logs
    as restrictive for update to authenticated
    using (public.can_manage_family(family_id) or logged_by = auth.uid())
    with check (public.can_manage_family(family_id) or logged_by = auth.uid());
  drop policy if exists behavior_logs_author_delete_guard on public.behavior_logs;
  create policy behavior_logs_author_delete_guard on public.behavior_logs
    as restrictive for delete to authenticated
    using (public.can_manage_family(family_id) or logged_by = auth.uid());

  -- Sweep by SHAPE rather than by name: 0088's is called "Members manage
  -- behavior_logs", but naming it here is how the next drift survives.
  for pol in
    select p.polname from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'behavior_logs'
      and p.polpermissive and p.polcmd in ('a','w','d','*')
      and p.polname not in ('behavior_logs_insert','behavior_logs_author_or_manager_update','behavior_logs_author_or_manager_delete')
  loop
    execute format('drop policy if exists %I on public.behavior_logs', pol.polname);
    swept := swept + 1;
    raise notice '0302: dropped stray permissive write policy behavior_logs.%', pol.polname;
  end loop;

  select count(*) into remaining
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'behavior_logs'
    and p.polpermissive and p.polcmd in ('a','w','d','*')
    and p.polname not in ('behavior_logs_insert','behavior_logs_author_or_manager_update','behavior_logs_author_or_manager_delete');
  if remaining <> 0 then
    raise exception '0302 FAILED: % permissive write policy(ies) still on behavior_logs after the sweep', remaining;
  end if;

  raise notice '0302 OK: % stray write policy(ies) swept; a behaviour note is its author''s to correct', swept;
end $$;
