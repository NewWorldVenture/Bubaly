-- A marketplace pickup is arranged by the two parties (0346).
--
-- Order between BUYER B and SELLER S. As SIBLING X: confirming the pickup
-- (and setting a code), cancelling it, and proposing a new one must be
-- refused. Control: B confirms.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000eed1';
  uPar uuid := '00000000-0000-4000-8000-00000000eeda';
  uS uuid := '00000000-0000-4000-8000-00000000eedb';
  uB uuid := '00000000-0000-4000-8000-00000000eedc';
  uX uuid := '00000000-0000-4000-8000-00000000eedd';
  mS uuid; mB uuid; listing uuid; ord uuid; ord2 uuid; h uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'h-parent@example.com'), (uS, 'h-s@example.com'), (uB, 'h-b@example.com'), (uX, 'h-x@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Handoff family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uS, 'S', 'teen', true) returning id into mS;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uB, 'B', 'teen', true) returning id into mB;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uX, 'X', 'child', true);
  insert into public.marketplace_listings (family_id, member_id, title) values (fam, mS, 'Bike') returning id into listing;
  insert into public.marketplace_orders (family_id, listing_id, buyer_member, seller_member, kind, status)
    values (fam, listing, mB, mS, 'buy', 'confirmed') returning id into ord;
  insert into public.marketplace_orders (family_id, listing_id, buyer_member, seller_member, kind, status)
    values (fam, listing, mB, mS, 'buy', 'confirmed') returning id into ord2;
  insert into public.marketplace_handoffs (order_id, family_id, listing_id, proposed_by, proposer_role, status, location_label)
    values (ord, fam, listing, mS, 'seller', 'proposed', 'Library') returning id into h;

  perform set_config('request.jwt.claim.sub', uX::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uX, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.marketplace_handoffs set status = 'confirmed', confirm_code = '1234' where id = h;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a non-party confirmed a pickup and set its code (rows: %)', n; failures := failures + 1; end if;
  update public.marketplace_handoffs set status = 'cancelled' where id = h;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a non-party cancelled a pickup (rows: %)', n; failures := failures + 1; end if;
  begin
    insert into public.marketplace_handoffs (order_id, family_id, listing_id, status, location_label)
      values (ord2, fam, listing, 'proposed', 'Dark alley');
    raise warning 'BREACH: a non-party proposed a pickup'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  reset role;

  perform set_config('request.jwt.claim.sub', uB::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uB, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.marketplace_handoffs set status = 'confirmed', confirm_code = '5678' where id = h;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: the buyer could not confirm (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uS, uB, uX);

  if failures > 0 then
    raise exception 'marketplace-handoff-check: % failure(s)', failures;
  end if;
end
$probe$;
