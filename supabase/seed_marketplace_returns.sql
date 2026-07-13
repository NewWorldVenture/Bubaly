-- ============================================================================
-- FamilyOS · SEED — Marketplace rent/borrow returns (~500 rows).
-- Fills the return-tracking surface on /marketplace/orders: 250 rent/borrow
-- listings + 250 orders whose due dates (ends_on) span every return state —
-- upcoming / due-soon / due-today / overdue / returned — so the due + overdue
-- badges (and the return-reminders cron) can be exercised at volume. Borrower is
-- a second member of the same family (created if the household has only one).
-- Idempotent: clears its own '[seed:returns]' rows first (orders cascade from
-- the listing; both are tagged). Requires the anchored family account by email.
-- (Needs migrations 0151 + 0192.)  Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_owner  uuid;   -- lender (listing owner)
  v_user   uuid;
  v_borrow uuid;   -- borrower (second family member)
  n_sets   int := 250;
  items    text[] := array[
    'Pressure washer','Folding table','Ladder (8ft)','Projector','Carpet cleaner',
    'Post-hole digger','Roof rack','Camping stove','Tuxedo (42R)','Stand mixer',
    'Baby travel crib','Snow blower','Party speaker','Tile saw','Kayak'];
  cats     text[] := array['tools','furniture','electronics','sports','baby','other'];
  lot      uuid;
  st       int;
  kind_v   text;
  due      date;
  ostatus  text;
  rate     bigint;
begin
  if to_regclass('public.marketplace_orders') is null then
    raise notice 'marketplace_orders not present. Skipping.'; return;
  end if;
  -- Needs the 0192 columns.
  if not exists (select 1 from information_schema.columns
    where table_name='marketplace_orders' and column_name='returned_at') then
    raise notice 'apply migration 0192 first (returned_at missing). Skipping.'; return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then
    raise exception 'Marketplace returns seed requires the anchored account %.', v_email;
  end if;

  select fm.id, fm.user_id into v_owner, v_user
  from public.family_members fm where fm.family_id = v_family order by fm.created_at limit 1;

  select fm.id into v_borrow from public.family_members fm
    where fm.family_id = v_family and fm.id <> v_owner order by fm.created_at limit 1;
  if v_borrow is null then
    insert into public.family_members (id, family_id, role, display_name, is_active)
    values ('a0000000-0000-4000-8000-00000000fa02', v_family, 'parent', 'Pickup Pat', true)
    on conflict (id) do nothing;
    v_borrow := 'a0000000-0000-4000-8000-00000000fa02';
  end if;

  -- Clean prior seed (orders first, then their tagged listings).
  delete from public.marketplace_orders o using public.marketplace_listings l
    where o.listing_id = l.id and l.description like '%[seed:returns]%';
  delete from public.marketplace_listings where family_id = v_family and description like '%[seed:returns]%';

  for i in 0..(n_sets - 1) loop
    st     := i % 5;   -- 0 upcoming · 1 due-soon · 2 due-today · 3 overdue · 4 returned
    kind_v := case when i % 2 = 0 then 'rent' else 'borrow' end;
    rate   := case when kind_v = 'rent' then 500 + (i % 10) * 250 else 0 end;
    lot    := gen_random_uuid();
    due    := (current_date + (case st
                when 0 then 7 + (i % 6)      -- upcoming
                when 1 then 1 + (i % 2)      -- due soon (1–2 days)
                when 2 then 0                -- due today
                when 3 then -(2 + (i % 8))   -- overdue
                else -(3 + (i % 5)) end))::date;  -- returned (past)
    ostatus := case when st = 4 then 'returned' else (case when i % 3 = 0 then 'confirmed' else 'active' end) end;

    insert into public.marketplace_listings
      (id, family_id, member_id, title, description, kind, category, condition,
       price_cents, rent_period, status, claimed_by, claimed_at, created_by, created_at)
    values (lot, v_family, v_owner,
      items[1 + (i % array_length(items, 1))] || ' — r' || (i + 1),
      'Community ' || kind_v || ' item. [seed:returns]', kind_v,
      cats[1 + (i % array_length(cats, 1))],
      (array['new','like_new','good','fair'])[1 + (i % 4)],
      rate, case when kind_v = 'rent' then 'day' else null end,
      'claimed', v_borrow, now() - interval '2 days', v_user, now() - ((i % 30) || ' days')::interval);

    insert into public.marketplace_orders
      (family_id, listing_id, buyer_member, seller_member, kind, status, amount_cents,
       starts_on, ends_on, returned_at, overdue_notified_at, notes, created_by, created_at)
    values (v_family, lot, v_borrow, v_owner, kind_v, ostatus, rate,
      (due - 7)::date, due,
      case when st = 4 then now() - interval '1 day' else null end,           -- returned stamp
      case when st = 3 and i % 2 = 0 then now() - interval '6 hours' else null end,  -- some overdue already alerted
      'Return seed [seed:returns]', v_user, now() - ((i % 30) || ' days')::interval);
  end loop;

  raise notice 'Seeded % rent/borrow return orders for family %', n_sets, v_family;
end $$;

-- Verify:
--   select count(*) from marketplace_listings where description like '%[seed:returns]%';   -- 250
--   select count(*) from marketplace_orders o join marketplace_listings l on l.id=o.listing_id
--     where l.description like '%[seed:returns]%';                                          -- 250
--   -- distribution across due buckets:
--   select case when returned_at is not null then 'returned'
--               when ends_on < current_date then 'overdue'
--               when ends_on = current_date then 'due_today'
--               when ends_on <= current_date + 2 then 'due_soon' else 'upcoming' end as bucket,
--          count(*) from marketplace_orders o join marketplace_listings l on l.id=o.listing_id
--     where l.description like '%[seed:returns]%' group by 1 order by 1;
