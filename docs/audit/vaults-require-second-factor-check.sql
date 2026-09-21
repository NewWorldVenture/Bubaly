-- The vaults ask for the second factor. (F-E02, in part)
--
-- `requireAal2` protects 19 server-rendered pages with `redirect()`. The data
-- those pages show is fetched by client components straight from PostgREST with
-- the browser's own session, and an `aal1` session — password only — is a fully
-- valid Supabase JWT. The redirect only fires if the browser asks Next.js for
-- the HTML page, which someone holding a stolen session cookie has no reason to
-- do. Before 0326 the live catalogue had ZERO policies mentioning `aal`:
--
--   select count(*) from pg_policies where schemaname='public'
--     and (coalesce(qual,'')||coalesce(with_check,'')) ilike '%aal%';   -> 0
--
-- The three cases below are the whole rule, and the two CONTROLS matter more
-- than the breach: a guard that refuses everyone would pass a breach test and
-- take every family's passwords away.
--
--   never enrolled, aal1  -> allowed   (most families; must not be locked out)
--   enrolled,      aal1  -> REFUSED   (the stolen-cookie case)
--   enrolled,      aal2  -> allowed   (they entered the code)
--
-- Three tables carry the guard, and the set is not arbitrary: each is read by
-- exactly one module, rendered by exactly one page, and that page already calls
-- `requireAal2`. The last section asserts that membership, so a table added to
-- the guard without that containment — or dropped from it — is reported here
-- rather than discovered when a dashboard goes quietly empty.
--
-- Rolled back rather than cleaned up: auth.mfa_factors rows are the fixture and
-- an aborted assertion must not leave one behind.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

do $probe$
declare
  fam    uuid := '00000000-0000-4000-8000-00000000e201';
  plain  uuid := '00000000-0000-4000-8000-00000000e2a1';  -- no factor enrolled
  mfa    uuid := '00000000-0000-4000-8000-00000000e2a2';  -- authenticator verified
  cred   uuid := '00000000-0000-4000-8000-00000000e2c1';
  n        int;
  ok       boolean;
  failures int := 0;
begin
  insert into auth.users (id, email) values
    (plain, 'vault-plain@example.test'), (mfa, 'vault-mfa@example.test')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Vault Assurance', plain)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, plain, 'Plain Parent', 'parent', true),
    (fam, mfa,   'MFA Parent',   'parent', true)
  on conflict (family_id, user_id) do update set role = excluded.role, is_active = true;

  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    values (gen_random_uuid(), mfa, 'Authenticator', 'totp', 'verified', now(), now());

  insert into public.family_credentials (id, family_id, label, username, secret, created_by)
    values (cred, fam, 'Bank login', 'parent@example.test', 'ENC-VAULT-SECRET', plain);
  insert into public.tax_documents (family_id, tax_year, name)
    values (fam, 2025, 'W-2 2025');
  insert into public.household_info (family_id, label)
    values (fam, 'Alarm code');

  -- ── 1. never enrolled, aal1: nothing changes for them ───────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', plain::text, 'aal', 'aal1')::text, true);
  set local role authenticated;
  if auth.uid() is distinct from plain then
    raise exception 'CONTROL FAILED: impersonation did not take — auth.uid() is %', auth.uid();
  end if;
  select public.session_meets_assurance() into ok;
  if not ok then
    raise warning 'CONTROL FAILED: a family with no authenticator is refused by the assurance rule';
    failures := failures + 1;
  end if;
  select count(*) into n from public.family_credentials where id = cred;
  if n <> 1 then
    raise warning 'CONTROL FAILED: a parent who never enrolled a factor reads %/1 of their own credentials — the fix locks families out of their passwords', n;
    failures := failures + 1;
  end if;
  select count(*) into n from public.tax_documents where family_id = fam;
  if n <> 1 then
    raise warning 'CONTROL FAILED: a parent who never enrolled a factor reads %/1 of their own tax documents', n;
    failures := failures + 1;
  end if;
  select count(*) into n from public.household_info where family_id = fam;
  if n <> 1 then
    raise warning 'CONTROL FAILED: a parent who never enrolled a factor reads %/1 of their own binder rows', n;
    failures := failures + 1;
  end if;
  update public.family_credentials set username = 'still-mine@example.test' where id = cred;
  get diagnostics n = row_count;
  if n <> 1 then
    raise warning 'CONTROL FAILED: a parent who never enrolled a factor cannot update their own credential (rows: %)', n;
    failures := failures + 1;
  end if;

  -- ── 2. enrolled, aal1: the stolen-cookie case ───────────────────────────
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', mfa::text, 'aal', 'aal1')::text, true);
  set local role authenticated;
  if not public.can_manage_family(fam) then
    raise exception 'CONTROL FAILED: the enrolled parent is not a manager, so their refusal proves nothing';
  end if;
  select public.session_meets_assurance() into ok;
  if ok then
    raise warning 'BREACH: an aal1 session on an account with a verified factor satisfies the assurance rule';
    failures := failures + 1;
  end if;
  select count(*) into n from public.family_credentials where id = cred;
  if n > 0 then
    raise warning 'BREACH: a password-only session read % stored credential row(s) from an account with a second factor', n;
    failures := failures + 1;
  end if;
  select count(*) into n from public.tax_documents where family_id = fam;
  if n > 0 then
    raise warning 'BREACH: a password-only session read % tax document row(s)', n;
    failures := failures + 1;
  end if;
  select count(*) into n from public.household_info where family_id = fam;
  if n > 0 then
    raise warning 'BREACH: a password-only session read % household binder row(s)', n;
    failures := failures + 1;
  end if;
  begin
    update public.family_credentials set secret = 'REWRITTEN' where id = cred;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a password-only session rewrote % stored credential(s)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.family_credentials (family_id, label, username, secret, created_by)
      values (fam, 'Planted', 'attacker@example.test', 'ENC', mfa);
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a password-only session inserted a credential row';
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.family_credentials where id = cred;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a password-only session deleted % stored credential(s)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- ── 3. enrolled, aal2: they entered the code ────────────────────────────
  --
  -- The row is re-created first. Without the guard the DELETE above SUCCEEDS,
  -- and a control run after it reports "a stepped-up parent reads 0/1
  -- credentials" — blaming the fix for a row the breach removed. A control has
  -- to run against a row that exists whether or not the guard is in place.
  reset role;
  delete from public.family_credentials where family_id = fam;
  insert into public.family_credentials (id, family_id, label, username, secret, created_by)
    values (cred, fam, 'Bank login', 'parent@example.test', 'ENC-VAULT-SECRET', plain);
  delete from public.tax_documents where family_id = fam;
  insert into public.tax_documents (family_id, tax_year, name) values (fam, 2025, 'W-2 2025');
  delete from public.household_info where family_id = fam;
  insert into public.household_info (family_id, label) values (fam, 'Alarm code');

  perform set_config('request.jwt.claims', json_build_object('sub', mfa::text, 'aal', 'aal2')::text, true);
  set local role authenticated;
  select public.session_meets_assurance() into ok;
  if not ok then
    raise warning 'CONTROL FAILED: a stepped-up session is refused by the assurance rule';
    failures := failures + 1;
  end if;
  select count(*) into n from public.family_credentials where id = cred;
  if n <> 1 then
    raise warning 'CONTROL FAILED: a stepped-up parent reads %/1 credentials — entering the code gains them nothing', n;
    failures := failures + 1;
  end if;
  select count(*) into n from public.tax_documents where family_id = fam;
  if n <> 1 then
    raise warning 'CONTROL FAILED: a stepped-up parent reads %/1 tax documents', n;
    failures := failures + 1;
  end if;
  select count(*) into n from public.household_info where family_id = fam;
  if n <> 1 then
    raise warning 'CONTROL FAILED: a stepped-up parent reads %/1 binder rows', n;
    failures := failures + 1;
  end if;
  update public.family_credentials set username = 'stepped-up@example.test' where id = cred;
  get diagnostics n = row_count;
  if n <> 1 then
    raise warning 'CONTROL FAILED: a stepped-up parent cannot update a credential (rows: %)', n;
    failures := failures + 1;
  end if;

  -- ── 4. a missing claim is aal1, not a free pass ─────────────────────────
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', mfa::text)::text, true);
  set local role authenticated;
  select public.session_meets_assurance() into ok;
  if ok then
    raise warning 'BREACH: a session with NO aal claim satisfies the assurance rule — absence must read as aal1';
    failures := failures + 1;
  end if;

  -- ── 5. the guarded set is exactly the contained set ─────────────────────
  --
  -- A restrictive assurance guard on a table that some UNGATED surface also
  -- reads does not protect anything extra — it empties that surface, silently,
  -- for every enrolled aal1 session. So the set is not a matter of taste, and
  -- it is asserted rather than remembered: these three tables are each read by
  -- one module, rendered by one page, and that page calls requireAal2.
  -- Adding a fourth is a code change first and a migration second.
  reset role;
  select count(*) into n
    from pg_policies
   where schemaname = 'public'
     and policyname like '%assurance_guard%'
     and tablename not in ('family_credentials', 'tax_documents', 'household_info');
  if n > 0 then
    raise warning 'UNREVIEWED: % assurance guard(s) on tables outside the contained set. Confirm every surface reading them steps up, or they go quietly empty.', n;
    failures := failures + 1;
  end if;
  select count(*) into n
    from pg_policies
   where schemaname = 'public'
     and policyname like '%assurance_guard%'
     and tablename in ('family_credentials', 'tax_documents', 'household_info');
  if n <> 3 then
    raise warning 'BREACH: %/3 vault tables carry the assurance guard', n;
    failures := failures + 1;
  end if;

  if failures > 0 then
    raise exception 'the vaults do not require the second factor: % finding(s)', failures;
  end if;
  raise notice 'OK: the vaults open for a stepped-up session and for a family with no factor, and for nobody else.';
end
$probe$;

rollback;
