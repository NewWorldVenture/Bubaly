-- ── 0300: the paywall is not a column the customer can write ────────────────
--
-- lib/server/entitlement.ts decides what a family may use from three facts:
-- the max plan across active/trialing `subscriptions` rows, and
-- `families.trial_ends_at` / `families.closed_at`. Before 0300 a signed-in
-- parent could write all of them from the browser with the public anon key, so
-- Family+ cost one PATCH and no Stripe call.
--
-- This probe re-measures that against the FULLY REPLAYED schema, which is the
-- only state a database actually runs in — 0253 verified its own lockdown at
-- its own moment in the chain and a later migration handed the grant back.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/entitlement-write-boundary-check.sql
--
-- Each attempt is judged on BOTH outcomes an attack can have: the refusal
-- (42501) and the row count. An UPDATE that RLS filters to no visible row
-- changes nothing and raises nothing, so an exception handler alone reads that
-- silent block as a breach — assertion 7 did exactly that in a first draft and
-- accused the child of a write RLS had already stopped.
-- Re-runnable: the fixture family's rows are cleared before each run.
do $$
declare
  fam   uuid := 'e0300000-0000-4000-8000-00000000fa01';
  other uuid := 'e0300000-0000-4000-8000-00000000fa02';
  par   uuid := 'e0300000-0000-4000-8000-00000000c001';
  kid   uuid := 'e0300000-0000-4000-8000-00000000c002';
  n int; blocked boolean;
begin
  insert into public.families (id, name) values (fam,'0300 entitlement'), (other,'0300 other')
    on conflict (id) do nothing;
  insert into auth.users (id, email) values (par,'p0300@example.test'), (kid,'k0300@example.test')
    on conflict (id) do nothing;

  delete from public.billing_customers where family_id in (fam, other);
  delete from public.family_members    where family_id in (fam, other);
  insert into public.family_members (family_id,user_id,display_name,role,is_active) values
    (fam,par,'Parent','parent',true), (fam,kid,'Kid','child',true);

  -- The family is FREE with an expired trial: locked, per entitlement.ts. Every
  -- assertion below is about escaping that state, so it has to be the state.
  update public.families set trial_ends_at = now() - interval '30 days', closed_at = null where id = fam;
  delete from public.subscriptions where family_id = fam;
  insert into public.subscriptions (family_id, plan, status) values (fam, 'free', 'trialing');
  insert into public.billing_customers (family_id, provider, customer_ref) values (fam, 'stripe', 'cus_fixture');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', par::text, true);

  -- A probe that cannot tell "refused because the boundary holds" from
  -- "refused because nobody is signed in" passes against a broken schema too.
  if auth.uid() is distinct from par then
    raise exception '0300: impersonation failed — auth.uid() is %, expected the parent', auth.uid();
  end if;
  if not public.is_family_admin(fam) then
    raise exception '0300: fixture wrong — the parent is not a family admin, so nothing below is tested';
  end if;
  -- ...and one the parent IS still allowed to do, so a blanket revoke that
  -- broke the product would not read as a pass.
  update public.families set name = '0300 entitlement' where id = fam;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception '0300: a parent can no longer rename their own family — the lockdown went too far';
  end if;
  select count(*) into n from public.subscriptions where family_id = fam;
  if n <> 1 then
    raise exception '0300: a parent can no longer read their own plan (% rows) — the billing page is blank', n;
  end if;

  -- 1. Self-upgrade to the top tier. planLevel('plus_annual') = 2.
  blocked := false; n := 0;
  begin
    update public.subscriptions set plan = 'plus_annual', status = 'active' where family_id = fam;
    get diagnostics n = row_count;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked and n > 0 then
    raise exception '0300: a parent granted themselves Family+ by writing subscriptions (% row(s)) — the paywall is client-side', n;
  end if;

  -- 2. Minting a second paid row rather than editing the seeded one.
  blocked := false;
  begin
    insert into public.subscriptions (family_id, plan, status) values (fam, 'plus', 'active');
  exception when insufficient_privilege then blocked := true;
       when unique_violation then blocked := true;  -- uq_subscriptions_family got there first
  end;
  if not blocked then
    raise exception '0300: a parent inserted their own paid subscription row';
  end if;

  -- 3. Clearing the trial clock. NULL is the GRANDFATHERED case: never locked.
  blocked := false; n := 0;
  begin
    update public.families set trial_ends_at = null where id = fam;
    get diagnostics n = row_count;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked and n > 0 then
    raise exception '0300: a parent cleared families.trial_ends_at (% row(s)) — the trial never ends', n;
  end if;

  -- 4. Being born grandfathered: the column has a 5-day default, not a refusal.
  blocked := false;
  begin
    insert into public.families (name, created_by, trial_ends_at) values ('born free', par, null);
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception '0300: a new family was created with trial_ends_at NULL — grandfathered on arrival';
  end if;

  -- 5. closed_at. Closing and reopening stay a parent's decision through
  --    app/(app)/account/actions.ts, which uses the service client; the column
  --    itself is not the browser's to set.
  blocked := false; n := 0;
  begin
    update public.families set closed_at = null where id = fam;
    get diagnostics n = row_count;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked and n > 0 then
    raise exception '0300: families.closed_at is writable from the browser';
  end if;

  -- 6. billing_customers.customer_ref decides whose Stripe portal opens in
  --    app/api/billing/portal — it is a server-trusted identifier.
  blocked := false; n := 0;
  begin
    update public.billing_customers set customer_ref = 'cus_someone_else' where family_id = fam;
    get diagnostics n = row_count;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked and n > 0 then
    raise exception '0300: a parent rewrote their billing customer reference';
  end if;

  -- 7. The child must not have gained anything either.
  perform set_config('request.jwt.claim.sub', kid::text, true);
  blocked := false; n := 0;
  begin
    update public.subscriptions set plan = 'plus', status = 'active' where family_id = fam;
    get diagnostics n = row_count;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked and n > 0 then
    raise exception '0300: a child wrote the family subscription';
  end if;

  reset role;
  raise notice '0300 entitlement write boundary OK';
end $$;

-- The grants themselves, read from the catalog rather than inferred from the
-- statements above: a policy can be re-created by a later migration, and a
-- table-level grant cannot be narrowed by revoking one column.
do $$
declare n int; begin
  select count(*) into n from information_schema.column_privileges
   where table_schema = 'public' and table_name in ('subscriptions','billing_customers')
     and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE','DELETE');
  if n <> 0 then
    raise exception '0300: % client write grant(s) are back on the entitlement tables', n;
  end if;

  select count(*) into n from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'families'
     and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE')
     and column_name in ('trial_ends_at','closed_at');
  if n <> 0 then
    raise exception '0300: the paywall columns are client-writable again (% grant(s))', n;
  end if;

  select count(*) into n from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'families'
     and grantee = 'authenticated' and privilege_type = 'UPDATE'
     and column_name in ('name','address','timezone','cover_url');
  if n <> 4 then
    raise exception '0300: the family profile lost its write grant (% of 4 columns)', n;
  end if;
  raise notice '0300 entitlement grants OK';
end $$;
