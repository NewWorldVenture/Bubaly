-- The marketplace RPCs nobody was calling.
--
-- `marketplace_create_circle` was dead from 0176 to 0318 — `security definer`
-- pinned to `search_path = public` while calling `gen_random_bytes`, which lives
-- in `extensions`, so every call raised 42883 and no family ever made a sharing
-- circle. A probe DID call it, and passed anyway, because CI's pgcrypto sat in
-- `public` (TEST-007).
--
-- Fixing that raised the obvious question: which other RPCs does the product
-- call that nothing exercises? Cross-referencing the 38 `.rpc(` names in the
-- application against `docs/audit/*.sql` and `tests/` left five, and three were
-- in this same family:
--
--   marketplace_leave_circle
--   marketplace_negotiation_offer
--   marketplace_negotiation_respond
--
-- All three turned out to work. That is worth having proved rather than
-- assumed, and worth keeping proved — an untested RPC is exactly where the last
-- dead feature was hiding, and the reason it stayed hidden for so long is that
-- nothing walked the path end to end on a production-shaped database.
--
-- ── the controls matter more than usual here ───────────────────────────────
--
-- Both negotiation functions authorise through `marketplace_member_id(family)`,
-- which resolves `auth.uid()`. A first run of this flow reported
-- `not_authorized` and looked like a real finding; the arguments were simply
-- passed in the wrong order — the signature is
-- `(p_listing, p_buyer_member, p_buyer_family, …)`, member BEFORE family, and
-- the application is immune because it calls by name. So the impersonation is
-- asserted to have taken, and `marketplace_member_id` is asserted to resolve to
-- the member being passed, before any result is believed.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fs  uuid := '00000000-0000-4000-8000-00000000e601';
  fb  uuid := '00000000-0000-4000-8000-00000000e602';
  us  uuid := '00000000-0000-4000-8000-00000000e6a1';
  ub  uuid := '00000000-0000-4000-8000-00000000e6a2';
  ms uuid; mb uuid; lst uuid; negid uuid; circ uuid; code text;
  res jsonb; st text; amt bigint; n int;
  failures int := 0;
begin
  -- Repeatable: this probe owns both families and nothing outside them.
  delete from public.families where id in (fs, fb);
  insert into auth.users (id, email) values (us,'mkt-seller@example.com'), (ub,'mkt-buyer@example.com')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fs,'Marketplace Seller',us), (fb,'Marketplace Buyer',ub);

  -- The creator's membership is NOT inserted here. `on_family_created` fires
  -- `handle_new_family`, which adds it — an earlier draft inserted it too and
  -- died on `family_members_family_id_user_id_key`. Upsert instead of insert,
  -- so the probe states the role it needs without fighting the trigger for it.
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fs,us,'Seller','parent',true), (fb,ub,'Buyer','parent',true)
  on conflict (family_id, user_id) do update
    set display_name = excluded.display_name, role = excluded.role, is_active = true;
  select id into ms from public.family_members where family_id=fs and user_id=us;
  select id into mb from public.family_members where family_id=fb and user_id=ub;
  if ms is null or mb is null then
    raise exception 'CONTROL FAILED: the probe could not establish both members (seller=%, buyer=%)', ms, mb;
  end if;

  insert into public.marketplace_listings (family_id, member_id, title, kind, status, price_cents)
    values (fs, ms, 'Bike', 'sell', 'available', 10000) returning id into lst;

  -- ── become the buyer, and prove it took ─────────────────────────────────
  perform set_config('request.jwt.claim.sub', ub::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', ub::text)::text, true);
  if auth.uid() is distinct from ub then
    raise exception 'CONTROL FAILED: auth.uid() is %, expected the buyer — every result below would be vacuous', auth.uid();
  end if;
  if public.marketplace_member_id(fb) is distinct from mb then
    raise exception 'CONTROL FAILED: marketplace_member_id resolves to %, not the buyer member %', public.marketplace_member_id(fb), mb;
  end if;

  -- 1. An offer below the ask opens a negotiation.
  res := public.marketplace_negotiation_offer(lst, mb, fb, 8000, 'would you take 80?');
  if (res->>'ok')::boolean is not true then
    raise warning 'BREACH: a buyer could not make an offer (%)', res;
    failures := failures + 1;
  end if;
  select id, status, current_amount_cents into negid, st, amt
    from public.marketplace_negotiations where listing_id = lst;
  if negid is null or st is distinct from 'open' or amt is distinct from 8000 then
    raise warning 'BREACH: the offer reported ok but the negotiation row is status=% amount=%', st, amt;
    failures := failures + 1;
  end if;

  -- 2. An offer AT or ABOVE the ask is refused — that is a purchase, not a bid.
  res := public.marketplace_negotiation_offer(lst, mb, fb, 10000, null);
  if res->>'reason' is distinct from 'at_or_above_ask' and res->>'reason' is distinct from 'not_your_turn' then
    raise warning 'BREACH: an offer at the asking price was not refused (%)', res;
    failures := failures + 1;
  end if;

  -- 3. It is not the buyer's turn until the seller answers.
  res := public.marketplace_negotiation_offer(lst, mb, fb, 8500, null);
  if res->>'reason' is distinct from 'not_your_turn' then
    raise warning 'BREACH: the buyer countered their own offer (%)', res;
    failures := failures + 1;
  end if;

  -- ── the seller answers ──────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', us::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', us::text)::text, true);
  res := public.marketplace_negotiation_respond(negid, 'counter', 9000, 'meet at 90?');
  if (res->>'ok')::boolean is not true then
    raise warning 'BREACH: the seller could not counter (%)', res;
    failures := failures + 1;
  end if;
  select current_amount_cents into amt from public.marketplace_negotiations where id = negid;
  if amt is distinct from 9000 then
    raise warning 'BREACH: the counter reported ok but the amount is %', amt;
    failures := failures + 1;
  end if;

  -- ── the buyer accepts, and an order appears ─────────────────────────────
  perform set_config('request.jwt.claim.sub', ub::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', ub::text)::text, true);
  res := public.marketplace_negotiation_respond(negid, 'accept', null, null);
  if (res->>'ok')::boolean is not true or res->>'order_id' is null then
    raise warning 'BREACH: accepting produced no order (%)', res;
    failures := failures + 1;
  end if;
  select status, agreed_amount_cents into st, amt from public.marketplace_negotiations where id = negid;
  if st is distinct from 'agreed' or amt is distinct from 9000 then
    raise warning 'BREACH: after acceptance the negotiation is status=% agreed=%, expected agreed/9000', st, amt;
    failures := failures + 1;
  end if;
  -- The price agreed is the price countered, not the price first offered. A
  -- fix that carried the opening bid through would still report ok here.
  select status into st from public.marketplace_listings where id = lst;
  if st is distinct from 'claimed' then
    raise warning 'BREACH: the listing is % after an agreed negotiation, expected claimed', st;
    failures := failures + 1;
  end if;

  -- ── circles: create, join, leave ────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', us::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', us::text)::text, true);
  circ := public.marketplace_create_circle(fs, 'Neighbours', '🤝');
  select join_code into code from public.marketplace_circles where id = circ;
  if code is null or code ~ '[01OI]' then
    raise warning 'BREACH: the join code % is missing or carries an ambiguous character', code;
    failures := failures + 1;
  end if;

  perform set_config('request.jwt.claim.sub', ub::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', ub::text)::text, true);
  if public.marketplace_join_circle(fb, code) is distinct from circ then
    raise warning 'BREACH: joining by code did not land in the circle that issued it';
    failures := failures + 1;
  end if;
  select count(*) into n from public.marketplace_circle_members where circle_id = circ;
  if n <> 2 then
    raise warning 'BREACH: the circle holds % member families after a join, expected 2', n;
    failures := failures + 1;
  end if;

  perform public.marketplace_leave_circle(fb, circ);
  select count(*) into n from public.marketplace_circle_members where circle_id = circ;
  if n <> 1 then
    raise warning 'BREACH: the circle holds % member families after a leave, expected 1', n;
    failures := failures + 1;
  end if;

  reset role;
  delete from public.families where id in (fs, fb);
  delete from auth.users where id in (us, ub);

  if failures > 0 then
    raise exception 'marketplace-rpc-liveness: % assertion(s) failed', failures;
  end if;
  raise notice 'marketplace-rpc-liveness: OK — offer, counter, accept with an order, and circle create/join/leave all complete';
end
$probe$;
