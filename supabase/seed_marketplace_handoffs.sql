-- ============================================================================
-- FamilyOS · SEED — Marketplace pickup & hand-off (~520 rows).
-- Fills the hand-off coordinator on /marketplace/orders: 160 claimed sale
-- listings, each with a confirmed order and a pickup hand-off spanning every
-- status (proposed / confirmed-with-code / completed / cancelled), safe public
-- meetup spots, future/past meet times, and ~40 backing calendar events for the
-- confirmed ones. Buyer is a second member of the same family (created if the
-- family has only one), so the order/hand-off are family-scoped like the app.
-- Idempotent: clears its own '[seed:handoff]' rows first (orders + hand-offs
-- cascade from the listing; calendar events are tagged). Resolves family by
-- email. (Needs migrations 0151 + 0190.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_seller uuid;    -- listing owner (seller member)
  v_user   uuid;
  v_buyer  uuid;    -- second family member (buyer)
  n_sets   int := 160;
  spots    text[] := array[
    'Police-station safe-exchange zone','Grocery-store entrance','Public library',
    'Coffee shop','Bank lobby / ATM vestibule','Mall food court'];
  titles   text[] := array[
    'Toddler bike','Air fryer','Yoga mat set','Desk lamp','Winter coat (M)',
    'Puzzle bundle','Garden tools','Baby monitor','Bluetooth speaker','Ski boots'];
  lot      uuid;
  ord      uuid;
  st       int;
  meet     timestamptz;
  loc      text;
  prole    text;
  code     text;
  cev      uuid;
begin
  if to_regclass('public.marketplace_handoffs') is null then
    raise notice 'marketplace_handoffs not present — apply migration 0190 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select fm.id, fm.user_id into v_seller, v_user
  from public.family_members fm where fm.family_id = v_family order by fm.created_at limit 1;

  -- Buyer = the next member of the same family, or a created stand-in.
  select fm.id into v_buyer from public.family_members fm
    where fm.family_id = v_family and fm.id <> v_seller order by fm.created_at limit 1;
  if v_buyer is null then
    insert into public.family_members (id, family_id, role, display_name, is_active)
    values ('a0000000-0000-4000-8000-00000000fa02', v_family, 'parent', 'Pickup Pat', true)
    on conflict (id) do nothing;
    v_buyer := 'a0000000-0000-4000-8000-00000000fa02';
  end if;

  -- Clean prior seed in dependency order (hand-offs → orders → listings), then
  -- the tagged calendar events. Explicit order avoids cascade races on re-run.
  delete from public.marketplace_handoffs h using public.marketplace_listings l
    where l.description like '%[seed:handoff]%' and (h.listing_id = l.id or h.order_id in (
      select o.id from public.marketplace_orders o where o.listing_id = l.id));
  delete from public.marketplace_orders o using public.marketplace_listings l
    where o.listing_id = l.id and l.description like '%[seed:handoff]%';
  delete from public.marketplace_listings where family_id = v_family and description like '%[seed:handoff]%';
  delete from public.calendar_events where family_id = v_family and title like '%[seed:handoff]%';

  for i in 0..(n_sets - 1) loop
    st   := i % 4;   -- 0 proposed · 1 confirmed · 2 completed · 3 cancelled
    loc  := spots[1 + (i % array_length(spots, 1))];
    prole := case when i % 2 = 0 then 'seller' else 'buyer' end;
    lot  := gen_random_uuid();
    -- future meet for proposed/confirmed; past for completed/cancelled.
    meet := case when st in (0, 1) then now() + ((1 + (i % 5)) || ' days')::interval
                 else now() - ((1 + (i % 10)) || ' days')::interval end;

    insert into public.marketplace_listings
      (id, family_id, member_id, title, description, kind, category, condition, price_cents, status, claimed_by, claimed_at, created_by, created_at)
    values (lot, v_family, v_seller,
      titles[1 + (i % array_length(titles, 1))] || ' — h' || (i + 1),
      'Sold — arranging pickup. [seed:handoff]', 'sell', 'other',
      (array['new','like_new','good','fair'])[1 + (i % 4)],
      1500 + (i % 15) * 400, 'claimed', v_buyer, now() - interval '1 day', v_user, now() - ((i % 20) || ' days')::interval);

    insert into public.marketplace_orders
      (id, family_id, listing_id, buyer_member, seller_member, kind, status, amount_cents, notes, created_by, created_at)
    values (gen_random_uuid(), v_family, lot, v_buyer, v_seller, 'buy',
      case when st = 2 then 'completed' else 'confirmed' end,
      1500 + (i % 15) * 400, 'Pickup seed [seed:handoff]', v_user, now() - interval '1 day')
    returning id into ord;

    -- A calendar event backs each confirmed pickup (~40 rows).
    cev := null;
    if st = 1 then
      insert into public.calendar_events (family_id, title, description, location, category, starts_at, created_by)
      values (v_family, 'Marketplace pickup · ' || loc || ' [seed:handoff]',
              'Bubaly marketplace hand-off. Bring the item + the hand-off code.', loc, 'general', meet, v_user)
      returning id into cev;
    end if;

    code := case when st in (1, 2) then upper(substr(translate(md5(lot::text), '01losiLOSI', 'ABGHKMNPQR'), 1, 6)) else null end;

    insert into public.marketplace_handoffs
      (order_id, family_id, listing_id, proposed_by, proposer_role, meet_at, location_label, location_kind,
       status, confirm_code, confirmed_at, completed_at, calendar_event_id, notes, created_at)
    values (ord, v_family, lot,
      case when prole = 'seller' then v_seller else v_buyer end, prole,
      meet, loc, 'public_spot',
      (array['proposed','confirmed','completed','cancelled'])[st + 1],
      code,
      case when st in (1, 2) then now() - interval '12 hours' else null end,
      case when st = 2 then meet else null end,
      cev,
      case when i % 3 = 0 then 'I''ll be in a blue jacket.' else null end,
      now() - ((i % 15) || ' hours')::interval);
  end loop;

  raise notice 'Seeded % pickup hand-offs (+orders +events) for family %', n_sets, v_family;
end $$;

-- Verify:
--   select count(*) from marketplace_listings where description like '%[seed:handoff]%';               -- 160
--   select status, count(*) from marketplace_handoffs h join marketplace_listings l on l.id=h.listing_id
--     where l.description like '%[seed:handoff]%' group by 1;                                            -- 40 each
--   select count(*) from calendar_events where title like '%[seed:handoff]%';                            -- 40
