-- One item cannot be sold to two families.
--
-- `marketplace_accept_offer` checked that the OFFER was still open and that the
-- caller owned the listing — but never that the LISTING was still available.
-- The guard was on the piece of paper, not on the thing being sold. Nothing
-- stops a second offer against a claimed listing (a backup offer is reasonable),
-- so accepting one created a second confirmed order for the same item:
--
--   accepted buyer one -> listing=claimed, orders=1
--   accepted buyer two -> listing=claimed, orders=2
--                         (Buyer one @40, Buyer two @45)
--
-- No concurrency is needed to reach it, which is why this probe does not
-- simulate any. `claimed_by` was rewritten to the second buyer while the first
-- kept a confirmed order.
--
-- Judged on ORDER COUNTS, not exceptions: the old code raised nothing at all.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam    uuid := '00000000-0000-4000-8000-0000000c5a01';
  u      uuid := '00000000-0000-4000-8000-0000000c5a0a';
  seller uuid; b1 uuid; b2 uuid;
  listing uuid; off1 uuid; off2 uuid; spare uuid; ord uuid;
  n int; st text; claimant uuid;
  failures int := 0;
begin
  delete from public.marketplace_orders where family_id = fam;
  delete from public.marketplace_offers where family_id = fam;
  delete from public.marketplace_listings where family_id = fam;
  delete from public.family_members where family_id = fam and user_id is null;

  insert into auth.users (id, email) values (u, 'listing-claim@example.com') on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Claim family', u) on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, u, 'Seller', 'parent', true) on conflict do nothing;
  select id into seller from public.family_members where family_id = fam and user_id = u;
  insert into public.family_members (family_id, display_name, role, is_active)
    values (fam, 'Buyer one', 'adult', true) returning id into b1;
  insert into public.family_members (family_id, display_name, role, is_active)
    values (fam, 'Buyer two', 'adult', true) returning id into b2;

  insert into public.marketplace_listings (family_id, member_id, title, kind, price_cents, status)
    values (fam, seller, 'Balance bike', 'sell', 4000, 'available') returning id into listing;
  -- A spare listing, so the positive control below is not measured against the
  -- same row the breach case has already claimed.
  insert into public.marketplace_listings (family_id, member_id, title, kind, price_cents, status)
    values (fam, seller, 'Spare listing', 'sell', 1000, 'available') returning id into spare;

  insert into public.marketplace_offers (family_id, listing_id, member_id, kind, status, amount_cents)
    values (fam, listing, b1, 'offer', 'open', 4000) returning id into off1;

  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;

  -- 1. Positive control: the first sale still works. A guard that simply broke
  --    accepting would pass every assertion below and be worthless.
  begin
    select public.marketplace_accept_offer(off1) into ord;
    if ord is null then
      raise warning 'CONTROL FAILED: accepting the first offer returned no order';
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: the owner could not accept the first offer (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  select status into st from public.marketplace_listings where id = listing;
  if st <> 'claimed' then
    raise warning 'CONTROL FAILED: the listing was not claimed by the first accept (status %)', st;
    failures := failures + 1;
  end if;

  -- 2. A second offer may still be made on a claimed listing — that is a backup
  --    offer, and it is deliberately still allowed. Asserted so the fix is not
  --    quietly widened into forbidding it.
  reset role;
  insert into public.marketplace_offers (family_id, listing_id, member_id, kind, status, amount_cents)
    values (fam, listing, b2, 'offer', 'open', 4500) returning id into off2;
  if off2 is null then
    raise warning 'CONTROL FAILED: a backup offer on a claimed listing was refused';
    failures := failures + 1;
  end if;

  -- 3. But accepting it must not sell the bike twice.
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
  begin
    perform public.marketplace_accept_offer(off2);
  exception when others then null;
  end;

  select count(*) into n from public.marketplace_orders where listing_id = listing;
  if n <> 1 then
    raise warning 'BREACH: % confirmed order(s) for one listing (%)', n,
      (select string_agg(m.display_name, ' + ') from public.marketplace_orders o
        join public.family_members m on m.id = o.buyer_member where o.listing_id = listing);
    failures := failures + 1;
  end if;

  -- 4. And the first buyer must still be the claimant.
  select claimed_by into claimant from public.marketplace_listings where id = listing;
  if claimant is distinct from b1 then
    raise warning 'BREACH: claimed_by was rewritten away from the first buyer';
    failures := failures + 1;
  end if;

  -- 5. Closing control: a different, still-available listing sells normally
  --    after all of the above, so none of this closed the feature.
  reset role;
  insert into public.marketplace_offers (family_id, listing_id, member_id, kind, status, amount_cents)
    values (fam, spare, b2, 'offer', 'open', 1000) returning id into off2;
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
  begin
    select public.marketplace_accept_offer(off2) into ord;
    if ord is null then
      raise warning 'CONTROL FAILED: a fresh listing could not be sold';
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a fresh listing could not be sold (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  reset role;
  perform set_config('request.jwt.claim.sub', '', true);

  delete from public.marketplace_orders where family_id = fam;
  delete from public.marketplace_offers where family_id = fam;
  delete from public.marketplace_listings where family_id = fam;
  delete from public.family_members where family_id = fam and user_id is null;

  if failures > 0 then
    raise exception '0315 FAILED: % assertion(s)', failures;
  end if;
  raise notice '0315 OK: a listing is claimed once (6 assertions)';
end
$probe$;
