-- ============================================================================
-- FamilyOS · SEED — Marketplace "Make an Offer" negotiations (~520 rows).
-- Fills the Best-Offer surface so /marketplace/negotiations and the item-page
-- offer panel can be tested at volume: 100 fixed-price sale listings, each with
-- one negotiation thread spanning the full state space (open·your-turn /
-- open·their-turn / agreed / declined / withdrawn) and a realistic round ladder
-- (offer → counter → counter → accept/decline/withdraw). Agreed threads claim
-- the listing + write a confirmed order, exactly like the RPC does in prod.
-- Buyers are a throwaway "Offer Makers" family so threads are valid cross-family.
-- Idempotent: clears its own '[seed:negotiate]' rows first (rounds + orders
-- cascade / are tagged). Resolves family by email. (Needs migration 0186.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_owner   uuid;
  v_user    uuid;
  v_bfam    uuid;
  v_bmem    uuid[];
  n_lots    int := 100;
  titles    text[] := array[
    'Standing desk','Road bike','Bassinet','Cast-iron skillet set','Acoustic guitar',
    'Patio heater','Bookshelf','Kids'' scooter','Espresso machine','Snowboard',
    'Sewing machine','Drone','Board-game bundle','Office chair','Tent (6-person)'];
  cats      text[] := array['furniture','sports','baby','other','electronics','games'];
  lot       uuid;
  neg       uuid;
  ask       bigint;
  b0 bigint; c1 bigint; b2 bigint;      -- offer / seller counter / buyer counter
  t0 timestamptz;
  s  int;                               -- status bucket
  bidder uuid;
begin
  if to_regclass('public.marketplace_negotiations') is null then
    raise notice 'marketplace_negotiations not present — apply migration 0186 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select fm.id, fm.user_id into v_owner, v_user
  from public.family_members fm where fm.family_id = v_family order by fm.created_at limit 1;

  -- Throwaway buyer family + three members (stable ids so re-runs reuse them).
  insert into public.families (id, name) values ('a0000000-0000-4000-8000-00000000ff01', 'Offer Makers')
    on conflict (id) do nothing;
  v_bfam := 'a0000000-0000-4000-8000-00000000ff01';
  insert into public.family_members (id, family_id, role, display_name, is_active) values
    ('a0000000-0000-4000-8000-00000000ff11', v_bfam, 'parent', 'Offer Ann', true),
    ('a0000000-0000-4000-8000-00000000ff12', v_bfam, 'parent', 'Offer Ben', true),
    ('a0000000-0000-4000-8000-00000000ff13', v_bfam, 'parent', 'Offer Cy',  true)
    on conflict (id) do nothing;
  v_bmem := array['a0000000-0000-4000-8000-00000000ff11'::uuid,
                  'a0000000-0000-4000-8000-00000000ff12'::uuid,
                  'a0000000-0000-4000-8000-00000000ff13'::uuid];

  -- Clean prior seed (rounds cascade via FK; orders tagged in notes).
  delete from public.marketplace_orders o using public.marketplace_listings l
    where o.listing_id = l.id and l.description like '%[seed:negotiate]%';
  delete from public.marketplace_listings where family_id = v_family and description like '%[seed:negotiate]%';

  for i in 0..(n_lots - 1) loop
    ask := 2000 + (i % 20) * 500;               -- $20–$115 asking prices
    lot := gen_random_uuid();
    bidder := v_bmem[1 + (i % 3)];
    s := i % 5;
    t0 := now() - ((i % 30) || ' hours')::interval;

    -- Offer ladder anchored to the ask.
    b0 := (ask * 0.65)::bigint;                  -- buyer opening ~65%
    c1 := ((b0 + ask) / 2)::bigint;              -- seller counter (meet middle)
    b2 := ((b0 + c1) / 2)::bigint;               -- buyer counter (nudge up)

    insert into public.marketplace_listings
      (id, family_id, member_id, title, description, kind, category, condition,
       price_cents, status, created_by, created_at)
    values (
      lot, v_family, v_owner,
      titles[1 + (i % array_length(titles, 1))] || ' — ' || (i + 1),
      'Fixed price, open to offers. Local pickup. [seed:negotiate]',
      'sell', cats[1 + (i % array_length(cats, 1))],
      (array['new','like_new','good','fair'])[1 + (i % 4)],
      ask, case when s = 0 then 'claimed' else 'available' end,
      v_user, t0
    );

    -- Create the negotiation summary row + its ordered rounds per status bucket.
    if s = 0 then
      -- AGREED: offer → seller counter → buyer counter → seller accept (@ b2).
      insert into public.marketplace_negotiations
        (family_id, listing_id, buyer_member_id, buyer_family_id, status,
         current_amount_cents, last_actor, rounds_count, agreed_amount_cents, created_at, updated_at)
      values (v_family, lot, bidder, v_bfam, 'agreed', b2, 'seller', 4, b2, t0, t0 + interval '3 hours')
      returning id into neg;
      insert into public.marketplace_negotiation_rounds
        (negotiation_id, listing_id, actor_member_id, actor_role, kind, amount_cents, message, created_at) values
        (neg, lot, bidder,  'buyer',  'offer',   b0, 'Would you take this?', t0),
        (neg, lot, v_owner, 'seller', 'counter', c1, 'Can do a bit better',  t0 + interval '1 hour'),
        (neg, lot, bidder,  'buyer',  'counter', b2, 'Meet in the middle?',  t0 + interval '2 hours'),
        (neg, lot, v_owner, 'seller', 'accept',  b2, 'Deal!',                t0 + interval '3 hours');
      update public.marketplace_listings set claimed_by = bidder, claimed_at = t0 + interval '3 hours' where id = lot;
      insert into public.marketplace_orders
        (family_id, listing_id, buyer_member, seller_member, kind, status, amount_cents, notes, created_by, created_at)
      values (v_family, lot, bidder, v_owner, 'buy', 'confirmed', b2,
              'Agreed via Make an Offer [seed:negotiate]', v_user, t0 + interval '3 hours');

    elsif s = 1 then
      -- OPEN, seller's turn (buyer moved last): offer → counter → buyer counter.
      insert into public.marketplace_negotiations
        (family_id, listing_id, buyer_member_id, buyer_family_id, status,
         current_amount_cents, last_actor, rounds_count, created_at, updated_at)
      values (v_family, lot, bidder, v_bfam, 'open', b2, 'buyer', 3, t0, t0 + interval '2 hours')
      returning id into neg;
      insert into public.marketplace_negotiation_rounds
        (negotiation_id, listing_id, actor_member_id, actor_role, kind, amount_cents, message, created_at) values
        (neg, lot, bidder,  'buyer',  'offer',   b0, 'Interested — offer attached', t0),
        (neg, lot, v_owner, 'seller', 'counter', c1, 'How about this?',             t0 + interval '1 hour'),
        (neg, lot, bidder,  'buyer',  'counter', b2, 'Final offer from me',         t0 + interval '2 hours');

    elsif s = 2 then
      -- OPEN, buyer's turn (seller moved last): offer → seller counter.
      insert into public.marketplace_negotiations
        (family_id, listing_id, buyer_member_id, buyer_family_id, status,
         current_amount_cents, last_actor, rounds_count, created_at, updated_at)
      values (v_family, lot, bidder, v_bfam, 'open', c1, 'seller', 2, t0, t0 + interval '1 hour')
      returning id into neg;
      insert into public.marketplace_negotiation_rounds
        (negotiation_id, listing_id, actor_member_id, actor_role, kind, amount_cents, message, created_at) values
        (neg, lot, bidder,  'buyer',  'offer',   b0, 'Any wiggle room?', t0),
        (neg, lot, v_owner, 'seller', 'counter', c1, 'Best I can do',    t0 + interval '1 hour');

    elsif s = 3 then
      -- DECLINED: offer → counter → buyer counter → seller decline.
      insert into public.marketplace_negotiations
        (family_id, listing_id, buyer_member_id, buyer_family_id, status,
         current_amount_cents, last_actor, rounds_count, created_at, updated_at)
      values (v_family, lot, bidder, v_bfam, 'declined', b2, 'buyer', 4, t0, t0 + interval '3 hours')
      returning id into neg;
      insert into public.marketplace_negotiation_rounds
        (negotiation_id, listing_id, actor_member_id, actor_role, kind, amount_cents, message, created_at) values
        (neg, lot, bidder,  'buyer',  'offer',   b0, 'Lowball, I know', t0),
        (neg, lot, v_owner, 'seller', 'counter', c1, 'Too low sorry',   t0 + interval '1 hour'),
        (neg, lot, bidder,  'buyer',  'counter', b2, 'This is my max',  t0 + interval '2 hours'),
        (neg, lot, v_owner, 'seller', 'decline', null, 'Passing, thanks', t0 + interval '3 hours');

    else
      -- WITHDRAWN: offer → seller counter → buyer withdraws.
      insert into public.marketplace_negotiations
        (family_id, listing_id, buyer_member_id, buyer_family_id, status,
         current_amount_cents, last_actor, rounds_count, created_at, updated_at)
      values (v_family, lot, bidder, v_bfam, 'withdrawn', c1, 'seller', 3, t0, t0 + interval '2 hours')
      returning id into neg;
      insert into public.marketplace_negotiation_rounds
        (negotiation_id, listing_id, actor_member_id, actor_role, kind, amount_cents, message, created_at) values
        (neg, lot, bidder,  'buyer',  'offer',    b0,  'Offer for you',   t0),
        (neg, lot, v_owner, 'seller', 'counter',  c1,  'Counter',         t0 + interval '1 hour'),
        (neg, lot, bidder,  'buyer',  'withdraw', null, 'Found another',  t0 + interval '2 hours');
    end if;
  end loop;

  raise notice 'Seeded % negotiations + rounds for family %', n_lots, v_family;
end $$;

-- Verify:
--   select count(*) from marketplace_listings where description like '%[seed:negotiate]%';           -- 100
--   select status, count(*) from marketplace_negotiations n join marketplace_listings l on l.id=n.listing_id
--     where l.description like '%[seed:negotiate]%' group by 1;                                        -- 20 each
--   select count(*) from marketplace_negotiation_rounds r join marketplace_listings l on l.id=r.listing_id
--     where l.description like '%[seed:negotiate]%';                                                   -- ~320
