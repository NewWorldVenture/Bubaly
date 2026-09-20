-- ── A child does not choose the number Bubaly dials (0332) ─────────────────
--
-- `concierge_calls` (0173_concierge_calls.sql) is the OUTBOUND half of the
-- concierge: one row per requested phone call — the callee, the NUMBER, the
-- goal, and the AI-written `brief` whoever places it reads from. 0173 gave the
-- table four role-blind policies (`is_family_member(family_id)` on select,
-- insert, update and delete) and nothing narrowed it for 159 migrations.
--
-- The application never agreed. All four mutations in
-- app/(app)/dashboard/concierge-calls/actions.ts — requestCallAction,
-- cancelCallAction, requeueCallAction, logCallOutcomeAction — open with
-- `if (!isManager(ctx.active.role)) return { ok: false, error: … }`, and
-- requestCallAction's own comment says why: an outbound AI call "places
-- real-world bookings/cancellations on the family's behalf and can incur
-- telephony cost — a manager-only action. RLS is only family-scoped (any
-- member), so the server action is the authorization gate." A server action is
-- not a gate: children hold real logins and PostgREST is reachable.
--
-- It does not dial today. app/api/concierge-calls/place/route.ts has no voice
-- provider, refuses to write `status='calling'`, and parks every due queued row
-- as 'action_needed'. That HONESTY BOUNDARY is what keeps it shut — and it is
-- also why this is worth closing now rather than after a provider lands. What a
-- child's row reaches today is a PARENT: the queue a manager re-queues, cancels
-- or logs an outcome against, addressed by id alone.
--
-- Asserts, in both directions:
--
--   1. a child can still READ the family's call queue — page.tsx says so
--      deliberately ("Any family member can see the queue") and the module
--      subscribes to realtime over the same rows for every member;
--   2. a child CANNOT insert a call request, queued or draft;
--   3. a child CANNOT rewrite the callee number, the goal or the brief on a
--      parent's request — the row `requeueCallAction` re-queues by id;
--   4. a child CANNOT move a request to 'queued', the status the place route
--      picks up, nor to 'completed' with an outcome of their choosing;
--   5. a child CANNOT delete a parent's request (no server action deletes at
--      all — cancelCallAction moves it to 'cancelled' so the record survives);
--   6. POSITIVE CONTROL — a manager can still do all four server actions:
--      request, re-queue, log an outcome, cancel; and can delete;
--   7. POSITIVE CONTROL — a manager cannot move a row into a family they do
--      not manage (the WITH CHECK half of the update guard);
--   8. POSITIVE CONTROL — the CRON still works. app/api/concierge-calls/place/
--      route.ts writes with `createServiceClient()`, i.e. as `service_role`,
--      which carries BYPASSRLS; its park write must be untouched, or the queue
--      silently stops draining;
--   9. NEGATIVE CONTROL: drop ONLY the three restrictive guards 0332 added,
--      leaving 0173's four policies exactly as they were — the pre-0332 state —
--      and require the child's escalation to SUCCEED again.
--
-- The guard is a POLICY, so a refused INSERT arrives as a raised
-- `insufficient_privilege` while a refused UPDATE/DELETE simply matches zero
-- rows. Both are checked, and `unique_violation` is caught SEPARATELY and
-- reported as a breach: RLS is evaluated before a unique index, so an insert
-- that reaches a constraint is one RLS let through.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/a-child-does-not-choose-the-number-bubaly-dials-check.sql

\set FAM  '00000000-0000-4000-8000-000000033200'
\set UP   '00000000-0000-4000-8000-000000033201'
\set UK   '00000000-0000-4000-8000-000000033202'
\set MK   '00000000-0000-4000-8000-000000033203'
\set CALL '00000000-0000-4000-8000-000000033205'
\set FAM2 '00000000-0000-4000-8000-000000033206'
\set UP2  '00000000-0000-4000-8000-000000033207'

begin;

insert into auth.users (id, email) values (:'UP','cc0332-parent@example.com')  on conflict do nothing;
insert into auth.users (id, email) values (:'UK','cc0332-kid@example.com')     on conflict do nothing;
insert into auth.users (id, email) values (:'UP2','cc0332-outsider@example.com') on conflict do nothing;

insert into public.families (id, name, created_by) values (:'FAM','Dial House',:'UP')      on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FAM2','Next Door',:'UP2')     on conflict do nothing;

-- `handle_new_family` already made the creator a parent member; only the child
-- has to be added. Its id is generated, so it is looked up rather than assumed.
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values (:'MK', :'FAM', :'UK', 'Kid', 'child', true) on conflict do nothing;
update public.family_members set role = 'parent', is_active = true
  where family_id = :'FAM' and user_id = :'UP';

-- The request a parent wrote, waiting on the family's queue.
insert into public.concierge_calls
  (id, family_id, requested_by, task_kind, callee_name, callee_phone, callee_category, goal, brief, status, created_by)
select :'CALL', :'FAM', fm.id, 'book', 'Dr Wells', '+15550000001', 'dental',
       'Book a cleaning for Saturday', '{"opening":"Hello, calling to book a cleaning"}'::jsonb,
       'draft', :'UP'
from public.family_members fm
where fm.family_id = :'FAM' and fm.user_id = :'UP' limit 1;

-- Grant explicitly, so what refuses below is RLS and not a missing privilege —
-- a probe that passes for want of a GRANT is proving the wrong thing.
grant select, insert, update, delete on public.concierge_calls to authenticated;

do $$
declare
  n          int;
  failures   text[] := '{}';
  fam        constant uuid := '00000000-0000-4000-8000-000000033200';
  fam2       constant uuid := '00000000-0000-4000-8000-000000033206';
  parent_u   constant uuid := '00000000-0000-4000-8000-000000033201';
  kid_u      constant uuid := '00000000-0000-4000-8000-000000033202';
  kid_m      constant uuid := '00000000-0000-4000-8000-000000033203';
  call_row   constant uuid := '00000000-0000-4000-8000-000000033205';
  parent_m   uuid;
  made       uuid;
  escalated  uuid;
  row_phone  text;
  row_goal   text;
  row_status text;
begin
  select id into parent_m from public.family_members
   where family_id = fam and user_id = parent_u limit 1;
  if parent_m is null then
    raise exception 'fixture broken: no parent member for the dial-house family';
  end if;

  -- ── As the child ────────────────────────────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- 1. Reads stay open, deliberately.
  select count(*) into n from public.concierge_calls where id = call_row;
  if n <> 1 then
    failures := array_append(failures, 'a child can no longer READ the family call queue — page.tsx says "Any family member can see the queue" and the module''s realtime refresh reads the same rows; that is a product change, not this repair');
  end if;

  -- 2. Requesting an outbound call, born queued, on a number they chose.
  begin
    insert into public.concierge_calls
      (family_id, requested_by, task_kind, callee_name, callee_phone, callee_category, goal, brief, status, priority)
      values (fam, kid_m, 'cancel', 'Dentist', '+15559998888', 'dental',
              'Cancel my sister''s appointment', '{"opening":"Hi"}'::jsonb, 'queued', 'urgent');
    failures := array_append(failures, 'a CHILD inserted a QUEUED outbound call request naming their own callee and number — requestCallAction is manager-only and says so in its own comment');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a child''s queued concierge_calls INSERT reached a unique index, so RLS did not refuse it');
  end;

  -- 2b. And a draft one, in case only the queued status looks dangerous.
  begin
    insert into public.concierge_calls
      (family_id, requested_by, task_kind, callee_name, callee_phone, callee_category, goal, status)
      values (fam, kid_m, 'book', 'Pizza Place', '+15557776666', 'restaurant',
              'Order forty pizzas to the house', 'draft');
    failures := array_append(failures, 'a CHILD inserted a DRAFT call request — a manager re-queues by id, so a draft is one manager click from the dialler');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a child''s draft concierge_calls INSERT reached a unique index, so RLS did not refuse it');
  end;

  -- 3. Rewriting the number, the goal and the brief on a parent's own request.
  begin
    update public.concierge_calls
       set callee_phone = '+15551112222', goal = 'Order forty pizzas',
           brief = '{"opening":"Read this instead"}'::jsonb
     where id = call_row;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, format('a CHILD rewrote the callee number, goal and brief on %s parent-authored call request(s) — requeueCallAction re-queues by id, so the row the parent clicks is no longer the row they wrote', n));
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 4. Queuing it — the status app/api/concierge-calls/place/route.ts picks up.
  begin
    update public.concierge_calls set status = 'queued' where id = call_row;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, format('a CHILD moved %s call request(s) to ''queued'' — that is the status the place route drains, and re-queueing is manager-only in requeueCallAction', n));
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 4b. And completing one with an outcome of their choosing.
  begin
    update public.concierge_calls
       set status = 'completed', outcome = 'They said it was all sorted', completed_at = now()
     where id = call_row;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, format('a CHILD marked %s call request(s) completed with an outcome they wrote — logCallOutcomeAction is a parent recording a call they made by hand', n));
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 5. Deleting a parent's request outright. No server action deletes at all.
  begin
    delete from public.concierge_calls where id = call_row;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, format('a CHILD deleted %s parent-authored call request(s) — cancelCallAction moves a row to ''cancelled'' precisely so the record survives', n));
    end if;
  exception when insufficient_privilege then null;
  end;

  -- The row must be exactly as the parent left it.
  perform set_config('role','postgres', true);
  select callee_phone, goal, status into row_phone, row_goal, row_status
    from public.concierge_calls where id = call_row;
  if row_phone is distinct from '+15550000001' or row_status is distinct from 'draft'
     or row_goal is distinct from 'Book a cleaning for Saturday' then
    failures := array_append(failures, format('the parent''s request ended as phone %L / goal %L / status %L — a child changed what Bubaly would dial and why', row_phone, row_goal, row_status));
  end if;

  -- Put the fixture back to exactly what the parent wrote, and clear anything
  -- the child managed to author. Every breach above is already recorded in
  -- `failures`; this restore is so the positive controls and the negative
  -- control below test what they claim rather than the wreckage above.
  delete from public.concierge_calls where family_id = fam and id <> call_row;
  insert into public.concierge_calls
    (id, family_id, requested_by, task_kind, callee_name, callee_phone, callee_category, goal, brief, status, created_by)
    values (call_row, fam, parent_m, 'book', 'Dr Wells', '+15550000001', 'dental',
            'Book a cleaning for Saturday', '{"opening":"Hello, calling to book a cleaning"}'::jsonb,
            'draft', parent_u)
  on conflict (id) do update
    set family_id = excluded.family_id, callee_phone = excluded.callee_phone,
        goal = excluded.goal, brief = excluded.brief, status = excluded.status,
        outcome = null, completed_at = null;

  -- ── As the manager: one positive control per server action ──────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', parent_u::text, true);

  -- requestCallAction
  begin
    insert into public.concierge_calls
      (family_id, requested_by, task_kind, callee_name, callee_phone, callee_category, goal, brief, status, priority, created_by)
      values (fam, parent_m, 'reschedule', 'Barber', '+15554443333', 'service',
              'Move the haircut to Friday', '{"opening":"Hello"}'::jsonb, 'queued', 'normal', parent_u)
      returning id into made;
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MANAGER could not request a call — requestCallAction is broken and the feature is gone');
  end;

  -- requeueCallAction: addressed by id with no family filter, exactly as the
  -- action writes it, so this also proves RLS still carries that action's scope.
  update public.concierge_calls
     set status = 'queued', callee_phone = '+15550000009'
   where id = call_row and status in ('draft','failed','action_needed');
  get diagnostics n = row_count;
  if n <> 1 then
    failures := array_append(failures, 'a MANAGER could not re-queue a call request — requeueCallAction is broken');
  end if;

  -- logCallOutcomeAction
  update public.concierge_calls
     set status = 'completed', outcome = 'Booked for Saturday 10am', completed_at = now()
   where id = call_row and family_id = fam and status in ('draft','queued','failed','action_needed');
  get diagnostics n = row_count;
  if n <> 1 then
    failures := array_append(failures, 'a MANAGER could not log a call outcome — logCallOutcomeAction is broken, and it is the only way a row reaches ''completed'' today');
  end if;

  -- cancelCallAction
  if made is not null then
    update public.concierge_calls set status = 'cancelled'
     where id = made and status in ('draft','queued','action_needed');
    get diagnostics n = row_count;
    if n <> 1 then
      failures := array_append(failures, 'a MANAGER could not cancel a call request — cancelCallAction is broken');
    end if;

    delete from public.concierge_calls where id = made;
    get diagnostics n = row_count;
    if n <> 1 then
      failures := array_append(failures, 'a MANAGER could not delete a call request — the delete guard is stricter than the family it guards');
    end if;
  end if;

  -- 7. The WITH CHECK half: a manager may not move a row into a family they do
  --    not manage.
  begin
    update public.concierge_calls set family_id = fam2 where id = call_row;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, format('a MANAGER moved %s call request(s) into a family they do not manage — the update guard is missing its WITH CHECK half', n));
    end if;
  exception when insufficient_privilege then null;
  end;

  -- ── 8. The cron: service_role, which must be untouched ──────────────────
  perform set_config('role','postgres', true);
  update public.concierge_calls
     set status = 'queued', outcome = null, completed_at = null where id = call_row;

  perform set_config('role','service_role', true);
  perform set_config('request.jwt.claim.role','service_role', true);
  update public.concierge_calls
     set status = 'action_needed',
         outcome = 'No phone provider is connected, so a person places this one.'
   where id = call_row and status = 'queued';
  get diagnostics n = row_count;
  if n <> 1 then
    failures := array_append(failures, 'the CRON could not park a due queued call — app/api/concierge-calls/place/route.ts writes as service_role and the queue has silently stopped draining');
  end if;

  -- ── 9. Negative control: prove this probe can SEE the defect ────────────
  -- Drop ONLY the three guards 0332 added. 0173's concierge_calls_select /
  -- _insert / _update / _delete are left exactly as they were, which is
  -- precisely the pre-0332 state. The outer rollback undoes this too.
  perform set_config('role','postgres', true);
  perform set_config('request.jwt.claim.role','authenticated', true);
  update public.concierge_calls
     set callee_phone = '+15550000001', goal = 'Book a cleaning for Saturday',
         brief = '{"opening":"Hello, calling to book a cleaning"}'::jsonb,
         status = 'draft', outcome = null, completed_at = null
   where id = call_row;

  drop policy if exists concierge_calls_manager_insert_guard on public.concierge_calls;
  drop policy if exists concierge_calls_manager_update_guard on public.concierge_calls;
  drop policy if exists concierge_calls_manager_delete_guard on public.concierge_calls;

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);

  begin
    insert into public.concierge_calls
      (family_id, requested_by, task_kind, callee_name, callee_phone, callee_category, goal, status, priority)
      values (fam, kid_m, 'cancel', 'Dentist', '+15559998888', 'dental',
              'Cancel my sister''s appointment', 'queued', 'urgent')
      returning id into escalated;
  exception when insufficient_privilege then escalated := null;
  end;
  if escalated is null then
    failures := array_append(failures, 'with 0173''s four policies alone a child STILL could not request an outbound call — this probe is decoration, not a boundary');
  end if;

  update public.concierge_calls
     set callee_phone = '+15551112222', goal = 'Order forty pizzas', status = 'queued'
   where id = call_row;
  get diagnostics n = row_count;
  if n = 0 then
    failures := array_append(failures, 'with the restrictive guards removed a child STILL could not rewrite and queue a parent''s call request — this probe has never been shown to fail');
  end if;

  perform set_config('role','postgres', true);
  select callee_phone, status into row_phone, row_status
    from public.concierge_calls where id = call_row;
  if row_phone is distinct from '+15551112222' or row_status is distinct from 'queued' then
    failures := array_append(failures, format('with the guards removed the parent''s request did not end up dialling %L at status %L (got %L / %L) — the negative control proved nothing', '+15551112222', 'queued', row_phone, row_status));
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a child still chooses the number Bubaly dials:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-child-does-not-choose-the-number-bubaly-dials: OK (a child reads the queue but cannot author, rewrite, queue, complete or delete a call request; a manager can request, re-queue, log an outcome, cancel and delete; the service_role cron still parks due calls; negative control reproduced the child''s escalation)';
end $$;

rollback;
