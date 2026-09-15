-- Bubaly :: 0303 - the price list is not the child's to write
-- ----------------------------------------------------------------------------
-- The chores economy's PRICE LIST lives in `public.chores` — points, cash_cents,
-- cash_min_cents, cash_max_cents, points_min, points_max, reward_mode,
-- auto_approve_score — and the amount actually paid lives in
-- `public.chore_assignments.points_awarded` / `.cash_awarded_cents`.
--
-- Both tables were UPDATE-able by `is_family_member(family_id)`: by the child
-- who gets paid. The app gates chore authoring to managers, and says so in its
-- own words ("the check sits here … because here is where the screen's claim
-- lives", dashboard/chores/actions.ts) — but the browser talks to PostgREST with
-- the anon key, so the server action is not the boundary. The policy is.
--
-- THREE cash-out paths all re-read the tampered value instead of re-deriving it:
--
--   1. payChoreRewardAction (wallet/actions.ts) is manager-only, but the AMOUNT
--      is the child's number: `assignment.cash_awarded_cents ?? chore.cash_cents`,
--      straight into creditChildWallet, with no upper bound and no comparison
--      against what the chore was worth when a manager last saved it.
--      evaluateTrust's maxAmountCents is a per-family policy row that does not
--      exist by default, so the cap is opt-in.
--   2. AUTO-APPROVE. `canAutoApprove` returns true as soon as
--      `quality_score >= chore.auto_approve_score`, and auto_approve_score was
--      child-writable. Set it to 0 and the parent is out of the loop; the
--      approval then runs under the SERVICE ROLE and stamps points_awarded /
--      cash_awarded_cents from the tampered chore row.
--   3. POINTS. lib/rewards/points.ts sums points_awarded over approved
--      assignments, and that total is what reward_redemptions spends.
--
-- 0223's `chore_assignment_decision_guard` does NOT cover this. It fires only on
-- a transition INTO 'approved'/'rejected' (`new.status is distinct from
-- old.status`), so an UPDATE that changes only cash_awarded_cents on an
-- already-approved row passed untouched. Proven on a replayed database as a real
-- child session: the child rewrote the parent's chore price AND set
-- cash_awarded_cents = 4242424 on their own approved assignment, and the guard
-- did not fire.
--
-- Same class as the allowance_rules CRITICAL closed by 0309 — a child-writable
-- input that a trusted server path later treats as authority — on the surface
-- that fix did not cover.
--
-- TWO DIFFERENT SHAPES, because the two tables are not the same problem.
--
-- `chores` is authored by a parent and read by everyone. Writes become
-- can_manage_family outright; reads stay family-wide, because a child must see
-- the chores assigned to them. The repo already intends this — the missions
-- action's own doc comment reads "Parent creates a chore", and the dashboard
-- action enforces it with refuseUnlessManager.
--
-- `chore_assignments` is different: a member MUST still move their OWN
-- assignment through the member-driven statuses, and record ai_score and
-- submitted_at when they submit proof. So the restriction is BY COLUMN, not by
-- row. The decision guard is extended to refuse a non-manager touching the four
-- columns that decide what gets paid — points_awarded, cash_awarded_cents,
-- approved_by, approved_at — on INSERT or UPDATE, whether or not `status` also
-- changed. No legitimate member path writes them: the submit path sets only
-- ai_score and submitted_at, and every insert path sets only
-- family_id/chore_id/member_id/due_at.

-- ── chores: the price list ──────────────────────────────────────────────────
do $$
declare
  pol       record;
  swept     int := 0;
  remaining int;
begin
  if to_regclass('public.chores') is null then
    return;
  end if;

  alter table public.chores enable row level security;

  drop policy if exists chores_select on public.chores;
  create policy chores_select on public.chores
    for select to authenticated using (public.is_family_member(family_id));
  drop policy if exists chores_mng_insert on public.chores;
  create policy chores_mng_insert on public.chores
    for insert to authenticated with check (public.can_manage_family(family_id));
  drop policy if exists chores_mng_update on public.chores;
  create policy chores_mng_update on public.chores
    for update to authenticated using (public.can_manage_family(family_id))
    with check (public.can_manage_family(family_id));
  drop policy if exists chores_mng_delete on public.chores;
  create policy chores_mng_delete on public.chores
    for delete to authenticated using (public.can_manage_family(family_id));

  drop policy if exists chores_manager_insert_guard on public.chores;
  create policy chores_manager_insert_guard on public.chores
    as restrictive for insert to authenticated with check (public.can_manage_family(family_id));
  drop policy if exists chores_manager_update_guard on public.chores;
  create policy chores_manager_update_guard on public.chores
    as restrictive for update to authenticated using (public.can_manage_family(family_id))
    with check (public.can_manage_family(family_id));
  drop policy if exists chores_manager_delete_guard on public.chores;
  create policy chores_manager_delete_guard on public.chores
    as restrictive for delete to authenticated using (public.can_manage_family(family_id));

  for pol in
    select p.polname from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'chores'
      and p.polpermissive and p.polcmd in ('a','w','d','*')
      and p.polname not in ('chores_mng_insert','chores_mng_update','chores_mng_delete')
  loop
    execute format('drop policy if exists %I on public.chores', pol.polname);
    swept := swept + 1;
    raise notice '0303: dropped stray permissive write policy chores.%', pol.polname;
  end loop;

  select count(*) into remaining
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'chores'
    and p.polpermissive and p.polcmd in ('a','w','d','*')
    and p.polname not in ('chores_mng_insert','chores_mng_update','chores_mng_delete');
  if remaining <> 0 then
    raise exception '0303 FAILED: % permissive write policy(ies) still on chores after the sweep', remaining;
  end if;

  raise notice '0303 OK: % stray write policy(ies) swept; the chore price list is a manager''s to write', swept;
end $$;

-- ── chore_assignments: the four columns that decide what gets paid ──────────
create or replace function public.chore_assignment_decision_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
declare
  trusted boolean;
begin
  -- The trusted server (service role, or a migration/seed with no authenticated
  -- session) and family managers decide; a plain member does not.
  trusted := current_user = 'service_role'
          or coalesce(auth.role(), '') = 'service_role'
          or auth.uid() is null
          or public.can_manage_family(new.family_id);

  -- 1. The decision itself — the guard 0223 added, unchanged in effect.
  if new.status in ('approved','rejected')
     and (tg_op = 'INSERT' or new.status is distinct from old.status) then
    if not trusted then
      raise exception
        'chore assignment status % may only be set by a family manager', new.status
        using errcode = '42501';
    end if;
  end if;

  -- 2. The PAYOUT columns, whether or not the status moved with them. This is
  --    what 0223 could not see: an UPDATE that changes only cash_awarded_cents
  --    on an already-approved row never entered the branch above, so a child
  --    could set their own payout after the fact.
  if not trusted then
    if tg_op = 'INSERT' then
      -- An assignment is created with who/what/when. Every insert path in the
      -- app sets family_id, chore_id, member_id and due_at and nothing else, so
      -- a member arriving with a payout already filled in is not a legitimate
      -- flow. Zero and null are both "unset".
      if coalesce(new.points_awarded, 0) <> 0
         or coalesce(new.cash_awarded_cents, 0) <> 0
         or new.approved_by is not null
         or new.approved_at is not null then
        raise exception
          'a chore assignment may not be created with a payout already recorded'
          using errcode = '42501';
      end if;
    else
      if new.points_awarded is distinct from old.points_awarded
         or new.cash_awarded_cents is distinct from old.cash_awarded_cents
         or new.approved_by is distinct from old.approved_by
         or new.approved_at is distinct from old.approved_at then
        raise exception
          'chore assignment payout fields may only be set by a family manager'
          using errcode = '42501';
      end if;
    end if;
  end if;

  return new;
end; $fn$;

drop trigger if exists trg_chore_assignment_decision_guard on public.chore_assignments;
create trigger trg_chore_assignment_decision_guard
  before insert or update on public.chore_assignments
  for each row execute function public.chore_assignment_decision_guard();

revoke all on function public.chore_assignment_decision_guard() from public;
