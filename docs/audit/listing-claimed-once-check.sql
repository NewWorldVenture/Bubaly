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
-- And because no concurrency is simulated, order counts alone cannot tell the
-- mechanism 0315 shipped (the status predicate IN the claiming UPDATE) from the
-- one 0315 rejects (the same test in an `if` above it) — sequentially they
-- behave identically. Step 6 therefore reads WHERE the predicate lives out of
-- the installed function, the way listing-status-machine-check does for 0317.
--
-- NEGATIVE CONTROL, and it runs FIRST, before the breach case it gives meaning to
-- ---------------------------------------------------------------------------
-- The rule under test today is 0315's, and 0315 is the LAST word on it.
-- `marketplace_accept_offer` is created in 0154, named only inside a comment in
-- 0186, and re-created by `0315_a_listing_is_claimed_once.sql`, which is what
-- put `and status in ('available','pending')` into the claiming UPDATE. Nothing
-- after 0315 in supabase/migrations names the function, or marketplace_orders,
-- at all — so there is no later definition to replay over this one. Two later
-- migrations DO touch marketplace_listings and are named here because they are
-- where a false verdict would come from: 0321 adds a plain index on
-- highest_bidder_family_id (nothing this probe writes), and
-- `0317_listing_status_decides_from_a_locked_row.sql` re-creates
-- `marketplace_set_listing_status`, the seller's state machine, which governs
-- the transitions this control uses to stage its listing (see below) and which
-- declares the direct transition claimed -> pending ILLEGAL. Outside
-- supabase/migrations, supabase/CATCH_UP_PROD.sql (the 0001..0159 catch-up,
-- which pg-bootstrap.sh never applies) still carries the PRE-0315 body as a
-- `create or replace` — its claim UPDATE reads `where id = v_listing.id;` with
-- no status predicate — so a hand replay of it over a 0315 database would
-- silently reinstall the double sale. This probe is what would notice: step 3
-- would count two orders and step 6 would report the predicate gone.
--
-- MECHANISM: not RLS, and this matters because the control has to be aimed at
-- the thing that actually says no. The function is SECURITY DEFINER, so it runs
-- as its owner and the policies on the three tables it writes —
-- marketplace_listings, marketplace_offers and marketplace_orders — are never
-- consulted. It is not a trigger either. Those three tables carry five, and
-- this is all of them (static `create trigger` and every `execute format`
-- trigger loop in supabase/migrations were both read; only 0120's and 0151's
-- loops name these tables): on marketplace_listings,
-- `set_marketplace_listings_updated` (0120's `execute format` loop — before
-- update, set_updated_at) and `trg_marketplace_log_price_change` (0191 —
-- `after update of price_cents`, only when the price really moves, and this
-- probe never moves a price); on marketplace_offers,
-- `set_marketplace_offers_updated` (the same 0120 loop) and
-- `trg_marketplace_offer_flip_pending` (0154 — after INSERT, and only `where
-- status = 'available'`, so it cannot lift a claimed listing back into range);
-- on marketplace_orders, `set_marketplace_orders_updated` (0151's `execute
-- format` loop) and nothing else. It is not a CHECK constraint, which could not
-- see whether another order already exists, and it is not a unique index: 0151
-- creates marketplace_orders with indexes on (family_id, status, created_at)
-- and (family_id, buyer_member), 0192 — the only later ALTER of that table —
-- adds its due index, and none of the three is unique; the primary key is the
-- only unique index on the table, on an id the database generates — which is
-- precisely the gap 0315's own header records. What refuses the second sale is
-- ONE predicate carried in the WHERE of the claiming UPDATE, whose zero-row
-- result raises 'This listing is no longer available'.
--
-- So the control is the same seller, through that same predicate, with the one
-- thing the predicate keys on — the listing's status — answered the other way:
-- accept a SECOND offer on a listing that has ALREADY been accepted once, after
-- putting that listing's status back into ('available','pending'). It is the
-- pre-0315 double sale, staged deliberately on the control's own listing, and
-- it MUST LAND — a second confirmed order for that listing and `claimed_by`
-- moved to the second buyer. Because the control calls the SAME RPC as the
-- write under test, it names the same columns by construction, so the
-- column-level dodge that matters in the RLS probes has nowhere to hide here.
--
-- HOW the status is put back matters. It is done through the product's own
-- state machine — the seller withdraws the claimed listing and relists it,
-- `claimed -> withdrawn -> available`, two transitions
-- `marketplace_set_listing_status` (0317) allows — and NOT by a raw UPDATE of
-- claimed -> pending. That direct transition is one 0317's case forbids, so a
-- raw stage would be broken, with a bare ERROR and no verdict, by any future
-- CHECK or trigger that enforces the state machine at table level on a
-- database where the boundary holds perfectly. Withdraw-and-relist is also
-- what a family really does when a buyer falls through, and it leaves exactly
-- the state the refused case is in: `claimed_by` still the first buyer, one
-- confirmed order, the backup offer still open — nothing clears claimed_by or
-- the order on relist (0317's UPDATE sets status alone; grepped) — with only
-- the status different. That is why 0315's predicate keys on status and not on
-- `claimed_by is null`: tightened that way, a relisted item could never be sold
-- again, and this control would report it, as it should.
--
-- Without it, step 3's verdict has no attribution. Step 3 swallows every
-- exception (`when others then null`) and judges on ORDER COUNTS, so the probe
-- passes whenever the second accept fails FOR ANY REASON — and neither existing
-- positive control rules those out, because both of them accept the FIRST offer
-- on a listing that has no order and no claimant yet. That is a different
-- statement from the one under test:
--
--   * add a unique index on marketplace_orders(listing_id), or a guard trigger
--     refusing a second confirmed order for one listing, and the second order
--     INSERT dies of its own accord — count stays 1 and this probe stays green
--     with the status precondition deleted from the function;
--   * add a guard trigger on marketplace_listings refusing to rewrite
--     `claimed_by` once it is set, and the claim UPDATE dies instead — same
--     green, and step 4 passes for the same borrowed reason;
--   * teach any trigger to decline OPEN offers on a claimed listing and the
--     second accept dies on 'Offer is no longer open' — the offer-side guard
--     that 0315 exists to say is NOT the guard on the thing being sold;
--   * revoke execute on the function, or break auth.uid(), and step 1 already
--     catches that. That one the existing controls do cover, which is why this
--     control is added alongside them rather than in place of them.
--   In every other case the control fails too, and the probe then reports the
--   boundary UNPROVEN rather than reporting it as holding.
--
-- What the control does NOT prove, said plainly: WHERE the predicate lives. It
-- establishes that whatever refuses the second sale is keyed on the listing's
-- status and on nothing else this probe can name; it cannot tell `and status
-- in (...)` in the UPDATE's WHERE from the same test in an `if` above an
-- unpredicated UPDATE, or in a BEFORE UPDATE trigger keyed on OLD.status —
-- each passes steps 3 and 4 and passes this control, because none of it is
-- concurrent and the `if` form only loses under concurrency. 0315's header is
-- explicit that the condition goes IN THE UPDATE so the row lock does the
-- work. Step 6 asserts that, from pg_get_functiondef, comments stripped.
--
-- The control invents no UUID. It reuses this probe's own anchors (fam, u) and
-- the seller and both buyers the breach case uses, and takes
-- database-generated ids for its own listing and its two offers — so it cannot
-- collide with a row any other probe seeds into the one database that
-- run-probes.sh drives every probe it globs through in sequence. Its rows are
-- deleted before the case under test runs, so the `where listing_id = listing`
-- counts in steps 3 and 4 are measured against exactly what they were before.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam    uuid := '00000000-0000-4000-8000-0000000c5a01';
  u      uuid := '00000000-0000-4000-8000-0000000c5a0a';
  seller uuid; b1 uuid; b2 uuid;
  listing uuid; off1 uuid; off2 uuid; spare uuid; ord uuid;
  n int; st text; claimant uuid;
  src text;   -- the installed marketplace_accept_offer, comments stripped (step 6)
  failures int := 0;
  -- The negative control's own rows. Ids are database-generated on purpose:
  -- the control introduces no UUID that could collide with another probe's.
  ctl_listing uuid; ctl_off1 uuid; ctl_off2 uuid; ctl_ord uuid;
  ctl_n int; ctl_claim uuid; ctl_st text;
  control_ok boolean := true;
  control_note text;
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

  -- ══ 0. NEGATIVE CONTROL — the same seller, the same predicate, the other ══
  --       answer. It runs FIRST, before the refusal it gives meaning to — and
  --       before any row of the case under test is seeded. Seeding an offer
  --       fires 0154's flip trigger, which UPDATEs the listing, so a decoy that
  --       refuses listing rewrites would otherwise kill the seed on line one
  --       with a bare ERROR before this control could name it. The control's
  --       own seed is guarded for the same reason.
  --
  -- The boundary is one predicate: `and status in ('available','pending')` in
  -- the claiming UPDATE inside `marketplace_accept_offer` (0315 — the last
  -- migration to create that function). So this control replays the case under
  -- test statement for statement, on its own listing, changing only that one
  -- thing: the listing's status is put BACK into range before the second
  -- accept — through the seller's own withdraw and relist (0317's state
  -- machine), not by a raw UPDATE of a transition that state machine forbids.
  -- That accept must LAND, and land visibly — a second confirmed order and
  -- `claimed_by` moved to the second buyer, which is the pre-0315 double sale
  -- reproduced on purpose.
  --
  -- What it catches: step 3 swallows every exception and judges on order
  -- counts, so it reads as PASS whenever the second accept fails for any
  -- reason at all — a unique index or guard trigger on marketplace_orders, a
  -- trigger pinning `claimed_by` once set, a new rule that declines open offers
  -- on a claimed listing. None of those is ruled out by the positive controls
  -- in steps 1 and 5, because both of those accept the FIRST offer on a listing
  -- with no order and no claimant. Each of them fails this control, and the
  -- probe then says UNPROVEN instead of green.
  --
  -- The offer order below is load-bearing: ctl_off2 is inserted AFTER ctl_off1
  -- is accepted, because accepting an offer declines every other OPEN offer on
  -- the same listing. Seeded the other way round, the control would be refused
  -- with 'Offer is no longer open' — the wrong guard — and would report a
  -- failure that is its own fault.
  begin
    insert into public.marketplace_listings (family_id, member_id, title, kind, price_cents, status)
      values (fam, seller, 'Control listing', 'sell', 4000, 'available') returning id into ctl_listing;
    insert into public.marketplace_offers (family_id, listing_id, member_id, kind, status, amount_cents)
      values (fam, ctl_listing, b1, 'offer', 'open', 4000) returning id into ctl_off1;
    if ctl_listing is null or ctl_off1 is null then
      control_ok := false;
      control_note := 'the control''s own listing or first offer stored no row as the owner role, so there was nothing for the seller to accept and nothing below could be measured';
    end if;
  exception when others then
    control_ok := false;
    control_note := format('the control could not seed its own listing and first offer as the owner role (%s: %s) — whatever refused that write would refuse the case under test''s seeding the same way, so step 3 could never have been reached, let alone attributed', sqlstate, sqlerrm);
  end;

  -- 0a. The first accept, so the control reaches the state the breach is in.
  if control_ok then
    perform set_config('request.jwt.claim.sub', u::text, true);
    set local role authenticated;
    begin
      select public.marketplace_accept_offer(ctl_off1) into ctl_ord;
      if ctl_ord is null then
        control_ok := false;
        control_note := 'the seller''s FIRST accept on the control listing returned no order, so this session never had the access step 3 is supposed to be measuring';
      end if;
    exception when others then
      control_ok := false;
      control_note := format('the seller could not accept an offer at all on the control listing (%s: %s), so a refusal in step 3 would prove only that something said no', sqlstate, sqlerrm);
    end;
  end if;

  -- 0b. The backup offer, exactly as step 2 makes one.
  if control_ok then
    reset role;
    begin
      insert into public.marketplace_offers (family_id, listing_id, member_id, kind, status, amount_cents)
        values (fam, ctl_listing, b2, 'offer', 'open', 4500) returning id into ctl_off2;
      if ctl_off2 is null then
        control_ok := false;
        control_note := 'a backup offer on the claimed control listing stored no row, so step 3 would have nothing to accept and its zero second order would mean nothing';
      end if;
    exception when others then
      control_ok := false;
      control_note := format('a backup offer on the claimed control listing was refused (%s: %s), so step 3''s single order count would be attributable to the offer write, not to the listing guard', sqlstate, sqlerrm);
    end;
  end if;

  -- 0c. THE ONE THING THE MECHANISM KEYS ON, ANSWERED THE OTHER WAY. The
  --     listing goes back into range through the product's own state machine:
  --     the seller withdraws it and relists it, `claimed -> withdrawn ->
  --     available`, both transitions `marketplace_set_listing_status` (0317)
  --     allows. Not a raw `update ... set status = 'pending'`: claimed ->
  --     pending is the transition 0317's case FORBIDS, so a table-level CHECK
  --     or trigger enforcing the state machine would kill that stage with a
  --     bare ERROR — no UNPROVEN, no verdict — on a database where the
  --     boundary holds. Relisting after a buyer falls through is what families
  --     do, and it leaves `claimed_by`, the first order and the open backup
  --     offer exactly as the refused case has them, with only the status
  --     changed. Every stage is guarded and the resulting status is read back,
  --     so a refusal here is a control failure carrying its own sqlstate and
  --     message rather than a probe crash, and a stage that silently did not
  --     take is not mistaken for one that did.
  if control_ok then
    perform set_config('request.jwt.claim.sub', u::text, true);
    set local role authenticated;
    begin
      perform public.marketplace_set_listing_status(ctl_listing, 'withdrawn');
      perform public.marketplace_set_listing_status(ctl_listing, 'available');
      select status into ctl_st from public.marketplace_listings where id = ctl_listing;
      -- `is distinct from`, not `<>`: a row this session cannot see reads back
      -- NULL, and `null <> 'available'` is NULL, which would count as nothing.
      if ctl_st is distinct from 'available' then
        control_ok := false;
        control_note := format('withdraw-and-relist through marketplace_set_listing_status left the control listing at %s rather than available, so there was no in-range listing for the second accept to land on and step 3''s refusal cannot be attributed to the status precondition', coalesce(ctl_st, '<not visible to this session>'));
      end if;
    exception when others then
      control_ok := false;
      control_note := format('the seller could not withdraw and relist the claimed control listing through marketplace_set_listing_status (%s: %s), so the control never reached an in-range listing and step 3''s refusal cannot be attributed to the status precondition', sqlstate, sqlerrm);
    end;
  end if;
  if control_ok then
    begin
      select public.marketplace_accept_offer(ctl_off2) into ctl_ord;
      if ctl_ord is null then
        control_ok := false;
        control_note := 'the second accept on an IN-RANGE listing returned no order — the second sale is being stopped by something other than the status precondition, so step 3''s refusal is not attributable to it';
      end if;
    exception when others then
      control_ok := false;
      control_note := format('the second accept on an IN-RANGE listing was refused (%s: %s) — something other than the status precondition stops a second sale, so step 3 proves nothing about the guard it names', sqlstate, sqlerrm);
    end;
  end if;

  -- 0d. And it really wrote: the double sale the guard exists to stop is
  --     reachable when the status says yes. If these two lines do not hold,
  --     steps 3 and 4 are measuring a write that could not have landed either
  --     way.
  if control_ok then
    select count(*) into ctl_n from public.marketplace_orders where listing_id = ctl_listing;
    select claimed_by into ctl_claim from public.marketplace_listings where id = ctl_listing;
    if ctl_n <> 2 then
      control_ok := false;
      control_note := format('an IN-RANGE second accept left %s order(s) on the control listing instead of 2, so step 3''s count of 1 is not evidence of the status guard', ctl_n);
    elsif ctl_claim is distinct from b2 then
      control_ok := false;
      control_note := 'an IN-RANGE second accept did not move claimed_by to the second buyer, so step 4''s unchanged claimed_by is not evidence of the status guard';
    end if;
  end if;

  -- The control's rows do not outlive the control, so steps 3 and 4 count
  -- exactly what they counted before it existed.
  reset role;
  delete from public.marketplace_orders where listing_id = ctl_listing;
  delete from public.marketplace_offers where listing_id = ctl_listing;
  delete from public.marketplace_listings where id = ctl_listing;

  -- A failed control makes every verdict below unreadable, so say why here,
  -- while the reason is still in hand. The boundary is reported neither as
  -- holding nor as broken: it is reported as unproven, and the build is red
  -- either way. This probe runs in autocommit, so the raise rolls back
  -- everything the block has seeded — nothing is left behind for the next
  -- probe in the sequence.
  if not control_ok then
    perform set_config('request.jwt.claim.sub', '', true);
    raise exception '0315 UNPROVEN (the negative control this probe rests on did not hold): %', control_note;
  end if;

  -- The case under test is seeded only now, as the owner role, after the
  -- control has held: its listing, a spare, and the first buyer's offer.
  insert into public.marketplace_listings (family_id, member_id, title, kind, price_cents, status)
    values (fam, seller, 'Balance bike', 'sell', 4000, 'available') returning id into listing;
  -- A spare listing, so the positive control in step 5 is not measured against
  -- the same row the breach case has already claimed.
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

  -- 6. WHERE the predicate lives, read out of the function the database
  --    actually has rather than out of a file. Steps 3 and 4 prove that the
  --    second sale is refused and the control proves the refusal is keyed on
  --    the listing's status; neither can tell the mechanism 0315 shipped from
  --    the one it rejects — `if v_listing.status not in (...) then raise` above
  --    an unpredicated UPDATE, or the same test in a BEFORE UPDATE trigger —
  --    because nothing here is concurrent and the `if` form only loses under
  --    concurrency. 0315's header: "The precondition goes IN THE UPDATE, not in
  --    an `if` above it." This is the assertion that it still does.
  --
  --    Comments are stripped first, so a comment describing the predicate
  --    cannot stand in for it (the mistake wallet-concurrency-check records),
  --    and the match is anchored on the claiming UPDATE's own statement —
  --    `update public.marketplace_listings set … where … and status in
  --    ('available','pending')`, up to its terminating semicolon — so the same
  --    words in a SELECT, an `if`, or a statement on another table do not
  --    satisfy it. It is the shape 0315 shipped, spelled with whitespace
  --    tolerated; a genuine rewrite of the predicate should rewrite this line.
  --    `to_regprocedure` is null for a missing function, so a database without
  --    the function reports BREACH here instead of dying on a cast.
  src := regexp_replace(
           pg_get_functiondef(to_regprocedure('public.marketplace_accept_offer(uuid)')),
           '--[^\n]*', '', 'g');
  if src is null then
    raise warning 'BREACH: public.marketplace_accept_offer(uuid) is not installed, so nothing carries 0315''s predicate';
    failures := failures + 1;
  elsif src !~* 'update\s+public\.marketplace_listings\s+set\s[^;]*\swhere\s[^;]*\sand\s+status\s+in\s*\(\s*''available''\s*,\s*''pending''\s*\)' then
    raise warning 'BREACH: the claiming UPDATE in marketplace_accept_offer does not carry `and status in (''available'',''pending'')` in its WHERE — the precondition has left the row lock''s reach (an `if` above the UPDATE, a trigger) or is gone';
    failures := failures + 1;
  end if;

  delete from public.marketplace_orders where family_id = fam;
  delete from public.marketplace_offers where family_id = fam;
  delete from public.marketplace_listings where family_id = fam;
  delete from public.family_members where family_id = fam and user_id is null;

  if failures > 0 then
    raise exception '0315 FAILED: % assertion(s)', failures;
  end if;
  raise notice '0315 OK: the same seller CAN sell a listing twice when its status says yes (4-part negative control, run first, staged through the seller''s own withdraw and relist), cannot when it says claimed, and the predicate that says so is still in the WHERE of the claiming UPDATE — a listing is claimed once (7 assertions: 6 behavioural + 1 read from pg_get_functiondef)';
end
$probe$;
