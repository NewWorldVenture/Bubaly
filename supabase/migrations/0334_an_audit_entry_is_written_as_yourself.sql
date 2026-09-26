-- Bubaly :: 0334 - a member's audit entry is written as themselves
--
-- audit_logs and wallet_audit_logs are append-only for members (0321), but the
-- INSERT policies checked only family membership, so a member could append an
-- entry naming ANY actor - "the parent approved this transfer", written by a
-- child - into the trail a parent reads to find out what happened. Every
-- writer that runs in a member's session (logAudit, logWalletAudit, the AI-run
-- controls and the household activity trail) records the caller's own user id;
-- the writers that record no actor or someone else (the allowance cron, card
-- issuing, the site-admin tools) run as the service role and bypass RLS. So a
-- member's INSERT now has to name the caller as the actor.
--
-- Pinned by docs/audit/audit-actor-check.sql.

do $$
begin
  if to_regclass('public.audit_logs') is not null then
    drop policy if exists audit_insert on public.audit_logs;
    create policy audit_insert on public.audit_logs
      for insert to authenticated
      with check ((family_id is null or public.is_family_member(family_id)) and actor_id = auth.uid());
  end if;
  if to_regclass('public.wallet_audit_logs') is not null then
    drop policy if exists wallet_audit_logs_insert on public.wallet_audit_logs;
    create policy wallet_audit_logs_insert on public.wallet_audit_logs
      for insert to authenticated
      with check (public.is_family_member(family_id) and actor_user_id = auth.uid());
  end if;
end
$$;
