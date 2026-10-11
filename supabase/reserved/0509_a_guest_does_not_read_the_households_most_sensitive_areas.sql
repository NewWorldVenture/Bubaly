-- 0509 — A guest does not read the household's most sensitive areas.
-- Decided by the account holder on ROLE-SCOPE-001 ("narrow guests; fix the
-- copy"), recorded on #771 in comment 6101674181; scope posted before any SQL
-- in 6101807525.
--
-- /family/permissions and the FAQ told a parent a guest sees "limited shared
-- events only". In fact a guest's session read the whole household: 359 of
-- 433 tables with a read policy admitted is_family_member(family_id), and B15
-- measured a real guest reading live and historical locations, transactions,
-- issued cards, medications and the tax row. A parent who invites a neighbour
-- or a grandparent as Guest on the strength of those words hands them the
-- children's whereabouts and the family's finances. Measured on a replay of
-- every runnable migration through 0485, as a guest: a row about another
-- member, in 51 of the 59 tables below, read (1). 0481's sweep already closes
-- the other eight to a guest (care_log, expense_split_shares, expense_splits,
-- family_places, gift_payments, medication_doses, member_locations,
-- subscriptions_tracked); 0509's guard stands there too, so a permissive read
-- added later cannot reopen them.
--
-- This narrows the guest role on four areas (tax is 0508's, managers only):
--
--   locations (6), money and cards (34), medical and insurance (10), Guardian
--   and the household inbox (9) -- the 59 tables listed below.
--
-- public.is_family_guest(family_id) is true when the caller's active
-- membership in that family is `guest` (one row per family and user, so it is
-- exact; a guest here may be a parent elsewhere, and is a guest only here).
-- Each listed table gets one RESTRICTIVE SELECT policy, "A guest does not read
-- <table>": `not is_family_guest(family_id)`, and where the table carries a
-- member_id, `or is_self_member(member_id)`, so a guest still reads the rows
-- about themselves (their own shared location, their own share of a split).
-- Restrictive, so it narrows every permissive read already there and widens
-- nothing; a guest's update or delete of a row it cannot see changes nothing.
--
-- Kept for a guest, deliberately: the family chat and their own conversations
-- (family_messages reads through family_conversations, which admits only
-- participants), calendar, lists, meals, chores and the other shared areas,
-- rides and the emergency contacts and plans (a guest who helps in an
-- emergency), gift links (grandparents give gifts), the kid economy's points,
-- trip budgets, and `subscriptions`, the plan row feature gating reads. A
-- caregiver is not touched: a babysitter needs the children's whereabouts and
-- medical information. 0506's eight per-member health tables and
-- medical_profiles already give a guest only their own record.
--
-- Shipped with the source: the pages over these areas send a guest to their
-- landing page (one list, lib/auth/guest-scope.ts, asked by requireFeature and
-- by every page in it that resolves its context another way; a test walks
-- app/ and holds each page to it), and the role descriptions, the FAQ and the
-- permission matrix's caption say what each role sees, in the seven base
-- locales, instead of promising what nothing enforced.
--
-- The service role and session-less writers are untouched (is_family_guest is
-- false without a session, and the service role bypasses RLS).
--
-- HELD: 0509, the first number above 0508, requested on #771 in comment
-- 6101674181 and not yet confirmed. It stays in supabase/reserved/ until every
-- number below it has landed. Proven by
-- docs/audit/reserved/a-guest-does-not-read-the-households-most-sensitive-areas-check.sql
-- and .github/workflows/guest-scope-runtime.yml. Not applied to production by
-- an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

create or replace function public.is_family_guest(p_family_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.family_members
     where family_id = p_family_id and user_id = auth.uid()
       and role = 'guest' and is_active
  );
$$;

comment on function public.is_family_guest(uuid) is
  'True when the caller''s active membership in this family is a guest''s (0509). Exact: one membership row per family and user.';

revoke all on function public.is_family_guest(uuid) from public;
revoke all on function public.is_family_guest(uuid) from anon;
grant execute on function public.is_family_guest(uuid) to authenticated;

do $$
declare
  guest_withheld constant text[] := array[
    -- locations
    'member_locations', 'location_events', 'safety_check_ins', 'driving_trips', 'family_places', 'home_locations',
    -- money and cards
    'allowance_rules', 'babysitter_payments', 'billing_customers', 'bills', 'budgets',
    'child_wallets', 'family_wallets', 'financial_accounts',
    'expense_splits', 'expense_split_shares',
    'gift_payments', 'pay_handles', 'invest_holdings', 'invest_orders',
    'loyalty_accounts', 'loyalty_transactions',
    'money_timeline_insights', 'savings_goals', 'subscriptions_tracked', 'transactions', 'utility_bills',
    'stripe_authorizations', 'stripe_cardholders', 'stripe_connected_accounts', 'stripe_financial_accounts', 'stripe_issuing_cards',
    'wallet_audit_logs', 'wallet_buckets', 'wallet_cards', 'wallet_goals', 'wallet_passes', 'wallet_rewards', 'wallet_rules', 'wallet_transactions',
    -- medical and insurance
    'medications', 'medication_schedules', 'medication_doses', 'health_providers',
    'insurance_policies', 'family_insurance_policies', 'auto_insurance_policies',
    'care_log', 'behavior_logs', 'vacation_medical_information',
    -- Guardian and the household inbox
    'guardian_communications', 'guardian_audit_log', 'guardian_contacts', 'guardian_escalations',
    'guardian_member_profiles', 'guardian_routing_rules', 'guardian_screening_sessions', 'guardian_suggestions',
    'family_inbox_messages'];
  t text;
  has_member boolean;
begin
  if cardinality(guest_withheld) <> 59 then
    raise exception '0509: the list names % tables, not 59', cardinality(guest_withheld);
  end if;
  foreach t in array guest_withheld loop
    if to_regclass('public.' || t) is null then
      raise exception '0509 needs public.%', t;
    end if;
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = t and column_name = 'family_id') then
      raise exception '0509: public.% has no family_id', t;
    end if;
    has_member := exists (select 1 from information_schema.columns
                           where table_schema = 'public' and table_name = t and column_name = 'member_id');
    execute format('drop policy if exists %I on public.%I', 'A guest does not read ' || t, t);
    execute format('create policy %I on public.%I as restrictive for select to authenticated using (%s)',
                   'A guest does not read ' || t, t,
                   case when has_member
                        then 'not public.is_family_guest(family_id) or public.is_self_member(member_id)'
                        else 'not public.is_family_guest(family_id)' end);
  end loop;

  -- Self-check: every listed table carries exactly its policy, row security on.
  foreach t in array guest_withheld loop
    if not exists (select 1 from pg_policies p
                    where p.schemaname = 'public' and p.tablename = t
                      and p.policyname = 'A guest does not read ' || t
                      and p.permissive = 'RESTRICTIVE' and p.cmd = 'SELECT'
                      and p.roles = '{authenticated}'::name[]
                      and p.qual ~ '^\(?\(?NOT is_family_guest\(family_id\)\)?') then
      raise exception '0509: public.% does not carry the guest read guard', t;
    end if;
    if not exists (select 1 from pg_class c where c.oid = ('public.' || t)::regclass and c.relrowsecurity) then
      raise exception '0509: public.% has row security off', t;
    end if;
  end loop;
end
$$;

do $$
begin
  if not exists (select 1 from pg_proc f
                  where f.oid = 'public.is_family_guest(uuid)'::regprocedure
                    and f.prosecdef
                    and exists (select 1 from unnest(f.proconfig) c where c ~ '^search_path=')) then
    raise exception '0509: is_family_guest is not SECURITY DEFINER with a pinned search_path';
  end if;
end
$$;
