-- Bubaly :: 0328 - the money audit trail says who appended, not who was named
--
-- 0224 made `wallet_audit_logs` append-only for clients: it dropped 0088's
-- `FOR ALL` policy, kept SELECT and INSERT for family members, and added no
-- UPDATE or DELETE policy, so no client role can rewrite or prune the trail.
-- That holds, and it is not what this changes.
--
-- What 0224 ASSUMED is in its own closing sentence:
--
--   "A child can still append a row (attributed to them via actor_user_id,
--    moving no money), but can no longer rewrite or erase the record."
--
-- Attributed to them by whom? The policy is
--
--   wallet_audit_logs_insert  FOR INSERT TO authenticated
--     WITH CHECK (public.is_family_member(family_id))
--
-- `family_id` is pinned and every other column is free — including
-- `actor_user_id`. So the attribution was the WRITER'S choice, exactly as
-- `audit_logs.actor_id` was before `0320_audit_logs_says_who_wrote_it.sql`
-- pinned it. 0320 fixed the household trail and left its money-domain sibling
-- on the old shape.
--
-- Measured on a replayed database with all 336 migrations applied, as a child
-- of the family:
--
--   insert into wallet_audit_logs
--     (family_id, actor_user_id, action, entity_type, detail)
--   values (<fam>, <the PARENT's uid>, 'funds_added', 'child_wallets',
--           'Added 50000 cents')                                  -> INSERT 1
--
-- and /wallet, /wallet/children/[childId], /api/ai/wallet and the admin wallet
-- page all render that line as the parent's doing. It is the same trail
-- `wallet_fund_goal` (0208) and the rest of 0196/0205 write their `goal_funded`
-- and transfer rows into, so a forged line sits in the record beside genuine
-- ones with nothing to tell them apart. Because 0224 left no UPDATE or DELETE
-- policy, existing rows still cannot be changed or erased — the trail can only
-- be POLLUTED, never edited. That is the whole claim and it is not more.
--
-- ── why pin rather than drop the member INSERT, as 0260 did ────────────────
-- The same reason 0320 gave for `audit_logs`. Legitimate appends come from a
-- mix of sessions on the caller's own cookie-bound client, and every one of
-- them already passes its own id:
--
--   app/(app)/wallet/actions.ts        activateFamilyWalletAction, addFundsAction,
--                                      recordBabysitterPaymentAction,
--                                      claimPayHandleAction   -> ctx.user.id
--   app/api/ai/wallet|invest routes    ai_coach_call, ai_invest_call
--                                                             -> ctx.user.id
--   lib/wallet/server.ts               creditChildWallet, debitSpendBucket
--                                                             -> params.createdBy,
--                                        which both callers set to ctx.user.id
--
-- So the pin costs the honest callers nothing. The system rows keep working
-- unchanged: `debitCardSpend` writes `actor_user_id = null` for a card
-- authorisation and reaches this table only through lib/stripe/webhook.ts on
-- the SERVICE client, app/(app)/money/actions.ts logs card events on its own
-- service client, the allowance cron is service-role, and 0196/0205/0208 are
-- SECURITY DEFINER owned by the migration role. All of those bypass RLS, and
-- the definer functions pass `p_actor_id` which they have already required to
-- equal `auth.uid()`.
--
-- READS are unchanged: `wallet_audit_logs_select` stays
-- `is_family_member(family_id)`, so a child still sees their own household's
-- money history. There is still no UPDATE or DELETE policy, so 0224's
-- append-only property is untouched.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).
--
-- Idempotent.

do $$
begin
  if to_regclass('public.wallet_audit_logs') is null then
    return;
  end if;

  drop policy if exists wallet_audit_logs_insert on public.wallet_audit_logs;
  create policy wallet_audit_logs_insert on public.wallet_audit_logs
    for insert to authenticated
    with check (
      public.is_family_member(family_id)
      and actor_user_id = auth.uid()
    );
end $$;

-- 0224 left the anon grant alone; the insert policy names only `authenticated`,
-- so an anonymous request is refused for want of a permissive policy. Closed
-- anyway for the reason 0290 gives: one future policy written `TO public` would
-- otherwise find the grant waiting. SELECT is left as it is.
revoke insert, update, delete, truncate on public.wallet_audit_logs from anon;

do $$
begin
  if to_regclass('public.wallet_audit_logs') is null then
    return;
  end if;

  if has_table_privilege('anon', 'public.wallet_audit_logs', 'INSERT') then
    raise exception '0328: anon still holds INSERT on wallet_audit_logs';
  end if;

  -- A migration that silently created nothing is worse than one that failed.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'wallet_audit_logs'
      and policyname = 'wallet_audit_logs_insert'
      and with_check like '%actor_user_id = auth.uid()%'
  ) then
    raise exception '0328: wallet_audit_logs_insert does not pin actor_user_id';
  end if;

  -- 0224's append-only property must survive this edit.
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'wallet_audit_logs'
      and cmd in ('UPDATE', 'DELETE') and 'authenticated' = any (roles)
  ) then
    raise exception '0328: a client UPDATE/DELETE policy appeared on wallet_audit_logs — 0224 says the money trail is append-only';
  end if;

  raise notice '0328 OK: a wallet audit row names the member who actually appended it; the trail stays append-only and readable by the household.';
end $$;
