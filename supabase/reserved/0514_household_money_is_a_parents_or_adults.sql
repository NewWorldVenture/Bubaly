-- 0514 — Household money is a parent's or adult's.
-- Decided by the account holder this session, recorded and requested on #771
-- in comment 6109587749: the audit's open sensitive-table finding ("55 OPEN,
-- owner decision"), household-money group, "parents and adults only". Two
-- follow-ups, also the account holder's: a member reads the transactions
-- tagged to them (recorded in 6110569862), and whoever adds a paperwork item,
-- warranty, vehicle registration or auto insurance policy keeps reading it
-- (recorded with this migration's report on #771).
--
-- Twelve tables hold the household's money and money papers and read with
-- is_family_member(family_id) (billing_customers also with a manager's read
-- beside it), so a teen, a child or a caregiver reads the household's bank
-- balances, every purchase, the Stripe account rows, the babysitter payouts
-- and the paperwork queue:
--
--   managers:   financial_accounts, family_wallets, stripe_connected_accounts,
--               stripe_financial_accounts, billing_customers, checkout_sessions,
--               babysitter_payments
--   + member:   transactions (member_id)
--   + adder:    home_warranties, auto_insurance_policies, vehicle_registrations,
--               paperwork_items (created_by)
--
-- lib/ai/context/policy.ts lists every one as sensitive.
--
-- The decision:
--   * a parent or adult reads every row;
--   * a transaction tagged to a member is that member's to read too; spending
--     tagged to nobody is the parents';
--   * whoever added a paperwork item, a warranty, a registration or an auto
--     policy keeps reading it;
--   * nobody else reads a row.
--
--   managers:  is_family_member(family_id) and can_manage_family(family_id)
--   member:    ... and (can_manage_family(family_id) or is_self_member(member_id))
--   adder:     ... and (can_manage_family(family_id) or created_by = auth.uid())
--
-- Every permissive read on the twelve tables is replaced. None carries a FOR
-- ALL policy, so no write policy is touched: transactions, accounts, wallets
-- and babysitter payouts stay a manager's to write, the Stripe and billing rows
-- the server's, and the four added-by tables any member's. Postgres applies a
-- table's read policy to an UPDATE or DELETE that names a row, so a member
-- changes or removes an added-by record only when it is theirs to read.
-- Restrictive policies already there (the held 0509's guest guard on nine of
-- them, the step-up guards on paperwork) are kept.
--
-- Shipped with the source (lib/finance/household-money.ts, the same rule):
-- the Family CFO page, the billing page's finances views and the home page's
-- Family Finances card are a parent's or adult's, and say so to anyone else;
-- the payments, budgets and wallet views read a non-manager's own transactions
-- before their limits; the paperwork inbox, warranties, registrations and auto
-- insurance read what a non-manager added; whether the family wallet is on is
-- read by the server for every member's wallet pages
-- (lib/wallet/family-wallet-status.ts).
--
-- HELD: 0514, requested on #771 in comment 6109587749 and not yet confirmed.
-- It stays in supabase/reserved/ until every number below it has landed.
-- Proven by docs/audit/reserved/household-money-is-a-parents-or-adults-check.sql
-- and .github/workflows/household-money-runtime.yml. Not applied to production
-- by an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
declare
  x record;
  p record;
  writes_before int;
  writes_after int;
begin
  if to_regprocedure('public.is_family_member(uuid)') is null or to_regprocedure('public.can_manage_family(uuid)') is null
     or to_regprocedure('public.is_self_member(uuid)') is null then
    raise exception '0514 needs is_family_member, can_manage_family and is_self_member';
  end if;
  for x in select * from (values
             ('financial_accounts', 'managers'), ('family_wallets', 'managers'),
             ('stripe_connected_accounts', 'managers'), ('stripe_financial_accounts', 'managers'),
             ('billing_customers', 'managers'), ('checkout_sessions', 'managers'), ('babysitter_payments', 'managers'),
             ('transactions', 'member'),
             ('home_warranties', 'adder'), ('auto_insurance_policies', 'adder'),
             ('vehicle_registrations', 'adder'), ('paperwork_items', 'adder')) as v(t, rule) loop
    if to_regclass('public.' || x.t) is null
       or not exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = x.t and column_name = 'family_id')
       or (x.rule = 'member' and not exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = x.t and column_name = 'member_id'))
       or (x.rule = 'adder' and not exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = x.t and column_name = 'created_by')) then
      raise exception '0514 needs public.% with the columns its rule reads', x.t;
    end if;
    if exists (select 1 from pg_policy where polrelid = ('public.' || x.t)::regclass and polpermissive and polcmd = '*') then
      raise exception '0514: public.% carries a FOR ALL policy; its write half would go with its read', x.t;
    end if;
    select count(*) into writes_before from pg_policy where polrelid = ('public.' || x.t)::regclass and polcmd <> 'r';
    for p in select polname from pg_policy
              where polrelid = ('public.' || x.t)::regclass and polpermissive and polcmd = 'r' loop
      execute format('drop policy %I on public.%I', p.polname, x.t);
    end loop;
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_family_member(family_id) and %s)',
      'Household money is read by a parent or adult', x.t,
      case x.rule
        when 'managers' then 'public.can_manage_family(family_id)'
        when 'member' then '(public.can_manage_family(family_id) or public.is_self_member(member_id))'
        else '(public.can_manage_family(family_id) or created_by = auth.uid())'
      end);
    select count(*) into writes_after from pg_policy where polrelid = ('public.' || x.t)::regclass and polcmd <> 'r';
    if writes_after <> writes_before then
      raise exception '0514: public.% had % write policies and now has %', x.t, writes_before, writes_after;
    end if;
  end loop;
end
$$;

do $$
declare
  t text;
  n int;
begin
  foreach t in array array['financial_accounts', 'family_wallets', 'stripe_connected_accounts', 'stripe_financial_accounts',
                           'billing_customers', 'checkout_sessions', 'babysitter_payments', 'transactions',
                           'home_warranties', 'auto_insurance_policies', 'vehicle_registrations', 'paperwork_items'] loop
    select count(*) into n from pg_policy
     where polrelid = ('public.' || t)::regclass and polpermissive and polcmd in ('r', '*');
    if n <> 1 or not exists (select 1 from pg_policy
                              where polrelid = ('public.' || t)::regclass and polpermissive and polcmd = 'r'
                                and polname = 'Household money is read by a parent or adult') then
      raise exception '0514: public.% carries % permissive read policies, not the one it sets', t, n;
    end if;
    if not exists (select 1 from pg_class where oid = ('public.' || t)::regclass and relrowsecurity) then
      raise exception '0514: public.% has row security off', t;
    end if;
  end loop;
end
$$;
