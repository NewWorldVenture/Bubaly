-- Bubaly :: 0224 - wallet_audit_logs is append-only for clients (A-08 integrity)
--
-- wallet_audit_logs is the money audit trail (wallet activation, transfers,
-- approvals, AI-coach calls, invest decisions). It shipped (0088) with the
-- systemic `"Members manage" ... FOR ALL USING/WITH CHECK is_family_member`
-- policy and was NOT covered by the 0217 wallet money-ledger lockdown, so a
-- signed-in child could `update`/`delete` wallet_audit_logs rows directly via
-- PostgREST — rewriting or ERASING money-audit history to cover their tracks,
-- undermining the parent oversight the log exists to provide. (This is an audit
-- integrity gap, not money movement — the ledger itself, wallet_transactions,
-- is locked to managers/service-role by 0217.)
--
-- The app appends to this log from a mix of sessions (a manager on wallet
-- activation, a child on an AI-coach call, plus SECURITY DEFINER RPCs) and
-- there is NO legitimate UPDATE or DELETE of an audit row anywhere in the code.
-- So the fix keeps SELECT + INSERT open to family members (every existing append
-- keeps working) but removes UPDATE/DELETE for clients: the money audit trail
-- becomes append-only, and only the service role (retention/tooling, BYPASSRLS)
-- can ever alter or prune it. A child can still append a row (attributed to them
-- via actor_user_id, moving no money), but can no longer rewrite or erase the
-- record.

do $$
begin
  if to_regclass('public.wallet_audit_logs') is null then
    return;
  end if;

  -- Drop the permissive FOR ALL policy from 0088.
  drop policy if exists "Members manage wallet_audit_logs" on public.wallet_audit_logs;

  -- Members read their own family's money audit trail.
  drop policy if exists wallet_audit_logs_select on public.wallet_audit_logs;
  create policy wallet_audit_logs_select on public.wallet_audit_logs
    for select to authenticated using (public.is_family_member(family_id));

  -- Members (and the SECURITY DEFINER RPCs) may APPEND audit rows for their family.
  drop policy if exists wallet_audit_logs_insert on public.wallet_audit_logs;
  create policy wallet_audit_logs_insert on public.wallet_audit_logs
    for insert to authenticated with check (public.is_family_member(family_id));

  -- No UPDATE/DELETE policy for authenticated: the money audit trail is
  -- append-only for every client role. Only the service role (BYPASSRLS) may
  -- alter or prune it (retention/tooling).
end $$;
