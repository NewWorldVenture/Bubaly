-- A marketplace review needs a completed exchange the reviewer was party to;
-- members do not create or delete orders (0333).
--
-- As TEEN A: filing a 'completed' order, rating sibling C on an order A was
-- not part of, rating the seller on an order that is not completed, and
-- editing or deleting an existing review must be refused. Control: A (the
-- buyer) reviews the seller on A's completed order.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000ee01';
  uPar uuid := '00000000-0000-4000-8000-00000000ee0a';
  uA uuid := '00000000-0000-4000-8000-00000000ee0b';
  uB uuid := '00000000-0000-4000-8000-00000000ee0c';
  uC uuid := '00000000-0000-4000-8000-00000000ee0d';
  mA uuid; mB uuid; mC uuid; listing uuid; done uuid; open uuid; other uuid; rev uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'rev-parent@example.com'), (uA, 'rev-a@example.com'), (uB, 'rev-b@example.com'), (uC, 'rev-c@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Review family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uA, 'A', 'teen', true) returning id into mA;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uB, 'B', 'teen', true) returning id into mB;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uC, 'C', 'child', true) returning id into mC;
  insert into public.marketplace_listings (family_id, title) values (fam, 'Skates') returning id into listing;
  insert into public.marketplace_orders (family_id, listing_id, buyer_member, seller_member, kind, status)
    values (fam, listing, mA, mB, 'buy', 'completed') returning id into done;
  insert into public.marketplace_orders (family_id, listing_id, buyer_member, seller_member, kind, status)
    values (fam, listing, mA, mB, 'buy', 'confirmed') returning id into open;
  insert into public.marketplace_orders (family_id, listing_id, buyer_member, seller_member, kind, status)
    values (fam, listing, mB, mC, 'buy', 'completed') returning id into other;
  insert into public.marketplace_reviews (family_id, order_id, listing_id, reviewer_member, reviewee_member, role, rating)
    values (fam, other, listing, mB, mC, 'buyer', 5) returning id into rev;

  perform set_config('request.jwt.claim.sub', uA::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uA, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.marketplace_orders (family_id, listing_id, buyer_member, seller_member, kind, status)
      values (fam, listing, mA, mC, 'buy', 'completed');
    raise warning 'BREACH: a member filed a completed order'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.marketplace_reviews (family_id, order_id, listing_id, reviewer_member, reviewee_member, role, rating)
      values (fam, other, listing, mA, mC, 'buyer', 1);
    raise warning 'BREACH: a member rated someone on an order they were not part of'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.marketplace_reviews (family_id, order_id, listing_id, reviewer_member, reviewee_member, role, rating)
      values (fam, open, listing, mA, mB, 'buyer', 1);
    raise warning 'BREACH: a member reviewed an exchange that is not completed'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  update public.marketplace_reviews set rating = 1 where id = rev;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a member edited someone else''s review (rows: %)', n; failures := failures + 1; end if;
  delete from public.marketplace_reviews where id = rev;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a member deleted someone else''s review (rows: %)', n; failures := failures + 1; end if;
  insert into public.marketplace_reviews (family_id, order_id, listing_id, reviewer_member, reviewee_member, role, rating)
    values (fam, done, listing, mA, mB, 'buyer', 4);
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: the buyer could not review their completed exchange (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uA, uB, uC);

  if failures > 0 then
    raise exception 'marketplace-review-check: % failure(s)', failures;
  end if;
end
$probe$;
