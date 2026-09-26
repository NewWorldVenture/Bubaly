-- Can a family member steer the sync engine against a parent's Google Calendar?
--
-- The engine (service role, the account owner's OAuth token) deletes the
-- provider event behind any deleted internal event that has a mapping, patches
-- it for a changed one, inserts for an unmapped one, and serves any
-- feed_enabled calendar publicly by feed_token. 0329: engine tables are
-- member-read-only; mappings are writable only for an account the caller owns.
--
-- As the CHILD: inserting a deleted internal event on the parent's calendar,
-- mapping a local id onto the parent's Google event, repointing an existing
-- mapping, switching on a public feed with a chosen token, deleting a synced
-- event, and inserting a reminder must all be refused. Controls: the child
-- still reads the calendar; the PARENT (account owner) can write a mapping for
-- their own account and update one the engine created.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000edc1';
  uPar uuid := '00000000-0000-4000-8000-00000000edca';
  uKid uuid := '00000000-0000-4000-8000-00000000edcb';
  acct uuid; cal uuid; ev uuid; lst uuid; engineMap uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  delete from public.sync_accounts where user_id in (uPar, uKid);
  insert into auth.users (id, email) values
    (uPar, 'sync-parent@example.com'), (uKid, 'sync-kid@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Sync family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uKid, 'Kid', 'child', true);
  insert into public.sync_accounts (user_id, family_id, provider, external_id)
    values (uPar, fam, 'google', 'parent@example.com') returning id into acct;
  insert into public.sync_calendars (family_id, account_id, user_id, provider, external_id, name, feed_enabled)
    values (fam, acct, uPar, 'google', 'primary', 'Parent', false) returning id into cal;
  insert into public.sync_calendar_events (calendar_id, family_id, user_id, provider, external_id, title, starts_at)
    values (cal, fam, uPar, 'google', 'evt-parent-1', 'Surgery consult', now() + interval '2 days') returning id into ev;
  insert into public.sync_external_mappings (family_id, account_id, provider, item_type, local_id, external_id)
    values (fam, acct, 'google', 'event', ev, 'evt-parent-1') returning id into engineMap;
  insert into public.sync_reminder_lists (family_id, account_id, user_id, provider, name)
    values (fam, acct, uPar, 'google', 'Parent tasks') returning id into lst;

  -- ── as the CHILD ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uKid::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uKid, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.sync_calendar_events where calendar_id = cal;
  if n <> 1 then raise warning 'CONTROL FAILED: the child cannot read the family calendar (%)', n; failures := failures + 1; end if;

  begin
    insert into public.sync_calendar_events (calendar_id, family_id, provider, title, starts_at, deleted_at)
      values (cal, fam, 'internal', 'x', now(), now());
    raise warning 'BREACH: a child queued an internal event on the parent''s calendar'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.sync_external_mappings (family_id, account_id, provider, item_type, local_id, external_id)
      values (fam, acct, 'google', 'event', gen_random_uuid(), 'evt-parent-2');
    raise warning 'BREACH: a child mapped a local id onto the parent''s Google event'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;

  update public.sync_external_mappings set external_id = 'evt-parent-3' where id = engineMap;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child repointed a mapping on the parent''s account (rows: %)', n; failures := failures + 1; end if;

  update public.sync_calendars set feed_enabled = true, feed_token = 'chosen-by-the-child' where id = cal;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child published the parent''s calendar as a public feed (rows: %)', n; failures := failures + 1; end if;

  update public.sync_calendar_events set deleted_at = now() where id = ev;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child marked the parent''s synced event deleted (rows: %)', n; failures := failures + 1; end if;

  begin
    insert into public.sync_reminders (list_id, family_id, provider, title) values (lst, fam, 'internal', 'x');
    raise warning 'BREACH: a child queued a task onto the parent''s list'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- ── as the PARENT, the account owner (controls) ──────────────────────────
  perform set_config('request.jwt.claim.sub', uPar::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uPar, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.sync_external_mappings (family_id, user_id, account_id, provider, item_type, local_id, external_id, sync_direction)
    values (fam, uPar, acct, 'google', 'event', gen_random_uuid(), 'evt-import-1', 'import');
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: the owner could not write their own mapping (rows: %)', n; failures := failures + 1; end if;
  update public.sync_external_mappings set last_synced_at = now() where id = engineMap;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: the owner could not update an engine mapping on their account (rows: %)', n; failures := failures + 1; end if;
  begin
    insert into public.sync_external_mappings (family_id, user_id, account_id, provider, item_type, local_id, external_id)
      values (fam, uKid, acct, 'google', 'event', gen_random_uuid(), 'evt-import-2');
    raise warning 'BREACH: a mapping was written in another user''s name'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  reset role;

  delete from public.families where id = fam;
  delete from public.sync_accounts where user_id in (uPar, uKid);
  delete from auth.users where id in (uPar, uKid);

  if failures > 0 then
    raise exception 'sync-engine-write-check: % failure(s)', failures;
  end if;
end
$probe$;
