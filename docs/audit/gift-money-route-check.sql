-- Can a child redirect gift money to themselves before a parent approves it?
--
-- wallet_approve_gift credits a pending gift_payments row's child_wallet_id with
-- its amount_cents, as stored; pay_handles and gift_links bind public payment
-- routes to a child's wallet. All three were member FOR ALL. 0324 makes them
-- members-read, managers-write.
--
-- As SIBLING A: repointing B's pending gift or Pay-ID at A's own wallet, raising
-- the amount, and inserting a fake pledge must all be refused (UPDATE/DELETE
-- match zero rows; INSERT raises). A can still read them (control). As the
-- PARENT: approving the untouched gift credits B, the intended child (control).
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam    uuid := '00000000-0000-4000-8000-00000000ed71';
  uPar   uuid := '00000000-0000-4000-8000-00000000ed7a';
  uA     uuid := '00000000-0000-4000-8000-00000000ed7b';
  uB     uuid := '00000000-0000-4000-8000-00000000ed7c';
  mA uuid; mB uuid; wA uuid; wB uuid; gift uuid; payId uuid;
  n int; approved jsonb; creditedTo uuid; failures int := 0;
begin
  delete from public.wallet_transactions where family_id = fam;
  delete from public.wallet_buckets where family_id = fam;
  delete from public.gift_payments where family_id = fam;
  delete from public.pay_handles where family_id = fam;
  delete from public.child_wallets where family_id = fam;
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'gift-parent@example.com'), (uA, 'gift-a@example.com'), (uB, 'gift-b@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Gift family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uA, 'Sibling A', 'child', true) returning id into mA;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uB, 'Sibling B', 'child', true) returning id into mB;
  insert into public.child_wallets (family_id, member_id) values (fam, mA) returning id into wA;
  insert into public.child_wallets (family_id, member_id) values (fam, mB) returning id into wB;
  insert into public.wallet_buckets (family_id, child_wallet_id, kind, label) values
    (fam, wB, 'spend', 'Spend'), (fam, wB, 'save', 'Save'), (fam, wB, 'give', 'Give'), (fam, wB, 'invest', 'Invest');
  insert into public.gift_payments (family_id, child_wallet_id, giver_name, amount_cents, status)
    values (fam, wB, 'Grandma', 2500, 'pending') returning id into gift;
  insert into public.pay_handles (family_id, child_wallet_id, handle, is_active)
    values (fam, wB, 'sibling_b_probe', true) returning id into payId;

  -- ── as SIBLING A ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uA::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uA, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.gift_payments where id = gift;
  if n <> 1 then raise warning 'CONTROL FAILED: a child cannot see the family''s gifts (%)', n; failures := failures + 1; end if;

  update public.gift_payments set child_wallet_id = wA where id = gift;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child redirected a sibling''s pending gift to themselves (rows: %)', n; failures := failures + 1; end if;

  update public.gift_payments set amount_cents = 250000 where id = gift;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child raised a pending gift''s amount (rows: %)', n; failures := failures + 1; end if;

  begin
    insert into public.gift_payments (family_id, child_wallet_id, giver_name, amount_cents, status)
      values (fam, wA, 'Grandma', 50000, 'pending');
    raise warning 'BREACH: a child filed a pledge that never happened'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;

  update public.pay_handles set child_wallet_id = wA where id = payId;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child repointed a sibling''s Pay-ID at themselves (rows: %)', n; failures := failures + 1; end if;

  begin
    insert into public.gift_links (family_id, child_wallet_id, token) values (fam, wA, 'forged-probe-token');
    raise warning 'BREACH: a child created a public gift link'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- ── as the PARENT: approving the untouched gift credits sibling B ─────────
  perform set_config('request.jwt.claim.sub', uPar::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uPar, 'role', 'authenticated')::text, true);
  set local role authenticated;
  approved := public.wallet_approve_gift(fam, gift, uPar);
  reset role;
  select child_wallet_id into creditedTo from public.wallet_transactions where id = (approved->>'transaction_id')::uuid;
  if coalesce((approved->>'ok')::boolean, false) is not true or creditedTo is distinct from wB then
    raise warning 'CONTROL FAILED: approving the gift did not credit the intended child (%, credited %)', approved, creditedTo;
    failures := failures + 1;
  end if;

  delete from public.wallet_transactions where family_id = fam;
  delete from public.wallet_audit_logs where family_id = fam;
  delete from public.wallet_buckets where family_id = fam;
  delete from public.gift_payments where family_id = fam;
  delete from public.pay_handles where family_id = fam;
  delete from public.child_wallets where family_id = fam;
  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uA, uB);

  if failures > 0 then
    raise exception 'gift-money-route-check: % failure(s)', failures;
  end if;
end
$probe$;
