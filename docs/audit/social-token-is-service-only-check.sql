-- Third-party OAuth credentials are readable only by the service role. (F-E04)
--
-- Two tables hold provider credentials in identically named columns
-- (access_token_enc, refresh_token_enc, scope, expires_at) and were protected
-- differently:
--
--   sync_tokens            | tokens service only          | ALL    | qual=false  check=false
--   social_account_tokens  | social_account_tokens_select | SELECT | qual=can_manage_family(family_id)
--   social_account_tokens  | social_account_tokens_update | UPDATE | qual=can_manage_family(family_id)
--   social_account_tokens  | social_account_tokens_delete | DELETE | qual=can_manage_family(family_id)
--   social_account_tokens  | social_account_tokens_insert | INSERT | check=can_manage_family(family_id)
--
-- `qual=false` is the right answer for a credential table, and every path that
-- touches social_account_tokens already goes through the service role:
-- lib/social/account-tokens.ts types its client as
-- `ReturnType<typeof createServiceClient>` and nothing else in app/ or lib/
-- reads the table. So the four client policies grant access no feature needs,
-- to a table whose whole content is credentials.
--
-- What the manager policy actually allowed, and what it did not: the token
-- columns are ciphertext from lib/sync/crypto, so a manager reading them does
-- not obtain usable credentials. `metadata` is not ciphertext, and it carries
-- the x_state / x_revision claim machine that account-tokens.ts uses to make
-- the OAuth exchange idempotent — a client that can write it directly can
-- replay or strand a connection flow. This probe asserts the whole table is
-- closed rather than arguing column by column about which parts are safe.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000c401';
  mgr  uuid := '00000000-0000-4000-8000-00000000c4a1';
  kid  uuid := '00000000-0000-4000-8000-00000000c4a2';
  acct uuid := '00000000-0000-4000-8000-00000000c4b1';
  tok  uuid := '00000000-0000-4000-8000-00000000c4c1';
  n        int;
  seen     text;
  failures int := 0;
begin
  delete from public.social_account_tokens where id = tok;
  delete from public.social_accounts where id = acct;

  insert into auth.users (id, email) values
    (mgr, 'social-token-parent@example.com'), (kid, 'social-token-child@example.com')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Social Tokens', mgr)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, mgr, 'Parent', 'parent', true),
    (fam, kid, 'Child',  'child',  true)
  on conflict (family_id, user_id) do update set role = excluded.role, is_active = true;

  insert into public.social_accounts (id, family_id, user_id, platform)
    values (acct, fam, mgr, 'x');
  insert into public.social_account_tokens
    (id, account_id, family_id, platform, provider_account_id,
     access_token_enc, refresh_token_enc, scope, expires_at, created_by, metadata)
  values
    (tok, acct, fam, 'x', '1234567890',
     'ENC-ACCESS-DO-NOT-LEAK', 'ENC-REFRESH-DO-NOT-LEAK', 'tweet.read tweet.write',
     now() + interval '1 hour', mgr, '{"x_state":"consumed","x_revision":"r1"}'::jsonb);

  -- ── as the family's manager: the role the old policy admitted ───────────
  perform set_config('request.jwt.claim.sub', mgr::text, true);
  set local role authenticated;

  if not public.can_manage_family(fam) then
    raise exception 'CONTROL FAILED: not acting as a manager, so nothing below is a restriction';
  end if;

  select string_agg(access_token_enc, ',') into seen
  from public.social_account_tokens where id = tok;
  if seen is not null then
    raise warning 'BREACH: a manager read stored OAuth credentials through the client role (%).', seen;
    failures := failures + 1;
  end if;

  -- The claim machine, which is not ciphertext and decides whether an OAuth
  -- exchange may be replayed.
  begin
    update public.social_account_tokens
       set metadata = '{"x_state":"connecting","x_revision":"forged"}'::jsonb
     where id = tok;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a manager rewrote the OAuth claim state through the client role (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  begin
    update public.social_account_tokens set provider_account_id = '999' where id = tok;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a manager repointed a connection at another provider account (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.social_account_tokens where id = tok;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a manager deleted a credential row through the client role (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.social_account_tokens
      (account_id, family_id, platform, provider_account_id, access_token_enc, created_by)
    values (acct, fam, 'x', '555', 'FORGED', mgr);
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a manager inserted a credential row through the client role (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- ── as a child of the same family ───────────────────────────────────────
  reset role;
  perform set_config('request.jwt.claim.sub', kid::text, true);
  set local role authenticated;
  if not public.is_family_member(fam) then
    raise warning 'CONTROL FAILED: the child is not a member, so their refusal proves nothing';
    failures := failures + 1;
  end if;
  select count(*) into n from public.social_account_tokens where id = tok;
  if n > 0 then
    raise warning 'BREACH: a child read a stored credential row (rows: %)', n;
    failures := failures + 1;
  end if;

  -- ── the standard being matched: sync_tokens refuses the same manager ────
  reset role;
  perform set_config('request.jwt.claim.sub', mgr::text, true);
  set local role authenticated;
  select count(*) into n from public.sync_tokens;
  if n > 0 then
    raise warning 'CONTROL FAILED: sync_tokens is readable by a client role, so it is not the standard this claims to match (rows: %)', n;
    failures := failures + 1;
  end if;

  -- ── the service role still has the table, or the feature is broken ──────
  --
  -- Re-created first: when the guard is NOT in place the manager's DELETE above
  -- succeeds, and a control that then reports "the service role cannot read it"
  -- would be blaming the guard for the breach. The control has to run against a
  -- row that exists either way.
  reset role;
  delete from public.social_account_tokens where account_id = acct;
  insert into public.social_account_tokens
    (id, account_id, family_id, platform, provider_account_id,
     access_token_enc, refresh_token_enc, scope, expires_at, created_by, metadata)
  values
    (tok, acct, fam, 'x', '1234567890',
     'ENC-ACCESS-DO-NOT-LEAK', 'ENC-REFRESH-DO-NOT-LEAK', 'tweet.read tweet.write',
     now() + interval '1 hour', mgr, '{"x_state":"consumed","x_revision":"r1"}'::jsonb);

  select string_agg(access_token_enc, ',') into seen
  from public.social_account_tokens where id = tok;
  if seen is distinct from 'ENC-ACCESS-DO-NOT-LEAK' then
    raise warning 'CONTROL FAILED: the service role cannot read the credential it wrote (got %) — the X connection would be dead', seen;
    failures := failures + 1;
  end if;
  update public.social_account_tokens set metadata = metadata || '{"probe":true}'::jsonb where id = tok;
  get diagnostics n = row_count;
  if n <> 1 then
    raise warning 'CONTROL FAILED: the service role cannot update a credential row (rows: %)', n;
    failures := failures + 1;
  end if;

  -- fixtures out
  delete from public.social_account_tokens where account_id = acct;
  delete from public.social_accounts where id = acct;
  delete from public.family_members where family_id = fam;
  delete from public.families where id = fam;
  delete from auth.users where id in (mgr, kid);

  if failures > 0 then
    raise exception 'social_account_tokens is reachable from a client role: % finding(s)', failures;
  end if;
  raise notice 'OK: stored OAuth credentials are service-role only, and the service role still has them.';
end
$probe$;
