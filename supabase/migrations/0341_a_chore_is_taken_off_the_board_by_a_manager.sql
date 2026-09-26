-- A chore is taken off the board by a manager. (MAIN-F20, the database half)
--
-- `chore_assignments` has been governed by one `is_family_member(family_id)`
-- policy FOR ALL since 0004. 0223 added a trigger so a child cannot approve
-- their own chore, and the app's own delete path, deleteChoreAssignmentAction
-- (app/(app)/dashboard/chores/actions.ts), refuses anyone who is not a
-- manager. But the database still let any member delete any row, so a child
-- with the public anon key and their own session could clear a sibling's
-- chores, or their own, straight through PostgREST:
--
--   delete from chore_assignments where id = '<a sibling's chore>'  -- 1 row
--
-- That is the one delete the app makes, and it is a manager's. Nothing else in
-- the codebase deletes an assignment through the API: rows also go when their
-- chore, member or family is deleted, and a foreign-key cascade is not subject
-- to RLS, so those are unaffected. The server's service role bypasses RLS too.
--
-- Restrictive, so it is ANDed with the existing permissive policy and cannot
-- widen anything. It covers DELETE only. INSERT is left as it is on purpose:
-- missions' createChoreAction lets a member create an unpriced chore for
-- family members (0307 made only the PRICE a manager's), and whether a child
-- may put chores on a sibling's board is a product decision, recorded on
-- MAIN-F20 rather than made here.
--
-- Probe: docs/audit/chore-assignment-delete-is-a-managers-check.sql.

drop policy if exists chore_assignments_delete_is_a_managers on public.chore_assignments;
create policy chore_assignments_delete_is_a_managers on public.chore_assignments
  as restrictive
  for delete
  to authenticated
  using (public.can_manage_family(family_id));

do $check$
begin
  if not exists (
    select 1 from pg_policies p
     where p.schemaname = 'public' and p.tablename = 'chore_assignments'
       and p.policyname = 'chore_assignments_delete_is_a_managers'
       and p.permissive = 'RESTRICTIVE' and p.cmd = 'DELETE'
       and p.qual like '%can_manage_family%'
  ) then
    raise exception '0341: the restrictive manager-only delete policy on chore_assignments is missing';
  end if;
end
$check$;
