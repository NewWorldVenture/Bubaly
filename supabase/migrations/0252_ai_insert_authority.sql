-- Client INSERT is not permission to manufacture executor authority.
-- 0251 restricts UPDATE, but its broad INSERT policies still allow a member
-- to enqueue a ready run under another member's identity or file an approval
-- that is already approved. Trusted server writers use the service role.
-- Keep legacy concierge inserts (including auto-completed status='executed')
-- working: they leave the NEW executor state queued and have no runtime links.

drop policy if exists family_automation_runs_insert on public.family_automation_runs;
create policy family_automation_runs_insert on public.family_automation_runs
  for insert to authenticated with check (
    public.is_family_member(family_id)
    and state = 'queued'
    and request_id is null
    and plan_id is null
    and current_step_id is null
    and requested_by_member_id is null
    and lease_owner is null
    and lease_expires_at is null
    and idempotency_key is null
  );

drop policy if exists approval_requests_insert on public.approval_requests;
create policy approval_requests_insert on public.approval_requests
  for insert to authenticated with check (
    public.is_family_member(family_id)
    and status = 'pending'
    and approvals = '[]'::jsonb
    and decided_by is null
    and decided_at is null
    and executed_at is null
    and execution_result is null
    and reviewed_by is null
    and review_note is null
    and edited_payload is null
  );

drop policy if exists parent_approvals_insert on public.parent_approvals;
create policy parent_approvals_insert on public.parent_approvals
  for insert to authenticated with check (
    public.is_family_member(family_id)
    and status = 'pending'
    and decided_by is null
    and decided_at is null
  );

-- Requests can be filed by members, but execution status and usage accounting
-- belong to the executor. A member reference must identify the actual caller.
drop policy if exists ai_requests_insert on public.ai_requests;
create policy ai_requests_insert on public.ai_requests
  for insert to authenticated with check (
    public.is_family_member(family_id)
    and requested_by = auth.uid()
    and (
      requested_by_member_id is null
      or exists (
        select 1 from public.family_members fm
        where fm.id = ai_requests.requested_by_member_id
          and fm.family_id = ai_requests.family_id
          and fm.user_id = auth.uid()
          and fm.is_active
      )
    )
    and status = 'queued'
    and context_stats = '{}'::jsonb
    and prompt_tokens is null
    and completion_tokens is null
    and latency_ms is null
    and model is null
    and error is null
    and started_at is null
    and completed_at is null
  );
