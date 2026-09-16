-- Behavioural proof for 0322, run as a real `authenticated` session under RLS.
--
-- `subscriptions` is the paywall: lib/server/plan.ts reads it with the SERVICE
-- ROLE, deliberately, so whatever is in the row IS the entitlement. 0004's
-- `subs_manage` granted ALL of it to `is_family_admin` — the parent being
-- charged. `families_update` had no column restriction while that same trusted
-- read takes `trial_ends_at` and `closed_at` from the row. And a self-written
-- `billing_customers.customer_ref` is handed to Stripe's billing portal with no
-- ownership check, which is the cross-tenant one.
--
-- Each refusal is followed by a RE-READ of the stored value, so the probe cannot
-- pass on a row that merely went unmatched.
--
-- What a manager may STILL do is asserted alongside what they may not: read
-- their own subscription and billing customer, and rename their own family.
-- A guard that broke those would stop the product working.
grant usage on schema public to authenticated;
-- No blanket `grant ... on all tables in schema public` here. The bootstrap's
-- `alter default privileges` already gives `authenticated` full DML on every
-- table a migration creates, so the restatement was redundant — and once
-- migrations began revoking DML deliberately (0300 takes the paywall columns
-- away from the client), it stopped being redundant and started undoing them
-- for every probe that runs after this one against the shared database.

do $$
declare
  fam        uuid := 'dddd3333-0000-4000-8000-00000000000d';
  other      uuid := 'dddd4444-0000-4000-8000-00000000000d';
  parent_uid uuid := 'd3000000-0000-4000-8000-000000000001';
  blocked    boolean;
  n          int;
  v_plan     text;
  v_trial    timestamptz;
  v_closed   timestamptz;
  v_ref      text;
  v_name     text;
begin
  -- Re-runnable against a database that already holds a previous run's rows.
  delete from public.subscriptions where family_id in (fam, other);
  delete from public.billing_customers where family_id in (fam, other);
  delete from public.family_members where user_id = parent_uid;
  delete from public.families where id in (fam, other);

  insert into public.families (id, name) values (fam, 'Payer'), (other, 'Neighbour');
  insert into auth.users (id, email) values (parent_uid, 'dp@example.test') on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, parent_uid, 'Parent', 'parent', true);
  -- The neighbour's Stripe customer, as the service role would have written it.
  insert into public.billing_customers (family_id, provider, customer_ref)
  values (other, 'stripe', 'cus_NEIGHBOUR');
  -- handle_new_family seeds a free trialing subscription row; pin it flat, with
  -- the trial already expired — the state a family has the most motive to edit.
  update public.subscriptions set plan = 'free', status = 'trialing' where family_id = fam;
  update public.families set trial_ends_at = now() - interval '1 day' where id = fam;
  -- CLOSED, so that "clear closed_at" below is a real change rather than a
  -- NULL-to-NULL no-op. The first draft of this probe set nothing here and
  -- passed the clear for that reason alone; `is distinct from` is not violated
  -- by writing the value a column already holds.
  update public.families set closed_at = now() - interval '1 hour' where id = fam;

  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;

  -- ── Positive controls: RLS is live and the product still works ───────────
  select plan into v_plan from public.subscriptions where family_id = fam;
  if v_plan is null then
    raise exception 'a parent can no longer read their own subscription';
  end if;
  select customer_ref into v_ref from public.billing_customers where family_id = fam;
  if v_ref is not null then
    raise exception 'setup error: this family should have no billing customer yet';
  end if;
  update public.families set name = 'Payer Household' where id = fam;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a parent can no longer rename their own family (%)', n;
  end if;
  -- The neighbour's billing row was never theirs to see.
  select count(*) into n from public.billing_customers where family_id = other;
  if n <> 0 then
    raise exception 'RLS is not live: another family''s billing row is visible';
  end if;

  -- ── 1. Cannot self-grant a paid plan. Before 0322 this was UPDATE 1. ─────
  blocked := false;
  begin
    update public.subscriptions
       set plan = 'family_plus', status = 'active',
           current_period_end = now() + interval '3650 days'
     where family_id = fam;
    get diagnostics n = row_count;
    if n = 0 then blocked := true; end if;
  exception when insufficient_privilege or others then
    blocked := true;
  end;
  if not blocked then
    raise exception 'a parent granted their own family a paid plan';
  end if;
  select plan into v_plan from public.subscriptions where family_id = fam;
  if v_plan is distinct from 'free' then
    raise exception 'the subscription plan was rewritten despite the refusal (now %)', v_plan;
  end if;

  -- ── 2. Cannot insert a second, richer subscription row either ────────────
  blocked := false;
  begin
    insert into public.subscriptions (family_id, plan, status)
    values (fam, 'family_plus', 'active');
    blocked := false;
  exception when others then
    blocked := true;
  end;
  if not blocked then
    raise exception 'a parent inserted a paid subscription row for their own family';
  end if;

  -- ── 3. Cannot extend the trial, and cannot NULL it ───────────────────────
  --     NULL is the sharper attack: computeEntitlement reads it as
  --     "grandfathered, never locked".
  blocked := false;
  begin
    update public.families set trial_ends_at = now() + interval '3650 days' where id = fam;
    get diagnostics n = row_count;
    if n = 0 then blocked := true; end if;
  exception when others then
    blocked := true;
  end;
  if not blocked then
    raise exception 'a parent extended their own free trial';
  end if;

  blocked := false;
  begin
    update public.families set trial_ends_at = null where id = fam;
    get diagnostics n = row_count;
    if n = 0 then blocked := true; end if;
  exception when others then
    blocked := true;
  end;
  if not blocked then
    raise exception 'a parent grandfathered their own family out of the paywall';
  end if;
  select trial_ends_at into v_trial from public.families where id = fam;
  if v_trial is null or v_trial > now() then
    raise exception 'trial_ends_at was rewritten despite the refusal (now %)', v_trial;
  end if;

  -- ── 4. Cannot reopen a closed account by clearing closed_at ──────────────
  --     The family IS closed in setup above, so this is a real transition.
  --     closeAccountAction and reopenAccountAction both go through the service
  --     role already, so nothing legitimate is lost by refusing it here.
  blocked := false;
  begin
    update public.families set closed_at = null where id = fam;
    get diagnostics n = row_count;
    if n = 0 then blocked := true; end if;
  exception when others then
    blocked := true;
  end;
  if not blocked then
    raise exception 'a parent reopened their own closed account';
  end if;
  select closed_at into v_closed from public.families where id = fam;
  if v_closed is null then
    raise exception 'closed_at was cleared despite the refusal';
  end if;

  -- ── 5. Cannot point their billing row at another family's Stripe customer ─
  --     This is the cross-tenant one: /api/billing/portal hands customer_ref
  --     straight to stripe.billingPortal.sessions.create({ customer }).
  blocked := false;
  begin
    insert into public.billing_customers (family_id, provider, customer_ref)
    values (fam, 'stripe', 'cus_NEIGHBOUR');
    blocked := false;
  exception when others then
    blocked := true;
  end;
  if not blocked then
    raise exception 'a parent claimed another family''s Stripe customer';
  end if;
  select customer_ref into v_ref from public.billing_customers where family_id = fam;
  if v_ref is not null then
    raise exception 'a billing customer row was written despite the refusal (%)', v_ref;
  end if;
  -- And the neighbour's own row is untouched. Read as the superuser, which sees
  -- past RLS — the point is the stored bytes, not who can see them.
  reset role;
  select customer_ref into v_ref from public.billing_customers where family_id = other;
  if v_ref is distinct from 'cus_NEIGHBOUR' then
    raise exception 'the neighbour''s customer_ref changed (now %)', coalesce(v_ref, '<null>');
  end if;

  -- ── 6. The trusted server is NOT locked out ──────────────────────────────
  --     Every legitimate writer is the service role; if this failed, the Stripe
  --     webhook could no longer record a plan the family actually paid for, and
  --     closeAccountAction could no longer close an account.
  --
  --     `reset role` alone is NOT the service role: the JWT claim set above
  --     survives it, so auth.uid() still answers and the trigger still treats
  --     the writer as that parent. Clear the claim and take the role the app's
  --     service client actually connects as.
  perform set_config('request.jwt.claim.sub', '', true);
  set local role service_role;

  update public.subscriptions set plan = 'family_plus', status = 'active' where family_id = fam;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'the trusted server can no longer record a paid plan (%)', n;
  end if;
  update public.families set closed_at = null where id = fam;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'the trusted server can no longer reopen an account (%)', n;
  end if;
  select closed_at into v_closed from public.families where id = fam;
  if v_closed is not null then
    raise exception 'the trusted server''s reopen did not take';
  end if;
  update public.families set closed_at = now() where id = fam;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'the trusted server can no longer close an account (%)', n;
  end if;
  insert into public.billing_customers (family_id, provider, customer_ref)
  values (fam, 'stripe', 'cus_OWN');
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'the trusted server can no longer record a billing customer (%)', n;
  end if;

  -- The parent's own rename in the positive control survived all of this.
  select name into v_name from public.families where id = fam;
  if v_name is distinct from 'Payer Household' then
    raise exception 'the parent''s legitimate rename was lost (now %)', v_name;
  end if;

  raise notice 'paywall-write-boundary-check OK: the entitlement row is the server''s to write, and the server can still write it';
end $$;
