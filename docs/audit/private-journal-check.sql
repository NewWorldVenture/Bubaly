-- A private journal is private (0338).
--
-- TEEN A's entry (private by default). As SIBLING B: reading it, rewriting it,
-- deleting it and writing an entry in A's name must all be refused. As the
-- PARENT: A's private entry is not visible, an entry A marked not private is.
-- Control: A reads and edits A's own entry.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000ee51';
  uPar uuid := '00000000-0000-4000-8000-00000000ee5a';
  uA uuid := '00000000-0000-4000-8000-00000000ee5b';
  uB uuid := '00000000-0000-4000-8000-00000000ee5c';
  mA uuid; mB uuid; entry uuid; shared uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'journal-parent@example.com'), (uA, 'journal-a@example.com'), (uB, 'journal-b@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Journal family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uA, 'A', 'teen', true) returning id into mA;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uB, 'B', 'teen', true) returning id into mB;
  insert into public.journal_entries (family_id, member_id, body) values (fam, mA, 'Dear diary') returning id into entry;
  insert into public.journal_entries (family_id, member_id, body, is_private) values (fam, mA, 'Shared with my parents', false) returning id into shared;

  -- ── as SIBLING B ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uB::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uB, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.journal_entries where member_id = mA;
  if n <> 0 then raise warning 'BREACH: a sibling read another member''s journal (%)', n; failures := failures + 1; end if;
  update public.journal_entries set body = 'rewritten' where id = entry;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a sibling rewrote a journal entry (rows: %)', n; failures := failures + 1; end if;
  delete from public.journal_entries where id = entry;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a sibling deleted a journal entry (rows: %)', n; failures := failures + 1; end if;
  begin
    insert into public.journal_entries (family_id, member_id, body) values (fam, mA, 'forged');
    raise warning 'BREACH: a sibling wrote an entry in another member''s journal'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- ── as the PARENT ────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uPar::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uPar, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.journal_entries where id = entry;
  if n <> 0 then raise warning 'BREACH: a parent read a private journal entry (%)', n; failures := failures + 1; end if;
  select count(*) into n from public.journal_entries where id = shared;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent cannot read an entry marked not private (%)', n; failures := failures + 1; end if;
  reset role;

  -- ── as A (controls) ──────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uA::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uA, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.journal_entries where member_id = mA;
  if n <> 2 then raise warning 'CONTROL FAILED: the owner cannot read their journal (%)', n; failures := failures + 1; end if;
  update public.journal_entries set body = 'Dear diary, again' where id = entry;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: the owner cannot edit their entry (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uA, uB);

  if failures > 0 then
    raise exception 'private-journal-check: % failure(s)', failures;
  end if;
end
$probe$;
