-- ── A run in the approval queue is authored by a manager or by the server (0329)
--
-- AUTHZ-012. `family_automation_runs` has TWO status columns. `0250` added the
-- §10 `state` column with a CHECK; `0252` and `0255` pinned THAT one for member
-- INSERTs (`created_by = auth.uid()`, `state = 'queued'`, seven runtime columns
-- forced NULL). The ORIGINAL column from `0022_family_os.sql` (~line 135) —
--
--   status text NOT NULL DEFAULT 'pending'    -- no CHECK, to this day
--
-- — was never pinned, and neither were `trigger_type`, `metadata`, `summary` or
-- `approved_by`/`approved_at`. `0251`'s own header says the table was split
-- because "any member could set status='executed' on a run they never
-- approved": the split covered the VERB (UPDATE/DELETE became
-- `can_manage_family`) and left the COLUMN reachable on INSERT.
--
-- The chain this probe reproduces end to end:
--
--   1. a child INSERTs a run that satisfies 0255 on `state`, with
--      `status = 'pending'`, `trigger_type = 'plan_accepted'`, a `summary` of
--      their own writing, and `metadata` naming a plan and an approval;
--   2. `components/concierge/autopilot-panel.tsx` filters on exactly
--      `trigger_type = 'plan_accepted'` + `status === 'pending'` and renders
--      `r.summary` as the line beside the "Do it" button;
--   3. the parent taps it. `executeQueuedRunAction`
--      (app/(app)/dashboard/concierge/actions.ts ~L185) reads `meta.plan_id`
--      and `meta.approval_id` FROM THAT ROW'S OWN METADATA and decides the named
--      `approval_requests` row `status='approved'`, `decided_by = <the parent's
--      member id>`, `decided_at`, `executed_at` (since 0381 through `decide()`,
--      which also appends the parent's own vote). That write is manager-only
--      (`approval_requests_decide`, 0251 ~L128) and succeeds only because it is
--      running in the parent's session. `dismissQueuedRunAction` (~L238) is the
--      mirror and stamps 'rejected'.
--
-- Sized honestly: decision-record forgery and queue suppression, NOT remote
-- execution — `lib/services/approvals.decide()` is what turns an approval into
-- work and is not on this path.
--
-- 0329 closes it with a RESTRICTIVE manager guard on INSERT rather than another
-- column pin, because `status`'s own DEFAULT is a queue value: a member INSERT
-- that names no status at all still lands in the parent's "Pending approvals"
-- list (/dashboard/family-automation, /dashboard/autonomous-family-management,
-- both `.eq('status','pending')`). There is no inert shape to permit without
-- inventing a value for a CHECK-less column that six readers branch on. And no
-- application path inserts here on a member's client at all: `planAcceptedAction`
-- (L153, L166) uses `createServiceClient()`, and `lib/ai/runs/store.ts`
-- `createRun` writes through `ledgerClient()`, which returns the service client
-- for every non-system scope.
--
-- Asserts, in both directions:
--
--   1. a child cannot file the forged queue row — with metadata, with the
--      column DEFAULT relied on instead of a literal, as `status='executed'`
--      (which `lib/metric/completed-plans.ts` counts as a handled plan), or
--      born stamped `approved_by = <the parent>`;
--   2. since 0478, a child reads their own server-written run but not a
--      sibling's private summary. A manager still reads the review queue.
--      Removing only 0478's read guard reproduces the sibling disclosure;
--   3. a MANAGER can still insert the two rows `tests/e2e/authenticated.spec.ts`
--      requires to be allowed (`status='pending'` and `status='executed'`, with
--      `trigger_type='plan_accepted'`), and 0255's own pins still refuse a
--      manager a planned or runtime-linked row. A guard that refuses everyone is
--      not a boundary;
--   4. the SERVICE ROLE — the client `planAcceptedAction` actually uses — still
--      files the queued approval row, with `requested_by_member_id` and
--      `state='awaiting_approval'`, which no member policy would permit;
--   5. the approve path still works: a manager still UPDATEs the run and stamps
--      the approval (0251's policies, untouched);
--   6. `anon` holds no INSERT — the 0329 guard is `TO authenticated` and a
--      restrictive policy only ANDs with requests made AS a role it names, so
--      for an anonymous request it is absent and the grant layer is all that is
--      left (0290's argument, restated by 0322);
--   7. NEGATIVE CONTROL: drop ONLY `family_automation_runs_manager_insert_guard`,
--      leaving 0255's permissive `family_automation_runs_insert` exactly as it
--      was — the pre-0329 state — and require the WHOLE chain to reproduce: the
--      child's plant succeeds, and the parent's own click then marks the
--      sibling's spend request approved in the parent's name.
--   8b. (0390) a MANAGER cannot drop `approval_id` from a server-written run's
--      metadata, point it at another approval, or point `plan_id` at another
--      plan — while an unrelated metadata key still lands, so the pin is a pin
--      and not a lock on the column;
--   8c. NEGATIVE CONTROL for 0390: drop ONLY `family_automation_runs_gate_is_pinned`
--      and require the manager's scrub of `approval_id` to land.
--
-- RLS is evaluated BEFORE a unique index, so an insert that reaches a constraint
-- violation is one RLS LET THROUGH; those are caught separately and reported as
-- breaches rather than swallowed.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/automation-runs-pin-what-a-member-may-queue-check.sql

\set FR '00000000-0000-4000-8000-000000032900'
\set UP '00000000-0000-4000-8000-000000032901'
\set UK '00000000-0000-4000-8000-000000032902'
\set MK '00000000-0000-4000-8000-000000032903'
\set MS '00000000-0000-4000-8000-000000032904'
\set AP '00000000-0000-4000-8000-000000032905'
\set PL '00000000-0000-4000-8000-000000032906'
\set RN '00000000-0000-4000-8000-000000032907'

begin;

insert into auth.users (id, email) values (:'UP','runs-parent@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UK','runs-kid@example.com')    on conflict do nothing;

insert into public.families (id, name, created_by) values (:'FR','Run Queue House',:'UP') on conflict do nothing;

-- The child holding the session, and a sibling whose spend request is the thing
-- the forged row gets marked decided.
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values (:'MK',:'FR',:'UK','Kid','child',true) on conflict do nothing;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values (:'MS',:'FR',null,'Sibling','child',true) on conflict do nothing;
-- The creator is provisioned as a manager by on_family_created; make sure of it
-- rather than assuming, because a fixture whose roles are wrong proves nothing.
update public.family_members set role = 'parent' where family_id = :'FR' and user_id = :'UP';

-- The sibling's request, sitting in the parent's inbox undecided.
insert into public.approval_requests
  (id, family_id, domain, capability, requested_by_kind, requested_by_member_id, title, summary, status)
values (:'AP', :'FR', 'money', 'spend', 'member', :'MS',
        'Sibling asks for £40 for a school trip', 'Filed by the sibling, waiting on a parent', 'pending');

-- A plan for the forged run to name: concierge_plans is role-blind (0091 ~L65),
-- so the child chooses what the materialised records would say too.
insert into public.concierge_plans (id, family_id, created_by, title, status)
values (:'PL', :'FR', :'UK', 'Whatever the child wants booked', 'booked');

-- The genuine article, written the way planAcceptedAction writes it — with the
-- SERVICE client, so the fixture is the row the autopilot panel is FOR. The
-- sibling's unrelated child must not read it after the 0478 privacy repair.
insert into public.family_automation_runs
  (id, family_id, created_by, trigger_type, status, state, requested_by_member_id, summary, metadata)
values (:'RN', :'FR', :'UP', 'plan_accepted', 'pending', 'awaiting_approval', :'MS',
        'Waiting for approval: book the school trip',
        jsonb_build_object('plan_id', :'PL'::uuid, 'approval_id', :'AP'::uuid));

-- Positive read control: a genuine server-written run for the signed-in child.
-- No linked AI request/plan is present, matching the supported legacy shape.
insert into public.family_automation_runs
  (id, family_id, created_by, trigger_type, status, state, requested_by_member_id, summary)
values ('00000000-0000-4000-8000-000000032908', :'FR', :'UK', 'plan_accepted',
        'pending', 'awaiting_approval', :'MK', 'Synthetic child-owned run');

grant select, insert, update, delete on public.family_automation_runs to authenticated;
grant select, insert, update, delete on public.approval_requests       to authenticated;

do $$
declare
  n            int;
  planted      uuid;
  row_status   text;
  row_decider  uuid;
  failures     text[] := '{}';
  fam       constant uuid := '00000000-0000-4000-8000-000000032900';
  parent_u  constant uuid := '00000000-0000-4000-8000-000000032901';
  kid_u     constant uuid := '00000000-0000-4000-8000-000000032902';
  sibling_m constant uuid := '00000000-0000-4000-8000-000000032904';
  approval  constant uuid := '00000000-0000-4000-8000-000000032905';
  plan      constant uuid := '00000000-0000-4000-8000-000000032906';
  run_row   constant uuid := '00000000-0000-4000-8000-000000032907';
  parent_m  uuid;
  private_read_guard text;
  forged    constant jsonb := jsonb_build_object(
    'plan_id',     '00000000-0000-4000-8000-000000032906',
    'approval_id', '00000000-0000-4000-8000-000000032905',
    'kinds',       jsonb_build_array('calendar'));
begin
  select id into parent_m from public.family_members where family_id = fam and user_id = parent_u limit 1;
  if parent_m is null then
    raise exception 'fixture is wrong: the parent has no family_members row';
  end if;

  -- ── As the child ────────────────────────────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- 1. The forged queue row, exactly as the autopilot panel reads it.
  begin
    insert into public.family_automation_runs
      (family_id, created_by, state, status, trigger_type, summary, metadata)
    values (fam, kid_u, 'queued', 'pending', 'plan_accepted',
            'Waiting for approval: book the school trip', forged);
    failures := array_append(failures,
      'a child FILED a plan_accepted/pending run carrying their own summary and an approval_id — the autopilot panel renders it beside the parent''s "Do it" button');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures,
        'a child''s forged run INSERT reached a unique index, so RLS did not refuse it');
  end;

  -- 2. The same thing relying on the column DEFAULT instead of a literal —
  --    `status text NOT NULL DEFAULT 'pending'` is why a pin on the value alone
  --    would not have been a boundary.
  begin
    insert into public.family_automation_runs
      (family_id, created_by, state, trigger_type, summary, metadata)
    values (fam, kid_u, 'queued', 'plan_accepted', 'Queued by the default', forged);
    failures := array_append(failures,
      'a child filed a run that reached the parent''s queue through the DEFAULT ''pending'' without naming a status at all');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a child''s defaulted run INSERT reached a unique index, so RLS did not refuse it');
  end;

  -- 3. A fabricated "Bubaly did this" record. lib/metric/completed-plans.ts
  --    counts `status = 'executed'` beside `state = 'queued'` as a recorded
  --    completed plan, so this also inflates "N things handled for you".
  begin
    insert into public.family_automation_runs
      (family_id, created_by, state, status, trigger_type, summary)
    values (fam, kid_u, 'queued', 'executed', 'plan_accepted', 'Bubaly sorted the school trip');
    failures := array_append(failures,
      'a child filed an EXECUTED run — the "Done for you" feed and the handled-this-week count are both fiction');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a child''s executed-run INSERT reached a unique index, so RLS did not refuse it');
  end;

  -- 4. A row born carrying a parent's approval stamp.
  begin
    insert into public.family_automation_runs
      (family_id, created_by, state, status, trigger_type, summary, approved_by, approved_at)
    values (fam, kid_u, 'queued', 'approved', 'plan_accepted', 'Approved by Mum', parent_u, now());
    failures := array_append(failures,
      'a child filed a run BORN stamped approved_by = the parent — a forgery that needs no click at all');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a child''s pre-approved run INSERT reached a unique index, so RLS did not refuse it');
  end;

  -- 5. 0478 protects private copies while preserving the requester's own run.
  select count(*) into n from public.family_automation_runs where id = run_row;
  if n <> 0 then
    failures := array_append(failures, 'an unrelated child reads the sibling''s private server-written run');
  end if;
  select count(*) into n from public.family_automation_runs
    where id = '00000000-0000-4000-8000-000000032908';
  if n <> 1 then
    failures := array_append(failures, 'the active child cannot read their own server-written run');
  end if;

  -- Prove that the read test detects the original disclosure. Restore exactly
  -- the captured predicate before continuing the independent write controls.
  perform set_config('role','postgres', true);
  select pg_get_expr(polqual, polrelid) into private_read_guard from pg_policy
    where polrelid = 'public.family_automation_runs'::regclass
      and polname = 'family_automation_runs_private_read_guard'
      and polcmd = 'r' and not polpermissive;
  if private_read_guard is null then
    raise exception '0478 private run read guard is missing; privacy control cannot run';
  end if;
  drop policy family_automation_runs_private_read_guard on public.family_automation_runs;
  perform set_config('role','authenticated', true);
  select count(*) into n from public.family_automation_runs where id = run_row;
  if n <> 1 then
    failures := array_append(failures, 'without 0478''s read guard the sibling disclosure does not reproduce');
  end if;
  perform set_config('role','postgres', true);
  execute format('create policy family_automation_runs_private_read_guard on public.family_automation_runs as restrictive for select to authenticated using (%s)', private_read_guard);
  perform set_config('role','authenticated', true);
  select count(*) into n from public.family_automation_runs where id = run_row;
  if n <> 0 then
    failures := array_append(failures, 'the restored 0478 read guard no longer refuses the sibling summary');
  end if;
  select count(*) into n from public.family_automation_runs
    where id = '00000000-0000-4000-8000-000000032908';
  if n <> 1 then
    failures := array_append(failures, 'the restored 0478 read guard no longer permits the child''s own run');
  end if;

  -- ── As the parent: the positive controls ────────────────────────────────
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  select count(*) into n from public.family_automation_runs
    where id in (run_row, '00000000-0000-4000-8000-000000032908');
  if n <> 2 then
    failures := array_append(failures, 'the manager cannot read both genuine server-written runs for review');
  end if;

  -- 6. The two rows tests/e2e/authenticated.spec.ts asserts a member may still
  --    insert. That member is the family's creator, provisioned 'parent' by
  --    on_family_created, so they are a manager — which is why a role boundary
  --    here keeps that spec green.
  begin
    insert into public.family_automation_runs (family_id, created_by, trigger_type, summary, status)
    values (fam, parent_u, 'plan_accepted', 'Isolated permission probe', 'pending');
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MANAGER could not insert a pending plan_accepted run — tests/e2e/authenticated.spec.ts asserts this row is allowed');
  end;
  begin
    insert into public.family_automation_runs (family_id, created_by, trigger_type, summary, status)
    values (fam, parent_u, 'plan_accepted', 'Isolated permission probe', 'executed');
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MANAGER could not insert an executed plan_accepted run — tests/e2e/authenticated.spec.ts asserts this row is allowed');
  end;

  -- 7. And 0255's own pins still hold for a manager: this file narrows, it does
  --    not replace. A planned, runtime-linked or someone-else's row is still
  --    refused.
  begin
    insert into public.family_automation_runs (family_id, created_by, trigger_type, summary, state)
    values (fam, parent_u, 'plan_accepted', 'Manager jumping the executor queue', 'ready');
    failures := array_append(failures, 'a manager inserted a run at state=''ready'' — 0255''s pin on `state` has been lost');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a manager''s state=ready INSERT reached a unique index, so RLS did not refuse it');
  end;
  begin
    insert into public.family_automation_runs (family_id, created_by, trigger_type, summary, requested_by_member_id)
    values (fam, parent_u, 'plan_accepted', 'Manager naming a requester', sibling_m);
    failures := array_append(failures, 'a manager inserted a run naming requested_by_member_id — 0255''s pin has been lost');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a manager''s requested_by_member_id INSERT reached a unique index, so RLS did not refuse it');
  end;

  -- 8. The approve path a parent actually uses is untouched (0251 owns UPDATE).
  update public.family_automation_runs
     set status = 'executed', approved_by = parent_u, approved_at = now()
   where family_id = fam and status = 'pending';
  get diagnostics n = row_count;
  if n = 0 then
    failures := array_append(failures, 'a MANAGER could not mark a queued run executed — executeQueuedRunAction is broken');
  end if;
  -- Since 0381 a decision carries the decider's own vote in the same UPDATE,
  -- which is what `decide()` writes and what executeQueuedRunAction now routes
  -- through; a bare status flip is refused by approval_requests_decision_is_earned.
  update public.approval_requests
     set status = 'approved', decided_by = parent_m, decided_at = now(), executed_at = now(),
         approvals = approvals || jsonb_build_array(jsonb_build_object('member_id', parent_m, 'decision', 'approved'))
   where id = approval and family_id = fam;
  get diagnostics n = row_count;
  if n <> 1 then
    failures := array_append(failures, 'a MANAGER could not stamp an approval — 0251''s approval_requests_decide is broken');
  end if;
  -- Put the sibling's request back so the negative control starts undecided.
  -- (As postgres: 0389 freezes a decided row for RLS-subject callers only.)
  perform set_config('role','postgres', true);
  update public.approval_requests
     set status = 'pending', decided_by = null, decided_at = null, executed_at = null, approvals = '[]'::jsonb
   where id = approval;

  -- ── 8b. The gate a server-written run was born with is pinned (0390) ─────
  -- `metadata->>'approval_id'` is what the panel's line stands on, and 0251's
  -- UPDATE policy let a manager rewrite it. The action no longer trusts it
  -- (it resolves the approval from approval_requests by plan); the database
  -- now keeps the server-written cache honest.
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  begin
    update public.family_automation_runs set metadata = metadata - 'approval_id' where id = run_row;
    get diagnostics n = row_count;
    if n > 0 then failures := array_append(failures, 'a MANAGER dropped approval_id from a queued run''s metadata — the "Do it" line no longer names the vote it waits on'); end if;
  exception when insufficient_privilege then null;
  end;
  begin
    update public.family_automation_runs
       set metadata = jsonb_set(metadata, '{approval_id}', to_jsonb(gen_random_uuid()::text))
     where id = run_row;
    get diagnostics n = row_count;
    if n > 0 then failures := array_append(failures, 'a MANAGER pointed a queued run at a different approval'); end if;
  exception when insufficient_privilege then null;
  end;
  begin
    update public.family_automation_runs
       set metadata = jsonb_set(metadata, '{plan_id}', to_jsonb(gen_random_uuid()::text))
     where id = run_row;
    get diagnostics n = row_count;
    if n > 0 then failures := array_append(failures, 'a MANAGER pointed a queued run at a different plan'); end if;
  exception when insufficient_privilege then null;
  end;
  -- Control: a key the pin does not name still lands.
  begin
    update public.family_automation_runs
       set metadata = metadata || '{"probe_note":"still writable"}'::jsonb
     where id = run_row;
    get diagnostics n = row_count;
    if n <> 1 then failures := array_append(failures, format('a MANAGER could not add an unrelated key to a queued run''s metadata (%s rows) — 0390 pins more than it says', n)); end if;
  exception when others then
    failures := array_append(failures, format('a MANAGER''s unrelated metadata write was refused: %s %s', sqlstate, sqlerrm));
  end;
  perform set_config('role','postgres', true);
  if (select metadata ->> 'approval_id' from public.family_automation_runs where id = run_row) is distinct from approval::text
     or (select metadata ->> 'plan_id' from public.family_automation_runs where id = run_row) is distinct from plan::text then
    failures := array_append(failures, 'the queued run''s approval_id or plan_id changed under the manager''s writes — 0390 is not holding');
  end if;

  -- ── As the server: the client planAcceptedAction actually holds ─────────
  -- 9. `createServiceClient()` bypasses RLS entirely, which is why the product
  --    still queues a plan a CHILD accepted. A guard that broke this would have
  --    broken autopilot for every household.
  perform set_config('role','service_role', true);
  begin
    insert into public.family_automation_runs
      (family_id, created_by, trigger_type, status, state, requested_by_member_id, summary, metadata)
    values (fam, kid_u, 'plan_accepted', 'pending', 'awaiting_approval',
            '00000000-0000-4000-8000-000000032903',
            'Waiting for approval: the plan the child accepted',
            jsonb_build_object('plan_id', plan, 'approval_id', approval));
  exception when insufficient_privilege then
    failures := array_append(failures, 'the SERVICE ROLE could not file the queued run — planAcceptedAction is broken and autopilot no longer queues anything');
  end;
  perform set_config('role','postgres', true);

  -- 10. The grant layer the `to authenticated` guard cannot reach.
  if has_table_privilege('anon', 'public.family_automation_runs', 'INSERT') then
    failures := array_append(failures, 'anon still holds INSERT on family_automation_runs — a restrictive policy TO authenticated is absent for an anonymous request');
  end if;
  if not has_table_privilege('anon', 'public.family_automation_runs', 'SELECT') then
    failures := array_append(failures, 'anon lost SELECT on family_automation_runs — 0329 was not supposed to touch reads (0290 and 0322 left SELECT alone deliberately)');
  end if;

  -- ── 8c. Negative control for 0390: prove this probe can SEE that defect ──
  -- Drop ONLY 0390's trigger and require the manager's scrub to land, which
  -- is exactly the pre-0390 state. The outer rollback restores it.
  drop trigger if exists family_automation_runs_gate_is_pinned on public.family_automation_runs;
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  update public.family_automation_runs set metadata = metadata - 'approval_id' where id = run_row;
  get diagnostics n = row_count;
  if n <> 1 then
    failures := array_append(failures, format('with 0390''s trigger removed the manager''s scrub of approval_id touched %s row(s) — the defect did not reproduce, so 8b proves nothing', n));
  end if;
  perform set_config('role','postgres', true);
  if (select metadata ? 'approval_id' from public.family_automation_runs where id = run_row) then
    failures := array_append(failures, 'with 0390''s trigger removed approval_id is still on the row — the scrub did not reproduce');
  end if;

  -- ── Negative control: prove this probe can SEE the defect ──────────────
  -- Drop ONLY 0329's restrictive guard. 0255's permissive
  -- `family_automation_runs_insert` is left exactly as it was, which is
  -- precisely the pre-0329 state. The outer rollback undoes this too.
  drop policy if exists family_automation_runs_manager_insert_guard on public.family_automation_runs;

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);

  insert into public.family_automation_runs
    (family_id, created_by, state, status, trigger_type, summary, metadata)
  values (fam, kid_u, 'queued', 'pending', 'plan_accepted',
          'Waiting for approval: book the school trip', forged)
  returning id into planted;
  if planted is null then
    failures := array_append(failures,
      'with 0255''s policy alone the child STILL could not file the forged run — this probe is decoration, not a boundary');
  end if;

  -- The parent's own click, exactly as executeQueuedRunAction writes it (via
  -- `decide()`, which records the parent's own vote with the flip): the
  -- plan id and the approval id come from the row the CHILD wrote.
  if planted is not null then
    perform set_config('request.jwt.claim.sub', parent_u::text, true);
    update public.approval_requests
       set status = 'approved', decided_by = parent_m, decided_at = now(),
           executed_at = now(), execution_result = 'Booked the school trip',
           approvals = approvals || jsonb_build_array(jsonb_build_object('member_id', parent_m, 'decision', 'approved'))
     where id = ((select metadata ->> 'approval_id' from public.family_automation_runs where id = planted))::uuid
       and family_id = fam;
    get diagnostics n = row_count;
    if n <> 1 then
      failures := array_append(failures,
        format('with the guard removed the parent''s click stamped %s approval row(s) — the chain no longer reproduces and this probe has never been shown to fail', n));
    end if;
  end if;

  perform set_config('role','postgres', true);
  select status, decided_by into row_status, row_decider from public.approval_requests where id = approval;
  if planted is not null and (row_status <> 'approved' or row_decider is distinct from parent_m) then
    failures := array_append(failures,
      format('with the guard removed the sibling''s request ended at %L / decided_by %s — the forgery did not reproduce, so this probe proves nothing', row_status, row_decider));
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a run in the approval queue is not authored by a manager or the server:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'automation-runs-pin-what-a-member-may-queue: OK (a child cannot file a run into the parent''s queue by any of the four routes; 0478 permits their own run, refuses sibling private summaries and preserves manager review, with the old-read disclosure control reproduced; a manager and the service role still write, and the negative control reproduced the forged decision record; 0390: a manager cannot drop or redirect a queued run''s approval_id or plan_id while an unrelated metadata key still lands, and its negative control reproduced the scrub)';
end $$;

rollback;
