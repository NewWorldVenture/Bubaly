-- Bubaly :: 0328 - checkout tracking, the wallet-terms record, chore rewards
--                   and babysitters are not any member's to write
--
-- Each table below was writable by every family member, a child included,
-- while every application writer is either the service role or a manager-gated
-- server action. Reads are unchanged (family members).
--
-- checkout_sessions   the abandoned-checkout cron emails the `email` of every
--                     row left 'pending' for an hour, addressed to `name`. A
--                     member could file pending rows with any address and any
--                     name, and Bubaly would send its checkout nudge there on
--                     their behalf. Rows are written by the billing routes and
--                     the Stripe webhook (service role) only; member writes are
--                     dropped.
--
-- compliance_disclosures  the parent's acceptance of the wallet terms, the
--                     "immutable audit" activateFamilyWalletAction records. It
--                     was member FOR ALL, so a child could file an acceptance in
--                     a parent's name or delete the real one. Now a manager
--                     records their OWN acceptance and nobody rewrites or
--                     deletes one.
--
-- kid_progress, member_badges  chore XP, level, streak and badges. Awarded on
--                     approval, by the service role (auto-approve) or a manager
--                     (approveSubmissionAction), so a child could simply write
--                     their own level 50 and every badge. Writes need
--                     can_manage_family.
--
-- babysitter_profiles, babysitter_payments  who the sitter is (name, phone,
--                     email, rate) and the payment receipts. The wallet actions
--                     are parent-only, but RLS let a child change a sitter's
--                     phone number or delete a receipt. Writes need
--                     can_manage_family.
--
-- Pinned by docs/audit/checkout-rewards-babysitter-check.sql.

do $$
declare
  t text;
  p record;
begin
  -- Service-written: drop member writes, keep member reads.
  if to_regclass('public.checkout_sessions') is not null then
    for p in select policyname from pg_policies
              where schemaname = 'public' and tablename = 'checkout_sessions' and cmd <> 'SELECT' loop
      execute format('drop policy %I on public.checkout_sessions', p.policyname);
    end loop;
  end if;

  -- Append-only, and only a manager's own acceptance.
  if to_regclass('public.compliance_disclosures') is not null then
    for p in select policyname from pg_policies
              where schemaname = 'public' and tablename = 'compliance_disclosures' loop
      execute format('drop policy %I on public.compliance_disclosures', p.policyname);
    end loop;
    execute 'create policy compliance_disclosures_select on public.compliance_disclosures for select to authenticated using (public.is_family_member(family_id))';
    execute 'create policy compliance_disclosures_insert on public.compliance_disclosures for insert to authenticated with check (public.can_manage_family(family_id) and accepted_by = auth.uid())';
  end if;

  -- Manager writes.
  foreach t in array array['kid_progress', 'member_badges', 'babysitter_profiles', 'babysitter_payments'] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy %I on public.%I for select to authenticated using (public.is_family_member(family_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.can_manage_family(family_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.can_manage_family(family_id))', t || '_delete', t);
  end loop;
end
$$;
