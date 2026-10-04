-- Approval payloads include private message drafts, answers and manager edits.
-- 0251's family-wide SELECT exposes those copies to unrelated children even
-- when 0476 denies them access to the destination conversation. Keep the
-- requester and active parent/adult reviewers; everyone else loses the row.
-- This is an approval-review boundary, not permission to read the chat itself.
-- Other AI request/run/tool copies remain a separate privacy repair.

-- Restrictive AND preserves inherited policies, grants and decision/cancel
-- rules. Replaying this unapplied migration replaces only its own guard.
drop policy if exists approval_requests_private_read_guard on public.approval_requests;
create policy approval_requests_private_read_guard on public.approval_requests
  as restrictive for select to authenticated
  using (
    public.is_family_member(family_id)
    and (
      public.can_manage_family(family_id)
      or exists (
        select 1 from public.family_members m
        where m.id = approval_requests.requested_by_member_id
          and m.family_id = approval_requests.family_id
          and m.user_id = auth.uid()
          and m.is_active
      )
    )
  );

comment on policy approval_requests_private_read_guard on public.approval_requests is
  'Private approval content is readable by its active requester or active household parent/adult reviewers. Null requesters are reviewer-only; existing restrictive policies still apply.';
