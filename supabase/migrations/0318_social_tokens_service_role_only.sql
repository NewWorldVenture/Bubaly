-- ============================================================
-- Migration 0318: put the OAuth token store back behind the service role
--
-- 0034_social_command_center.sql creates public.social_account_tokens with no
-- policy at all, and says why, in the file, at the point of creation:
--
--   "Tokens: NO policy → only the service-role client (which bypasses RLS) can
--    touch them. RLS is enabled above, so authenticated users get zero rows.
--    This is the deliberate 'secure token storage' boundary; never add a
--    permissive policy here."
--
-- 0297_sensitive_tables_respect_role.sql then added four — select, insert,
-- update and delete, each gated on can_manage_family — on the stated premise
-- that "every policy was is_family_member". There were none. Those two
-- migrations are the only ones that mention this table, so nothing could have
-- created what 0297 believed it was narrowing. 0297 was tightening the other
-- two tables in that file correctly (child_logins, driver_licenses) and
-- carried this one along on a false reading; this migration restores 0034's
-- invariant and leaves 0297's other work alone.
--
-- Nothing in the application loses access: the only reference to this table in
-- app/ or lib/ is lib/ai/context/policy.ts, which classes it under
-- "Credentials and tokens — absolute, no exception". The social integration
-- reads and writes it through the service-role client, which bypasses RLS and
-- is unaffected by every statement below.
--
-- In fact nothing writes it at all yet: lib/social/ publishes through
-- social_accounts, and the encryption module 0034's own header names
-- (lib/social/crypto) does not exist in the tree. The OAuth connect flow this
-- table was created for has not been built, so the four policies published an
-- empty store — and would have published a full one the day it was.
--
-- The columns hold AES-256-GCM ciphertext, which is why this was filed HIGH
-- rather than CRITICAL. That is defence in depth, not a reason to publish the
-- rows: the key that protects them is itself only as strong as the environment
-- value it is loaded from.
--
-- Audit: C3-S5-01.
-- ============================================================

drop policy if exists social_account_tokens_select on public.social_account_tokens;
drop policy if exists social_account_tokens_insert on public.social_account_tokens;
drop policy if exists social_account_tokens_update on public.social_account_tokens;
drop policy if exists social_account_tokens_delete on public.social_account_tokens;

-- RLS was enabled by 0034 and stays enabled: with no policy, an authenticated
-- caller gets zero rows and every write is refused. This is the same shape
-- sync_tokens uses (0018), which the audit found correct and which this table
-- should have matched all along.
alter table public.social_account_tokens enable row level security;

do $$
declare n int;
begin
  select count(*) into n from pg_policies
    where schemaname = 'public' and tablename = 'social_account_tokens';
  if n <> 0 then
    raise exception '0318: social_account_tokens still carries % policy(ies) — the token store is reachable from PostgREST', n;
  end if;
end $$;
