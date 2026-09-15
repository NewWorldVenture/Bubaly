-- Bubaly :: 0300 The paywall stops being a column the customer can write
-- ----------------------------------------------------------------------------
-- lib/server/entitlement.ts decides what a family may use from exactly three
-- facts: the max plan across active/trialing rows in `subscriptions`,
-- `families.trial_ends_at`, and `families.closed_at`. All three were writable
-- from the browser with the public anon key.
--
-- Measured on a replayed database, as an ordinary signed-in parent, with
-- controls proving a child and an outsider are refused the same statements:
--
--   -- handle_new_family() seeds every new family with free/trialing
--   update public.subscriptions
--      set plan = 'plus_annual', status = 'active'
--    where family_id = <my family>;
--   -> plan=plus_annual status=active
--
-- planLevel('plus_annual') is 2, so computeEntitlement returns
-- effectiveLevel 2, locked false: Family+ in full, for nothing, without Stripe
-- ever being contacted. `subs_manage` was `for all` to `is_family_admin`, and
-- Supabase grants every table in `public` to `authenticated`, so the policy was
-- the only thing in the way and it said yes.
--
-- The same session could also clear the clock directly:
--
--   update public.families set trial_ends_at = null where id = <my family>;
--   -> trial_ends_at = NULL
--
-- NULL is the GRANDFATHERED case in entitlement.ts — a pre-0161 family that is
-- never locked. And a new account could be born that way, because the column
-- carries a 5-day default rather than a refusal:
--
--   insert into public.families (name, created_by, trial_ends_at)
--        values ('never expires', auth.uid(), null);
--   -> trial_ends_at = NULL
--
-- Not one of these needs a server action, so no amount of checking in
-- app/api/billing/* could have helped: PostgREST is a first-class client and
-- RLS is the only boundary it answers to.
--
-- `billing_customers` is the same shape with a different consequence.
-- `billing_manage` let a parent set their own family's `customer_ref`, and
-- app/api/billing/portal hands that value straight to
-- stripe.billingPortal.sessions.create — so the row chooses whose billing
-- portal opens. Guessing another tenant's `cus_…` is the hard part and this is
-- not claimed as a practical takeover; it is a server-trusted identifier that
-- the client had no business writing.
--
-- Nothing loses a write it was using. Every write to `subscriptions` in the
-- product already goes through createServiceClient() — the Stripe webhook,
-- app/api/billing/{change-plan,cancel}, admin actions, onboarding and
-- ensure-family. `billing_customers` had two upserts on the user-scoped client
-- and this commit moves them to the service client; both live in routes that
-- already resolve the family from requireUserContext() and take the customer id
-- from Stripe's own response. On `families`, the only client writes anywhere in
-- the codebase are name / address / timezone / cover_url
-- (components/modules/settings-module.tsx and family-module.tsx), and those
-- keep their grants. closed_at keeps working the way the product intends
-- through account/actions.ts, which already uses the service client — closing
-- and reopening stay a parent's own decision, they just stop being a PATCH.
--
-- 0292's lesson applies: the grants are re-asserted at the END of the chain and
-- verified here against the final state, and
-- docs/audit/entitlement-write-boundary-check.sql re-measures all of it against
-- the fully replayed schema on every PR.
--
-- Idempotent; no data change.

-- ── subscriptions: readable by the family, writable only by the service role ──
drop policy if exists subs_manage on public.subscriptions;
revoke insert, update, delete on public.subscriptions from anon, authenticated;

-- ── billing_customers: same ──────────────────────────────────────────────────
drop policy if exists billing_manage on public.billing_customers;
revoke insert, update, delete on public.billing_customers from anon, authenticated;

-- ── families: the profile stays editable, the entitlement does not ───────────
-- A table-level grant cannot be narrowed by revoking one column, so the grant
-- is dropped and re-issued over the columns the product actually writes.
revoke update on public.families from anon, authenticated;
grant update (name, address, timezone, cover_url, avatar_url)
  on public.families to authenticated;

revoke insert on public.families from anon, authenticated;
grant insert (id, name, address, timezone, cover_url, avatar_url, family_code, created_by)
  on public.families to authenticated;

-- ── verification: the state this migration leaves behind, not the state at the
-- moment it ran. 0253 passed its own check and was undone by a later migration.
do $$
declare
  n int;
begin
  if exists (select 1 from pg_policy p join pg_class c on c.oid = p.polrelid
              where c.relname in ('subscriptions','billing_customers')
                and p.polname in ('subs_manage','billing_manage')) then
    raise exception '0300: a for-all entitlement policy survived the drop';
  end if;

  select count(*) into n from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'subscriptions'
     and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE','DELETE');
  if n <> 0 then
    raise exception '0300: % client write grant(s) remain on subscriptions', n;
  end if;

  select count(*) into n from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'billing_customers'
     and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE','DELETE');
  if n <> 0 then
    raise exception '0300: % client write grant(s) remain on billing_customers', n;
  end if;

  select count(*) into n from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'families'
     and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE')
     and column_name in ('trial_ends_at','closed_at');
  if n <> 0 then
    raise exception '0300: the paywall columns are still client-writable (% grant(s))', n;
  end if;

  -- The other half of 0118: the fix must not take away a write the product uses.
  select count(*) into n from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'families'
     and grantee = 'authenticated' and privilege_type = 'UPDATE'
     and column_name in ('name','address','timezone','cover_url');
  if n <> 4 then
    raise exception '0300: the family profile is no longer editable (% of 4 columns)', n;
  end if;

  select count(*) into n from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relname = 'subscriptions' and p.polname = 'subs_select';
  if n <> 1 then
    raise exception '0300: the family can no longer read its own plan';
  end if;
end $$;
