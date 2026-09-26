-- Bubaly :: 0348 - a chore, and its points, stay with the child who did it
--
-- Points are earned from chore_assignments in 'approved' with points_awarded
-- (lib/rewards/points.ts). 0223's decision guard stops a non-manager setting
-- the status to approved/rejected or changing the award amounts - but UPDATE
-- and DELETE were otherwise family-wide and nothing covered member_id. So a
-- child could re-point a sibling's APPROVED assignment at themselves and take
-- its points, delete a sibling's approved assignment (and the points with it),
-- or hand their own open chores to a sibling (moveAssignmentAction was not
-- manager-gated either; it is now).
--
-- Every application writer updates either the caller's own assignment
-- (submitting proof, focus sessions) or runs as a manager / the service role
-- (approval, rejection, rebalancing). So:
--   UPDATE  your own assignment, or a manager; and a non-manager may not
--           change an assignment once it is approved (trigger)
--   DELETE  a manager
--
-- Pinned by docs/audit/chore-assignment-owner-check.sql.

create or replace function public.chore_assignment_settled_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is null or public.can_manage_family(old.family_id) then
    return new;
  end if;
  if old.status = 'approved' then
    raise exception 'An approved chore can only be changed by a family manager'
      using errcode = '42501';
  end if;
  return new;
end
$$;

do $$
begin
  if to_regclass('public.chore_assignments') is null then
    return;
  end if;
  drop policy if exists chore_assignments_update on public.chore_assignments;
  drop policy if exists chore_assignments_delete on public.chore_assignments;
  create policy chore_assignments_update on public.chore_assignments for update to authenticated
    using (public.is_family_member(family_id)
      and (public.is_self_member(member_id) or public.can_manage_family(family_id)))
    with check (public.is_family_member(family_id)
      and (public.is_self_member(member_id) or public.can_manage_family(family_id)));
  create policy chore_assignments_delete on public.chore_assignments for delete to authenticated
    using (public.can_manage_family(family_id));

  drop trigger if exists trg_chore_assignment_settled_guard on public.chore_assignments;
  create trigger trg_chore_assignment_settled_guard before update on public.chore_assignments
    for each row execute function public.chore_assignment_settled_guard();
end
$$;
