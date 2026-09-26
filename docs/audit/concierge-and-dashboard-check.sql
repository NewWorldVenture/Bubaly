-- Concierge calls and the family dashboard are manager writes (0331).
--
-- As the CHILD: queueing an outbound call, rewriting a queued call's number,
-- unlocking dashboard customization, overwriting the family default layout
-- and deleting a sibling's layout must be refused. Controls: the child saves
-- their own layout and reads the call; the PARENT queues a call and changes
-- the dashboard settings.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000ede1';
  uPar uuid := '00000000-0000-4000-8000-00000000edea';
  uKid uuid := '00000000-0000-4000-8000-00000000edeb';
  uSib uuid := '00000000-0000-4000-8000-00000000edec';
  callRow uuid; famLayout uuid; sibLayout uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'dash-parent@example.com'), (uKid, 'dash-kid@example.com'), (uSib, 'dash-sib@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Dashboard family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, uKid, 'Kid', 'child', true), (fam, uSib, 'Sib', 'child', true);
  insert into public.concierge_calls (family_id, callee_name, callee_phone, goal, status)
    values (fam, 'Dentist', '+15550100', 'Book a cleaning', 'queued') returning id into callRow;
  insert into public.family_dashboard_settings (family_id, allow_child_customization, lock_to_family_default)
    values (fam, false, true);
  insert into public.dashboard_layouts (family_id, user_id, scope, device_context, feature_keys)
    values (fam, null, 'family', 'all', array['calendar']) returning id into famLayout;
  insert into public.dashboard_layouts (family_id, user_id, scope, device_context, feature_keys)
    values (fam, uSib, 'user', 'all', array['chores']) returning id into sibLayout;

  -- ── as the CHILD ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uKid::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uKid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.concierge_calls where id = callRow;
  if n <> 1 then raise warning 'CONTROL FAILED: the child cannot see the call (%)', n; failures := failures + 1; end if;
  begin
    insert into public.concierge_calls (family_id, callee_name, callee_phone, goal, status)
      values (fam, 'Anyone', '+15559999', 'Say something', 'queued');
    raise warning 'BREACH: a child queued an outbound call'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  update public.concierge_calls set callee_phone = '+15559999' where id = callRow;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child redirected a queued call (rows: %)', n; failures := failures + 1; end if;
  update public.family_dashboard_settings set allow_child_customization = true, lock_to_family_default = false where family_id = fam;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child unlocked dashboard customization (rows: %)', n; failures := failures + 1; end if;
  update public.dashboard_layouts set feature_keys = array['games'] where id = famLayout;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child overwrote the family default layout (rows: %)', n; failures := failures + 1; end if;
  delete from public.dashboard_layouts where id = sibLayout;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child deleted a sibling''s layout (rows: %)', n; failures := failures + 1; end if;
  insert into public.dashboard_layouts (family_id, user_id, scope, device_context, feature_keys)
    values (fam, uKid, 'user', 'all', array['homework']);
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: the child could not save their own layout (rows: %)', n; failures := failures + 1; end if;
  reset role;

  -- ── as the PARENT (controls) ─────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uPar::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uPar, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.concierge_calls (family_id, callee_name, goal, status) values (fam, 'School', 'Confirm pickup', 'draft');
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not request a call (rows: %)', n; failures := failures + 1; end if;
  update public.family_dashboard_settings set allow_child_customization = true where family_id = fam;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not change dashboard settings (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uKid, uSib);

  if failures > 0 then
    raise exception 'concierge-and-dashboard-check: % failure(s)', failures;
  end if;
end
$probe$;
