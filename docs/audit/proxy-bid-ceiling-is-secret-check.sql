-- A proxy bid's ceiling is secret. (SEC-016, migration 0328)
--
-- In a proxy auction the leader's maximum is the one thing the mechanism
-- depends on nobody knowing. Before 0328 every rival in a sharing circle could
-- select `highest_max_cents` (and the "hidden floor" `reserve_cents`), and the
-- seller could select every bidder's `max_cents`. A rival who bids exactly the
-- leader's ceiling lands in the engine's "does not beat the standing proxy"
-- branch, which sets the price to that ceiling: measured over PostgREST, a
-- $10.00 auction went to $500.00, the leader's whole maximum, without the rival
-- ever leading.
--
--   rival reads highest_max_cents / reserve_cents  -> REFUSED
--   seller reads a bidder's max_cents              -> REFUSED
--   rival reads what the UI shows (price, reserve_met) -> allowed  (control)
--   the bid engine still runs a proxy auction      -> allowed  (control)
--
-- And structurally, because a column grant does not extend to columns added
-- later: every OTHER column of both tables must stay selectable. A future
-- migration that adds a column and forgets its grant fails here, not in a
-- user's browser as 42501.
--
-- Rolled back: nothing here should outlive the assertion.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

do $probe$
declare
  secrets  text[] := array['reserve_cents', 'highest_max_cents', 'max_cents'];
  missing  text;
  leaked   text;
  seller   uuid := '00000000-0000-4000-8000-00000000b501';
  alice    uuid := '00000000-0000-4000-8000-00000000b502';
  bob      uuid := '00000000-0000-4000-8000-00000000b503';
  fam_s    uuid := '00000000-0000-4000-8000-00000000b511';
  fam_a    uuid := '00000000-0000-4000-8000-00000000b512';
  fam_b    uuid := '00000000-0000-4000-8000-00000000b513';
  mem_s    uuid;
  mem_a    uuid;
  mem_b    uuid;
  circle   uuid := '00000000-0000-4000-8000-00000000b521';
  listing  uuid := '00000000-0000-4000-8000-00000000b531';
  res      jsonb;
  v_big    bigint;
  v_bool   boolean;
  n        int;
  failures int := 0;
begin
  -- ── 0. structure: the secrets are the ONLY columns withheld ─────────────
  select string_agg(format('%s.%s for %s', c.relname, a.attname, r.role), ', ')
    into leaked
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname = 'public'
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
   cross join (values ('anon'), ('authenticated')) r(role)
   where c.relname in ('marketplace_listings', 'marketplace_bids')
     and a.attname = any (secrets)
     and has_column_privilege(r.role, c.oid, a.attname, 'SELECT');
  if leaked is not null then
    raise warning 'BREACH: secret auction columns are client-selectable: %', leaked;
    failures := failures + 1;
  end if;

  select string_agg(format('%s.%s', c.relname, a.attname), ', ')
    into missing
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname = 'public'
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
   where c.relname in ('marketplace_listings', 'marketplace_bids')
     and a.attname <> all (secrets)
     and not has_column_privilege('authenticated', c.oid, a.attname, 'SELECT');
  if missing is not null then
    raise warning 'REGRESSION: ordinary columns are not selectable (a new column needs its grant — see 0328): %', missing;
    failures := failures + 1;
  end if;

  -- ── fixture: a seller, two bidders, one circle, one auction ─────────────
  insert into auth.users (id, email) values
    (seller, 'auction-seller@example.test'), (alice, 'auction-alice@example.test'), (bob, 'auction-bob@example.test')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values
    (fam_s, 'Seller', seller), (fam_a, 'Alice', alice), (fam_b, 'Bob', bob)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam_s, seller, 'Seller', 'parent', true), (fam_a, alice, 'Alice', 'parent', true), (fam_b, bob, 'Bob', 'parent', true)
  on conflict (family_id, user_id) do update set is_active = true;
  select id into mem_s from public.family_members where family_id = fam_s and user_id = seller;
  select id into mem_a from public.family_members where family_id = fam_a and user_id = alice;
  select id into mem_b from public.family_members where family_id = fam_b and user_id = bob;

  insert into public.marketplace_circles (id, name, join_code, created_by_family, created_by)
    values (circle, 'Maple Street', 'PRBEB5C1', fam_s, seller);
  insert into public.marketplace_circle_members (circle_id, family_id, family_name, role) values
    (circle, fam_s, 'Seller', 'owner'), (circle, fam_a, 'Alice', 'member'), (circle, fam_b, 'Bob', 'member');
  insert into public.marketplace_listings (id, family_id, member_id, created_by, title, kind, status,
      sale_format, starting_bid_cents, reserve_cents, auction_ends_at)
    values (listing, fam_s, mem_s, seller, 'Road bike', 'sell', 'available',
      'auction', 1000, 20000, now() + interval '1 day');
  insert into public.marketplace_listing_shares (listing_id, circle_id, family_id) values (listing, circle, fam_s);

  -- ── 1. Alice bids "up to $500" through the real RPC ─────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', alice::text)::text, true);
  set local role authenticated;
  res := public.marketplace_place_bid(listing, mem_a, fam_a, 50000);
  if coalesce((res ->> 'ok')::boolean, false) is not true or (res ->> 'leading')::boolean is not true then
    raise warning 'CONTROL FAILED: the bid engine did not accept the leading bid: %', res;
    failures := failures + 1;
  end if;

  -- ── 2. Bob, a rival in the circle ───────────────────────────────────────
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', bob::text)::text, true);
  set local role authenticated;
  select count(*) into n from public.marketplace_listings where id = listing;
  if n <> 1 then
    raise warning 'CONTROL FAILED: the rival cannot see the shared listing at all, so a refusal below proves nothing';
    failures := failures + 1;
  end if;
  begin
    select highest_max_cents into v_big from public.marketplace_listings where id = listing;
    raise warning 'BREACH: a rival read the leader''s proxy ceiling (%)', v_big;
    failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  begin
    select reserve_cents into v_big from public.marketplace_listings where id = listing;
    raise warning 'BREACH: a rival read the hidden reserve (%)', v_big;
    failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  begin
    select reserve_met into v_bool from public.marketplace_listings where id = listing;
    if v_bool is distinct from false then
      raise warning 'CONTROL FAILED: reserve_met should be false at $10 against a $200 reserve (got %)', v_bool;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then
    raise warning 'CONTROL FAILED: the rival cannot read reserve_met — the fix took the reserve badge away';
    failures := failures + 1;
  end;
  -- Blind now, Bob bids $300: the ordinary proxy outcome, price one increment over.
  res := public.marketplace_place_bid(listing, mem_b, fam_b, 30000);
  if (res ->> 'ok')::boolean is not true or (res ->> 'leading')::boolean is not false or (res ->> 'current_cents')::bigint <> 30050 then
    raise warning 'CONTROL FAILED: the proxy engine did not auto-cover a lower bid as before: %', res;
    failures := failures + 1;
  end if;

  -- ── 3. the seller, reading the bid table ────────────────────────────────
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', seller::text)::text, true);
  set local role authenticated;
  select count(*) into n from public.marketplace_bids where listing_id = listing;
  if n < 2 then
    raise warning 'CONTROL FAILED: the seller cannot see the bid history (rows: %)', n;
    failures := failures + 1;
  end if;
  begin
    select max(max_cents) into v_big from public.marketplace_bids where listing_id = listing;
    raise warning 'BREACH: the seller read the bidders'' maxima (%)', v_big;
    failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  begin
    select reserve_met into v_bool from public.marketplace_listings where id = listing;
    if v_bool is distinct from true then
      raise warning 'CONTROL FAILED: reserve_met should be true at $300.50 against a $200 reserve (got %)', v_bool;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then
    raise warning 'CONTROL FAILED: the seller cannot read reserve_met on their own listing';
    failures := failures + 1;
  end;

  reset role;
  if failures > 0 then
    raise exception 'a proxy bid''s ceiling is not secret: % finding(s)', failures;
  end if;
  raise notice 'OK: rivals and sellers cannot read ceilings, reserves or maxima; the engine, the history and the reserve badge still work.';
end
$probe$;

rollback;
