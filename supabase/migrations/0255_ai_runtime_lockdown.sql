-- ============================================================================
-- 0255_ai_runtime_lockdown.sql - close the write paths a family member could
-- use to make Bubaly act with someone else's authority.
-- ----------------------------------------------------------------------------
-- A security review of the concierge loop (0250/0251 + the Phase 2 code) found
-- that three tables still accepted rows from any signed-in member that the
-- server later treated as trusted:
--
--   1. family_automation_runs — INSERT was `is_family_member(family_id)` only,
--      so a teen could enqueue {plan_id: <any family plan>, state: 'ready',
--      requested_by_member_id: <a parent>} and the cron would execute the
--      plan's remaining steps with the parent's role.
--   2. approval_requests — INSERT was open on every column, so a member could
--      file a row that looks like Bubaly asking ("requested_by_kind = 'ai'")
--      carrying any tool payload; one tap of Approve by a parent executed it
--      with the trust gate skipped.
--   3. ai_conversations / ai_messages — the 0004 loop policy gives every
--      member SELECT/INSERT/UPDATE/DELETE on every conversation in the family,
--      so a child could read a parent's chat (and the raw tool results stored
--      on it) or plant a "user" turn in it that the model would obey on the
--      parent's next message.
--
-- The fix is the same rule the executor ledgers already follow: rows the
-- server acts on are written by server code (service client) and a member's
-- own writes are pinned to that member. Nothing here changes what the UI can
-- read except conversations, which become the requester's own.
--
-- Also adds ai_requests.client_request_id so a retried POST /api/ai/requests
-- (mobile timeouts) cannot plan and execute the same request twice.
--
-- ADDITIVE + IDEMPOTENT: policies are dropped and recreated, the column and
-- index are `if not exists`. Safe to re-run.
-- ============================================================================

-- ─── 1. family_automation_runs: a member may only file their own, unplanned run
drop policy if exists family_automation_runs_insert on public.family_automation_runs;
create policy family_automation_runs_insert on public.family_automation_runs
  for insert to authenticated
  with check (
    public.is_family_member(family_id)
    and created_by = auth.uid()
    and state = 'queued'
    and plan_id is null
    and request_id is null
    and current_step_id is null
    and requested_by_member_id is null
    and lease_owner is null
    and lease_expires_at is null
    and idempotency_key is null
  );

-- ─── 2. approval_requests: only the server files a request on Bubaly's behalf
-- A member's own approval request (a child asking to spend, 0088/0093) stays
-- possible; it must name that member, never carry a run/step linkage, and
-- never claim to be Bubaly.
drop policy if exists approval_requests_insert on public.approval_requests;
create policy approval_requests_insert on public.approval_requests
  for insert to authenticated
  with check (
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
    and requested_by_kind = 'member'
    and requested_by_member_id in (
      select fm.id from public.family_members fm
      where fm.user_id = auth.uid() and fm.family_id = approval_requests.family_id
    )
    and payload_kind is null
    and run_id is null
    and plan_step_id is null
    and coalesce(plan_step_ids, '{}'::uuid[]) = '{}'::uuid[]
  );

-- ─── 3. ai_requests: a member may only file their own, fresh concierge request
drop policy if exists ai_requests_insert on public.ai_requests;
create policy ai_requests_insert on public.ai_requests
  for insert to authenticated
  with check (
    public.is_family_member(family_id)
    and requested_by = auth.uid()
    and kind = 'concierge'
    and status = 'queued'
    and context_stats = '{}'::jsonb
    and prompt_tokens is null
    and completion_tokens is null
    and latency_ms is null
    and model is null
    and error is null
    and started_at is null
    and completed_at is null
    and (
      requested_by_member_id is null
      or requested_by_member_id in (
        select fm.id from public.family_members fm
        where fm.user_id = auth.uid() and fm.family_id = ai_requests.family_id
          and fm.is_active
      )
    )
  );

-- Retried intake: the client's own key, unique per family.
alter table public.ai_requests add column if not exists client_request_id text;
create unique index if not exists uq_ai_requests_client_request
  on public.ai_requests (family_id, client_request_id) where client_request_id is not null;

-- ─── 4. ai_conversations / ai_messages: a conversation belongs to its owner
-- The server (service client) still writes on the owner's behalf; the family
-- can no longer read or write each other's threads. Managers do not get a
-- view into a child's conversation here either — that is a product decision
-- to make explicitly, not a side effect of a loop policy.
drop policy if exists ai_conversations_select on public.ai_conversations;
drop policy if exists ai_conversations_insert on public.ai_conversations;
drop policy if exists ai_conversations_update on public.ai_conversations;
drop policy if exists ai_conversations_delete on public.ai_conversations;
create policy ai_conversations_select on public.ai_conversations
  for select to authenticated
  using (public.is_family_member(family_id) and user_id = auth.uid());
create policy ai_conversations_insert on public.ai_conversations
  for insert to authenticated
  with check (public.is_family_member(family_id) and user_id = auth.uid());
create policy ai_conversations_update on public.ai_conversations
  for update to authenticated
  using (public.is_family_member(family_id) and user_id = auth.uid())
  with check (public.is_family_member(family_id) and user_id = auth.uid());
create policy ai_conversations_delete on public.ai_conversations
  for delete to authenticated
  using (public.is_family_member(family_id) and user_id = auth.uid());

drop policy if exists ai_messages_select on public.ai_messages;
drop policy if exists ai_messages_insert on public.ai_messages;
drop policy if exists ai_messages_update on public.ai_messages;
drop policy if exists ai_messages_delete on public.ai_messages;
create policy ai_messages_select on public.ai_messages
  for select to authenticated
  using (
    public.is_family_member(family_id)
    and exists (
      select 1 from public.ai_conversations c
      where c.id = ai_messages.conversation_id
        and c.family_id = ai_messages.family_id
        and c.user_id = auth.uid()
    )
  );
create policy ai_messages_insert on public.ai_messages
  for insert to authenticated
  with check (
    public.is_family_member(family_id)
    and exists (
      select 1 from public.ai_conversations c
      where c.id = ai_messages.conversation_id
        and c.family_id = ai_messages.family_id
        and c.user_id = auth.uid()
    )
  );
create policy ai_messages_update on public.ai_messages
  for update to authenticated
  using (
    exists (
      select 1 from public.ai_conversations c
      where c.id = ai_messages.conversation_id
        and c.family_id = ai_messages.family_id
        and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.ai_conversations c
      where c.id = ai_messages.conversation_id
        and c.family_id = ai_messages.family_id
        and c.user_id = auth.uid()
    )
  );
create policy ai_messages_delete on public.ai_messages
  for delete to authenticated
  using (
    exists (
      select 1 from public.ai_conversations c
      where c.id = ai_messages.conversation_id
        and c.family_id = ai_messages.family_id
        and c.user_id = auth.uid()
    )
  );
