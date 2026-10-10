-- HELD 0493 acceptance: private automation copies retain requester/manager reads.
-- This probe is excluded from normal docs/audit/*-check.sql replay. Apply the
-- actual supabase/reserved/0493_ai_copy_private_read_and_quota.sql candidate to
-- a disposable full-schema database first; a missing guard is an error, never
-- an inferred privacy pass. No candidate DDL is applied by this probe.
-- Original disclosure control removes only the read guard and then restores
-- the exact captured predicate. All writes and policy changes roll back.
-- Runnable 0329/0255/0390 write/gate controls remain in
-- docs/audit/automation-runs-pin-what-a-member-may-queue-check.sql.
\set ON_ERROR_STOP on

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
-- sibling's unrelated child must not read it after the held 0493 privacy repair.
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
  n int;
  failures text[] := '{}';
  fam constant uuid := '00000000-0000-4000-8000-000000032900';
  parent_u constant uuid := '00000000-0000-4000-8000-000000032901';
  kid_u constant uuid := '00000000-0000-4000-8000-000000032902';
  run_row constant uuid := '00000000-0000-4000-8000-000000032907';
  private_read_guard text;
begin
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claim.sub',kid_u::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  -- 5. held 0493 protects private copies while preserving the requester's own run.
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
    raise exception 'held 0493 private run read guard is missing; privacy control cannot run';
  end if;
  drop policy family_automation_runs_private_read_guard on public.family_automation_runs;
  perform set_config('role','authenticated', true);
  select count(*) into n from public.family_automation_runs where id = run_row;
  if n <> 1 then
    failures := array_append(failures, 'without held 0493''s read guard the sibling disclosure does not reproduce');
  end if;
  perform set_config('role','postgres', true);
  execute format('create policy family_automation_runs_private_read_guard on public.family_automation_runs as restrictive for select to authenticated using (%s)', private_read_guard);
  perform set_config('role','authenticated', true);
  select count(*) into n from public.family_automation_runs where id = run_row;
  if n <> 0 then
    failures := array_append(failures, 'the restored held 0493 read guard no longer refuses the sibling summary');
  end if;
  select count(*) into n from public.family_automation_runs
    where id = '00000000-0000-4000-8000-000000032908';
  if n <> 1 then
    failures := array_append(failures, 'the restored held 0493 read guard no longer permits the child''s own run');
  end if;

  -- ── As the parent: the positive controls ────────────────────────────────
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  select count(*) into n from public.family_automation_runs
    where id in (run_row, '00000000-0000-4000-8000-000000032908');
  if n <> 2 then
    failures := array_append(failures, 'the manager cannot read both genuine server-written runs for review');
  end if;

  perform set_config('role','postgres',true);
  if array_length(failures,1) is not null then
    raise exception E'held 0493 private automation copy acceptance failed:\n  - %',array_to_string(failures,E'\n  - ');
  end if;
  raise notice 'automation-runs-private-copy-read: OK (held 0493 requester and manager reads, sibling summary denial, original disclosure after removing only the read guard, and exact predicate restoration)';
end $$;
rollback;
