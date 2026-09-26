-- Bubaly :: 0327 - network consent is a manager's decision; affiliate
--                   commissions are not a family's to write
--
-- network_consent   the family's opt-in to contributing (anonymised) data to
--                   cohort insights. Member-writable, and the intelligence
--                   module showed the toggles to everyone, so a child could opt
--                   the whole household into data sharing. A minor's toggle is
--                   not consent. Writes now need can_manage_family; the module
--                   shows the setting read-only to other members.
--
-- affiliate_referrals  one row per referral an affiliate earns commission on.
--                   The admin affiliates page sums commission_cents over
--                   'converted' rows and "mark paid" settles them — real money
--                   to an outside partner. The table carried member INSERT,
--                   UPDATE and DELETE policies that nothing in the application
--                   uses (referrals are recorded and settled by the service
--                   role), so any family member could file a converted referral
--                   with any commission against any affiliate. Member writes
--                   are dropped; member SELECT is kept.
--
-- Pinned by docs/audit/consent-and-commission-check.sql.

do $$
declare
  p record;
begin
  if to_regclass('public.network_consent') is not null then
    for p in select policyname from pg_policies
              where schemaname = 'public' and tablename = 'network_consent' and cmd <> 'SELECT' loop
      execute format('drop policy %I on public.network_consent', p.policyname);
    end loop;
    execute 'create policy network_consent_insert on public.network_consent for insert to authenticated with check (public.can_manage_family(family_id))';
    execute 'create policy network_consent_update on public.network_consent for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))';
    execute 'create policy network_consent_delete on public.network_consent for delete to authenticated using (public.can_manage_family(family_id))';
  end if;

  if to_regclass('public.affiliate_referrals') is not null then
    for p in select policyname from pg_policies
              where schemaname = 'public' and tablename = 'affiliate_referrals' and cmd <> 'SELECT' loop
      execute format('drop policy %I on public.affiliate_referrals', p.policyname);
    end loop;
  end if;
end
$$;
