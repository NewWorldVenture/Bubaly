-- Bubaly | SEED | Marketplace pickup and hand-off (~520 rows)
--
-- Creates 160 deterministic listings, orders, hand-offs, and about 40 calendar
-- events for volume testing. Requires migrations 0151 and 0190.
-- Safety: resolves only the anchored account, requires two existing members,
-- never writes auth.users or family_members, never deletes rows, and uses
-- deterministic conflict-safe inserts so reruns are additive and idempotent.

do $$
declare
  v_email text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_seller uuid;
  v_user uuid;
  v_buyer uuid;
  n_sets int := 160;
  spots text[] := array[
    'Police-station safe-exchange zone', 'Grocery-store entrance', 'Public library',
    'Coffee shop', 'Bank lobby / ATM vestibule', 'Mall food court'
  ];
  titles text[] := array[
    'Toddler bike', 'Air fryer', 'Yoga mat set', 'Desk lamp', 'Winter coat (M)',
    'Puzzle bundle', 'Garden tools', 'Baby monitor', 'Bluetooth speaker', 'Ski boots'
  ];
  lot uuid;
  ord uuid;
  st int;
  meet timestamptz;
  loc text;
  prole text;
  code text;
  cev uuid;
begin
  if to_regclass('public.marketplace_handoffs') is null then
    raise exception 'marketplace_handoffs is missing; apply migration 0190 first.';
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email)
  limit 1;
  if v_family is null then
    raise exception 'Marketplace hand-off seed requires the anchored account %.', v_email;
  end if;

  select fm.id, fm.user_id into v_seller, v_user
  from public.family_members fm
  where fm.family_id = v_family and fm.is_active
  order by fm.created_at
  limit 1;
  if v_seller is null or v_user is null then
    raise exception 'Marketplace hand-off seed requires an active member with a user for family %.', v_family;
  end if;

  select fm.id into v_buyer
  from public.family_members fm
  where fm.family_id = v_family and fm.is_active and fm.id <> v_seller
  order by fm.created_at
  limit 1;
  if v_buyer is null then
    raise exception 'Marketplace hand-off seed requires two existing active members for family %.', v_family;
  end if;

  for i in 0..(n_sets - 1) loop
    st := i % 4;
    loc := spots[1 + (i % array_length(spots, 1))];
    prole := case when i % 2 = 0 then 'seller' else 'buyer' end;
    lot := md5('familyos-seed-handoff-listing-' || i)::uuid;
    meet := case when st in (0, 1)
      then now() + ((1 + (i % 5)) || ' days')::interval
      else now() - ((1 + (i % 10)) || ' days')::interval end;

    insert into public.marketplace_listings
      (id, family_id, member_id, title, description, kind, category, condition,
       price_cents, status, claimed_by, claimed_at, created_by, created_at)
    values
      (lot, v_family, v_seller,
       titles[1 + (i % array_length(titles, 1))] || ' - handoff ' || (i + 1),
       'Sold - arranging pickup. [seed:handoff]', 'sell', 'other',
       (array['new', 'like_new', 'good', 'fair'])[1 + (i % 4)],
       1500 + (i % 15) * 400, 'claimed', v_buyer, now() - interval '1 day',
       v_user, now() - ((i % 20) || ' days')::interval)
    on conflict (id) do nothing;

    insert into public.marketplace_orders
      (id, family_id, listing_id, buyer_member, seller_member, kind, status,
       amount_cents, notes, created_by, created_at)
    values
      (md5('familyos-seed-handoff-order-' || i)::uuid, v_family, lot, v_buyer,
       v_seller, 'buy', case when st = 2 then 'completed' else 'confirmed' end,
       1500 + (i % 15) * 400, 'Pickup seed [seed:handoff]', v_user,
       now() - interval '1 day')
    on conflict (id) do nothing;
    select id into ord from public.marketplace_orders
    where id = md5('familyos-seed-handoff-order-' || i)::uuid;

    cev := null;
    if st = 1 then
      insert into public.calendar_events
        (id, family_id, title, description, location, category, starts_at, created_by)
      values
        (md5('familyos-seed-handoff-calendar-' || i)::uuid, v_family,
         'Marketplace pickup - ' || loc || ' [seed:handoff]',
         'Bubaly marketplace hand-off. Bring the item and the hand-off code.',
         loc, 'general', meet, v_user)
      on conflict (id) do nothing;
      select id into cev from public.calendar_events
      where id = md5('familyos-seed-handoff-calendar-' || i)::uuid;
    end if;

    code := case when st in (1, 2)
      then upper(substr(translate(md5(lot::text), '01losiLOSI', 'ABGHKMNPQR'), 1, 6))
      else null end;

    insert into public.marketplace_handoffs
      (order_id, family_id, listing_id, proposed_by, proposer_role, meet_at,
       location_label, location_kind, status, confirm_code, confirmed_at,
       completed_at, calendar_event_id, notes, created_at)
    values
      (ord, v_family, lot,
       case when prole = 'seller' then v_seller else v_buyer end, prole, meet,
       loc, 'public_spot',
       (array['proposed', 'confirmed', 'completed', 'cancelled'])[st + 1],
       code,
       case when st in (1, 2) then now() - interval '12 hours' else null end,
       case when st = 2 then meet else null end, cev,
       case when i % 3 = 0 then 'I will be in a blue jacket.' else null end,
       now() - ((i % 15) || ' hours')::interval)
    on conflict (order_id) do nothing;
  end loop;

  raise notice 'Seeded % pickup hand-offs (+orders and events) for family %', n_sets, v_family;
end $$;

-- Verify:
-- select count(*) from public.marketplace_listings where description like '%[seed:handoff]%';
-- select status, count(*) from public.marketplace_handoffs group by status order by status;
-- select count(*) from public.calendar_events where title like '%[seed:handoff]%';
