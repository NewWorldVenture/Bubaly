-- Raw AI copies are requester/reviewer data. Keep active household managers,
-- active requesters and trusted service execution; ordinary household members
-- must not inherit another person's prompt, result or run summary.
-- This boundary still permits managers to read private-conversation copies.
-- Participant-only privacy and cached executor replay are separate concerns.

drop policy if exists ai_requests_private_read_guard on public.ai_requests;
create policy ai_requests_private_read_guard on public.ai_requests
  as restrictive for select to authenticated using (
    public.is_family_member(family_id) and (
      public.can_manage_family(family_id) or (
        requested_by = auth.uid() and (
          requested_by_member_id is null or exists (
            select 1 from public.family_members m
            where m.id = ai_requests.requested_by_member_id
              and m.family_id = ai_requests.family_id
              and m.user_id = auth.uid() and m.is_active
          )
        )
      )
    )
  );

drop policy if exists ai_request_context_private_read_guard on public.ai_request_context;
create policy ai_request_context_private_read_guard on public.ai_request_context
  as restrictive for select to authenticated using (
    public.is_family_member(family_id) and exists (
      select 1 from public.ai_requests r
      where r.id = ai_request_context.request_id
        and r.family_id = ai_request_context.family_id
    )
  );

drop policy if exists ai_plans_private_read_guard on public.ai_plans;
create policy ai_plans_private_read_guard on public.ai_plans
  as restrictive for select to authenticated using (
    public.is_family_member(family_id) and (
      (request_id is null and public.can_manage_family(family_id)) or exists (
        select 1 from public.ai_requests r
        where r.id = ai_plans.request_id and r.family_id = ai_plans.family_id
      )
    )
  );

drop policy if exists ai_plan_steps_private_read_guard on public.ai_plan_steps;
create policy ai_plan_steps_private_read_guard on public.ai_plan_steps
  as restrictive for select to authenticated using (
    public.is_family_member(family_id) and exists (
      select 1 from public.ai_plans p
      where p.id = ai_plan_steps.plan_id and p.family_id = ai_plan_steps.family_id
    )
  );

drop policy if exists family_automation_runs_private_read_guard on public.family_automation_runs;
create policy family_automation_runs_private_read_guard on public.family_automation_runs
  as restrictive for select to authenticated using (
    public.is_family_member(family_id) and (
      public.can_manage_family(family_id) or exists (
        select 1 from public.family_members m
        where m.id = family_automation_runs.requested_by_member_id
          and m.family_id = family_automation_runs.family_id
          and m.user_id = auth.uid() and m.is_active
      ) or (requested_by_member_id is null and created_by = auth.uid())
    ) and (
      request_id is null or exists (
        select 1 from public.ai_requests r
        where r.id = family_automation_runs.request_id
          and r.family_id = family_automation_runs.family_id
      )
    ) and (
      plan_id is null or exists (
        select 1 from public.ai_plans p
        where p.id = family_automation_runs.plan_id
          and p.family_id = family_automation_runs.family_id
          and (family_automation_runs.request_id is null or p.request_id = family_automation_runs.request_id)
      )
    )
  );

drop policy if exists ai_run_events_private_read_guard on public.ai_run_events;
create policy ai_run_events_private_read_guard on public.ai_run_events
  as restrictive for select to authenticated using (
    public.is_family_member(family_id) and exists (
      select 1 from public.family_automation_runs r
      where r.id = ai_run_events.run_id and r.family_id = ai_run_events.family_id
        and (
          ai_run_events.request_id is null or exists (
            select 1 from public.ai_requests q
            where q.id = ai_run_events.request_id and q.family_id = ai_run_events.family_id
              and (r.request_id is null or r.request_id = q.id)
          )
        ) and (
          ai_run_events.step_id is null or exists (
            select 1 from public.ai_plan_steps s
            where s.id = ai_run_events.step_id and s.family_id = ai_run_events.family_id
              and (r.plan_id is null or s.plan_id = r.plan_id)
          )
        )
    )
  );

drop policy if exists ai_tool_calls_private_read_guard on public.ai_tool_calls;
create policy ai_tool_calls_private_read_guard on public.ai_tool_calls
  as restrictive for select to authenticated using (
    public.is_family_member(family_id) and (
      public.can_manage_family(family_id) or (
        requested_by = auth.uid() and (
          requested_by_member_id is null or exists (
            select 1 from public.family_members m
            where m.id = ai_tool_calls.requested_by_member_id
              and m.family_id = ai_tool_calls.family_id
              and m.user_id = auth.uid() and m.is_active
          )
        )
      )
    ) and (
      request_id is null or exists (
        select 1 from public.ai_requests r
        where r.id = ai_tool_calls.request_id and r.family_id = ai_tool_calls.family_id
      )
    ) and (
      run_id is null or exists (
        select 1 from public.family_automation_runs r
        where r.id = ai_tool_calls.run_id and r.family_id = ai_tool_calls.family_id
      )
    ) and (
      plan_step_id is null or exists (
        select 1 from public.ai_plan_steps s
        where s.id = ai_tool_calls.plan_step_id and s.family_id = ai_tool_calls.family_id
      )
    )
  );

-- Count all household requests without returning private rows. The API still
-- checks before writing; this function does not reserve an atomic quota slot.
create or replace function public.count_family_ai_requests_month(
  p_family_id uuid, p_month_start timestamptz
) returns bigint language plpgsql stable security definer set search_path = '' as $$
declare
  executor_role text := current_setting('role', true);
  month_end timestamptz;
begin
  if executor_role is null or executor_role not in ('authenticated', 'service_role') then
    raise exception 'AI usage count requires an authorized database role' using errcode = '42501';
  end if;
  if executor_role = 'authenticated'
    and (auth.uid() is null or not public.is_family_member(p_family_id)) then
    raise exception 'AI usage count requires active household membership' using errcode = '42501';
  end if;
  if p_family_id is null or not exists (select 1 from public.families where id = p_family_id) then
    raise exception 'AI usage household is unavailable' using errcode = '42501';
  end if;
  if p_month_start is null or not isfinite(p_month_start)
    or p_month_start <> (date_trunc('month', p_month_start at time zone 'UTC') at time zone 'UTC') then
    raise exception 'AI usage count requires a UTC month start' using errcode = '22023';
  end if;
  month_end := ((p_month_start at time zone 'UTC') + interval '1 month') at time zone 'UTC';
  return (select count(*) from public.ai_requests
    where family_id = p_family_id and created_at >= p_month_start and created_at < month_end);
end;
$$;
revoke all on function public.count_family_ai_requests_month(uuid, timestamptz) from public, anon;
grant execute on function public.count_family_ai_requests_month(uuid, timestamptz) to authenticated, service_role;
comment on function public.count_family_ai_requests_month(uuid, timestamptz) is
  'Count-only UTC monthly usage for current active household members or actual trusted service execution; no private request content is returned.';
