-- A marketplace report is filed open, in the reporter's own name (0332).
--
-- As a TEEN: filing a report as a sibling, or filing one already dismissed
-- with a resolution, must be refused. Control: the teen files an open report
-- as themselves.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000edf1';
  uPar uuid := '00000000-0000-4000-8000-00000000edfa';
  uTeen uuid := '00000000-0000-4000-8000-00000000edfb';
  uSib uuid := '00000000-0000-4000-8000-00000000edfc';
  mTeen uuid; mSib uuid; listing uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'report-parent@example.com'), (uTeen, 'report-teen@example.com'), (uSib, 'report-sib@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Report family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uTeen, 'Teen', 'teen', true) returning id into mTeen;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uSib, 'Sib', 'child', true) returning id into mSib;
  insert into public.marketplace_listings (family_id, title) values (fam, 'Bike') returning id into listing;

  perform set_config('request.jwt.claim.sub', uTeen::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uTeen, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.marketplace_reports (family_id, listing_id, reporter_member, reason)
      values (fam, listing, mSib, 'scam');
    raise warning 'BREACH: a member filed a report in a sibling''s name'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.marketplace_reports (family_id, listing_id, reporter_member, reason, status, resolution)
      values (fam, listing, mTeen, 'scam', 'dismissed', 'Reviewed, fine');
    raise warning 'BREACH: a member filed a report already dismissed'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  insert into public.marketplace_reports (family_id, listing_id, reporter_member, reason, details)
    values (fam, listing, mTeen, 'spam', 'Posted three times');
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a member could not file their own report (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uTeen, uSib);

  if failures > 0 then
    raise exception 'marketplace-report-check: % failure(s)', failures;
  end if;
end
$probe$;
