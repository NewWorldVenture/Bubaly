-- Push delivery receipts are the dispatcher's alone. (PUSH-003, migration 0339)
--
-- `notification_push_receipts` records who each push notification reached, so
-- a retry of a partly failed fan-out skips them. A client that could write a
-- receipt could silence a notification for someone (a forged "already
-- delivered"); one that could read them would learn when a family member's
-- phone received what. Neither is ever needed: the dispatcher runs with the
-- service role.
--
--   a signed-in member reads receipts                 -> REFUSED
--   a signed-in member writes a receipt               -> REFUSED
--   the service role records a delivery               -> allowed (control)
--   the same delivery recorded twice                  -> one row (key)
--   deleting the notification removes its receipts    -> cascaded
--
-- Rolled back: nothing here should outlive the assertion.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

do $probe$
declare
  member  uuid := '00000000-0000-4000-8000-00000000f601';
  fam     uuid := '00000000-0000-4000-8000-00000000f611';
  notice  uuid := '00000000-0000-4000-8000-00000000f621';
  n       int;
  failures int := 0;
begin
  insert into auth.users (id, email) values (member, 'receipt-member@example.test') on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Receipts', member) on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, member, 'Member', 'parent', true)
  on conflict (family_id, user_id) do update set is_active = true;
  insert into public.notifications (id, family_id, user_id, title, body, type)
  values (notice, fam, member, 'Probe notice', '', 'system')
  on conflict (id) do nothing;

  -- ── CONTROL: the service role records a delivery, once ──────────────────
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
  begin
    insert into public.notification_push_receipts (notification_id, user_id) values (notice, member);
    insert into public.notification_push_receipts (notification_id, user_id) values (notice, member)
      on conflict (notification_id, user_id) do nothing;
    select count(*) into n from public.notification_push_receipts where notification_id = notice;
  exception when others then
    reset role;
    raise exception 'CONTROL FAILED: the service role could not record a delivery: %', sqlerrm;
  end;
  reset role;
  if n <> 1 then raise exception 'CONTROL FAILED: expected one receipt, found %', n; end if;

  -- ── 1-2. a signed-in member neither reads nor writes receipts ───────────
  perform set_config('request.jwt.claims', json_build_object('sub', member::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    select count(*) into n from public.notification_push_receipts;
    if n > 0 then raise warning 'BREACH: a member can read push receipts (% rows)', n; failures := failures + 1; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.notification_push_receipts where notification_id = notice;
    get diagnostics n = row_count;
    if n > 0 then raise warning 'BREACH: a member deleted a push receipt'; failures := failures + 1; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.notification_push_receipts (notification_id, user_id)
    values (notice, '00000000-0000-4000-8000-00000000f699');
    raise warning 'BREACH: a member forged a push receipt';
    failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- ── 3. receipts go with their notification ─────────────────────────────
  delete from public.notifications where id = notice;
  select count(*) into n from public.notification_push_receipts where notification_id = notice;
  if n <> 0 then
    raise warning 'BREACH: % receipt(s) outlived their notification', n;
    failures := failures + 1;
  end if;

  if failures > 0 then
    raise exception 'push-receipts: % assertion(s) failed', failures;
  end if;
  raise notice 'OK: push receipts are service-only, keyed once per recipient, and deleted with their notification.';
end
$probe$;

rollback;
