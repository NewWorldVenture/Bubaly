-- 0502 — A chore with assignments is a manager's to remove.
-- 0374's rule at the parent row. Found and reproduced 2026-10-10 on a replay
-- of every runnable migration.
--
-- 0374 (F20, High) closed "a child could delete a sibling's approved
-- assignment (and the points with it)" by making DELETE on chore_assignments a
-- manager's only. F20's own ledger row notes that foreign-key cascades are
-- unaffected, and they are the way around it: `chores` keeps DELETE for any
-- member (is_family_member), and chore_assignments.chore_id is ON DELETE
-- CASCADE, which RLS does not gate. Measured as an active child, through
-- PostgREST's role, with a sibling's approved 50-point assignment on a chore:
--
--   delete the sibling's assignment directly          0 rows (0374 holds)
--   delete the chore                                   1 row
--   the sibling's approved 50-point assignment after   gone
--
-- Points are summed from approved chore_assignments (lib/rewards/points.ts,
-- 0439's balance guard), so one child erases a sibling's earned points, or
-- clears every open chore on the board, by deleting chores instead.
--
-- This adds a BEFORE DELETE trigger on chores: a signed-in non-manager may
-- delete a chore only while it has no assignments. 0374 already reserves every
-- assignment delete to a manager, so nothing a child could not remove directly
-- goes with the chore. The application's only chore deletes are rollbacks of a
-- chore the same call has just created, after its assignment insert failed
-- (missions' createChoreAction, lib/services/tasks, the assistant tool), so the
-- chore has no assignments and the rollback still lands. Managers, the service
-- role and session-less writers are unchanged. A family being deleted still
-- takes its chores: when the cascade reaches a chore its family row is already
-- gone, and the trigger lets that through.
--
-- SECURITY DEFINER so the question "does this chore have assignments" is
-- answered over every assignment, not only those the caller may see.
--
-- Recorded, not changed: `vacations` is member-deletable and cascades into six
-- manager-only tables (0347's append-only vacation_audit_logs among them).
-- Nothing in the application writes any of those six (0461), so today that
-- cascade erases nothing.
--
-- HELD: proposed as 0502 (the first number above 0501; requested on #771 in
-- comment 6097049650, not yet confirmed) in supabase/reserved/ until every
-- number below it has landed. Proven by
-- docs/audit/reserved/a-chore-with-assignments-is-a-managers-to-remove-check.sql
-- and .github/workflows/chore-cascade-runtime.yml. Not applied to production by
-- an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
begin
  if to_regclass('public.chores') is null or to_regclass('public.chore_assignments') is null then
    raise exception '0502 needs public.chores and public.chore_assignments';
  end if;
  if to_regprocedure('public.can_manage_family(uuid)') is null then
    raise exception '0502 needs public.can_manage_family(uuid)';
  end if;
end
$$;

create or replace function public.chore_with_assignments_is_a_managers_to_remove()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- The trusted server (service role, or a migration/seed with no session) and
  -- a family manager remove chores as before.
  if current_user = 'service_role'
     or coalesce(auth.role(), '') = 'service_role'
     or auth.uid() is null
     or public.can_manage_family(old.family_id) then
    return old;
  end if;
  -- A family being deleted takes its chores: by the time the cascade reaches a
  -- chore, the family row is gone.
  if not exists (select 1 from public.families f where f.id = old.family_id) then
    return old;
  end if;
  if exists (select 1 from public.chore_assignments a where a.chore_id = old.id) then
    raise exception 'A chore with assignments can only be removed by a family manager'
      using errcode = '42501';
  end if;
  return old;
end
$$;

comment on function public.chore_with_assignments_is_a_managers_to_remove() is
  'Refuses (42501) a signed-in non-manager deleting a chore that has assignments, whose ON DELETE CASCADE would otherwise remove assignments 0374 reserves to a manager (0502). Managers, the service role, session-less writers and a family deletion cascade are unaffected.';

revoke all on function public.chore_with_assignments_is_a_managers_to_remove() from public;

drop trigger if exists trg_chore_with_assignments_is_a_managers on public.chores;
create trigger trg_chore_with_assignments_is_a_managers
  before delete on public.chores
  for each row execute function public.chore_with_assignments_is_a_managers_to_remove();

do $$
begin
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.chores'::regclass
                    and t.tgname = 'trg_chore_with_assignments_is_a_managers'
                    and t.tgfoid = 'public.chore_with_assignments_is_a_managers_to_remove()'::regprocedure
                    and t.tgenabled <> 'D'
                    and (t.tgtype & 2) = 2      -- BEFORE
                    and (t.tgtype & 1) = 1      -- ROW
                    and (t.tgtype & 8) = 8) then -- DELETE
    raise exception '0502: chores does not carry the enabled BEFORE DELETE row guard';
  end if;
  if not exists (select 1 from pg_proc f
                  where f.oid = 'public.chore_with_assignments_is_a_managers_to_remove()'::regprocedure
                    and f.prosecdef
                    and exists (select 1 from unnest(f.proconfig) c where c ~ '^search_path=')) then
    raise exception '0502: the guard is not SECURITY DEFINER with a pinned search_path';
  end if;
end
$$;
