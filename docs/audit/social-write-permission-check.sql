-- Does RLS enforce the social permission matrix on writes? (0330)
--
-- CHILD (default social role read_only): disconnecting the family's social
-- account, switching off require_approval, rewriting a post, deleting a post,
-- and erasing usage records must all be refused. TEEN (content_creator):
-- may create a draft (control) but may not change settings or move a post
-- toward publishing (update needs publish/schedule). PARENT (admin): changes
-- settings and updates the post (controls). Everyone still reads.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000edd1';
  uPar uuid := '00000000-0000-4000-8000-00000000edda';
  uKid uuid := '00000000-0000-4000-8000-00000000eddb';
  uTeen uuid := '00000000-0000-4000-8000-00000000eddc';
  acct uuid; post uuid; usageRow uuid;
  n int; failures int := 0;
begin
  delete from public.social_usage_events where family_id = fam;
  delete from public.social_posts where family_id = fam;
  delete from public.social_settings where family_id = fam;
  delete from public.social_accounts where family_id = fam;
  delete from public.social_audit_logs where family_id = fam;
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'social-parent@example.com'), (uKid, 'social-kid@example.com'), (uTeen, 'social-teen@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Social family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, uKid, 'Kid', 'child', true), (fam, uTeen, 'Teen', 'teen', true);
  insert into public.social_accounts (family_id, user_id, platform, handle, status)
    values (fam, uPar, 'x', '@familybiz', 'connected') returning id into acct;
  insert into public.social_settings (family_id, require_approval) values (fam, true);
  insert into public.social_posts (family_id, user_id, body) values (fam, uPar, 'Approved copy') returning id into post;
  insert into public.social_usage_events (family_id, user_id, kind, quantity) values (fam, uPar, 'ai_generation', 1) returning id into usageRow;

  -- ── as the CHILD (read_only) ─────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uKid::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uKid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.social_posts where id = post;
  if n <> 1 then raise warning 'CONTROL FAILED: the child cannot read the post (%)', n; failures := failures + 1; end if;
  delete from public.social_accounts where id = acct;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a read_only member disconnected the social account (rows: %)', n; failures := failures + 1; end if;
  update public.social_settings set require_approval = false where family_id = fam;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a read_only member switched off post approval (rows: %)', n; failures := failures + 1; end if;
  update public.social_posts set body = 'Rewritten' where id = post;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a read_only member rewrote a post (rows: %)', n; failures := failures + 1; end if;
  delete from public.social_posts where id = post;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a read_only member deleted a post (rows: %)', n; failures := failures + 1; end if;
  begin
    insert into public.social_posts (family_id, user_id, body) values (fam, uKid, 'x');
    raise warning 'BREACH: a read_only member created a post'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  delete from public.social_usage_events where id = usageRow;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a member erased a usage record (rows: %)', n; failures := failures + 1; end if;
  reset role;

  -- ── as the TEEN (content_creator) ────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uTeen::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uTeen, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.social_posts (family_id, user_id, body) values (fam, uTeen, 'Draft idea');
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a content creator could not draft (rows: %)', n; failures := failures + 1; end if;
  update public.social_settings set require_approval = false where family_id = fam;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a content creator switched off post approval (rows: %)', n; failures := failures + 1; end if;
  update public.social_posts set body = 'Swapped after approval' where id = post;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a content creator rewrote an existing post (rows: %)', n; failures := failures + 1; end if;
  reset role;

  -- ── as the PARENT (admin) ────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uPar::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uPar, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.social_settings set signature = '— the family' where family_id = fam;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: an admin could not change settings (rows: %)', n; failures := failures + 1; end if;
  update public.social_posts set status = 'publishing' where id = post;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: an admin could not move a post to publishing (rows: %)', n; failures := failures + 1; end if;
  reset role;

  -- Social deletes write social_audit_logs rows, so clear the family's social
  -- rows (and those logs) while the family still exists.
  delete from public.social_usage_events where family_id = fam;
  delete from public.social_posts where family_id = fam;
  delete from public.social_settings where family_id = fam;
  delete from public.social_accounts where family_id = fam;
  delete from public.social_audit_logs where family_id = fam;
  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uKid, uTeen);

  if failures > 0 then
    raise exception 'social-write-permission-check: % failure(s)', failures;
  end if;
end
$probe$;
