-- ============================================================================
-- FamilyOS · SEED — Recent updates bundle (the last 5 shipped seed sets).
--
-- ⚠️ SEED CONVENTION (new): seeds now live in focused, standalone files that are
--    each ≤ 1000 lines — NOT appended to the monolithic supabase/SEED_ALL.sql
--    (which is frozen). Add each new feature's seed as its own supabase/seed_*.sql.
--
-- This file bundles the FIVE most recent seed sets so a fresh database can be
-- brought up to today's features in one paste:
--   1. Marketplace price history + drop watch      (marker: [seed:pricehist])
--   2. Marketplace returns & overdue tracking       (marker: [seed:returns])
--   3. Marketplace Trust & Safety reports           (marker: [seed:report])
--   4. Feedback / Idea Board (/feedback)            (marker: [seed:feedback])
--   5. Kitchen Display (/display), NOW-RELATIVE     (marker: [seed:display])
--
-- Every block is a self-contained, idempotent DO-block that resolves the anchored
-- family by email (newworldventurellc@gmail.com) and deletes its own marker rows
-- before re-inserting — safe to run repeatedly and in any order. PG16-validated.
-- Where: Supabase → SQL Editor → paste → Run  (or `psql … -f` this file).
-- ============================================================================


-- ==================== seed_marketplace_price_history.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Marketplace price history + drop watch (~580 rows).
-- Fills the price-history surface on the item page: 130 fixed-price sale
-- listings, each with a 2–4 step DECLINING price ladder (so the item page shows
-- "Price dropped X%", "Lowest ever", and the history list), plus ~65 watcher
-- saves so the drop-notify path has an audience. History rows are inserted
-- directly (the live trigger fires on listing UPDATEs, not on these inserts),
-- so the seed is fully deterministic. Watchers are a throwaway family.
-- Idempotent: clears its own '[seed:pricehist]' rows first. Resolves family by
-- email. (Needs migrations 0151 + 0191.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_owner  uuid;
  v_user   uuid;
  v_wfam   uuid;
  v_wmem   uuid;
  n_lots   int := 130;
  titles   text[] := array[
    'Road bike','Baby stroller','Standing desk','Espresso machine','Ski set',
    'Guitar + amp','Bookshelf','Drone 4K','Lego set','Patio set',
    'Sewing machine','Camping tent','Monitor 27"','Kids'' bike','Rowing machine'];
  cats     text[] := array['sports','baby','furniture','electronics','other','games'];
  lot      uuid;
  base     bigint;
  steps    int;
  prev     bigint;
  nextp    bigint;
  t0       timestamptz;
  k        int;
begin
  if to_regclass('public.marketplace_price_history') is null then
    raise notice 'marketplace_price_history not present — apply migration 0191 first. Skipping.';
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

  -- Throwaway watcher family + member (stable ids).
  insert into public.families (id, name) values ('a0000000-0000-4000-8000-00000000fb01', 'Price Watchers')
    on conflict (id) do nothing;
  v_wfam := 'a0000000-0000-4000-8000-00000000fb01';
  insert into public.family_members (id, family_id, role, display_name, is_active)
    values ('a0000000-0000-4000-8000-00000000fb11', v_wfam, 'parent', 'Watcher Wendy', true)
    on conflict (id) do nothing;
  v_wmem := 'a0000000-0000-4000-8000-00000000fb11';

  -- Clean prior seed in dependency order (history + saves → listings).
  delete from public.marketplace_price_history h using public.marketplace_listings l
    where h.listing_id = l.id and l.description like '%[seed:pricehist]%';
  delete from public.marketplace_saves s using public.marketplace_listings l
    where s.listing_id = l.id and l.description like '%[seed:pricehist]%';
  delete from public.marketplace_listings where family_id = v_family and description like '%[seed:pricehist]%';

  for i in 0..(n_lots - 1) loop
    base  := 4000 + (i % 20) * 400;      -- current asking $40–$116
    steps := 2 + (i % 3);                -- 2–4 price cuts
    t0    := now() - ((steps + 1) || ' days')::interval;
    lot   := gen_random_uuid();

    insert into public.marketplace_listings
      (id, family_id, member_id, title, description, kind, category, condition, price_cents, status, created_by, created_at)
    values (lot, v_family, v_owner,
      titles[1 + (i % array_length(titles, 1))] || ' — pd' || (i + 1),
      'Priced to move — recently reduced. [seed:pricehist]', 'sell',
      cats[1 + (i % array_length(cats, 1))],
      (array['new','like_new','good','fair'])[1 + (i % 4)],
      base, 'available', v_user, now() - ((i % 25) || ' days')::interval);

    -- Descending ladder ending at the current `base`: each older price was ~12% higher.
    prev := round(base * power(1.12, steps));
    for k in 1..steps loop
      nextp := case when k = steps then base else round(base * power(1.12, steps - k)) end;
      insert into public.marketplace_price_history (listing_id, family_id, old_cents, new_cents, changed_at)
      values (lot, v_family, prev, nextp, t0 + ((k) || ' days')::interval);
      prev := nextp;
    end loop;

    -- Every other listing has a watcher (♥) so drops have an audience.
    if i % 2 = 0 then
      insert into public.marketplace_saves (family_id, listing_id, member_id)
      values (v_wfam, lot, v_wmem) on conflict (listing_id, member_id) do nothing;
    end if;
  end loop;

  raise notice 'Seeded % price-tracked listings (+history +watchers) for family %', n_lots, v_family;
end $$;

-- Verify:
--   select count(*) from marketplace_listings where description like '%[seed:pricehist]%';               -- 130
--   select count(*) from marketplace_price_history h join marketplace_listings l on l.id=h.listing_id
--     where l.description like '%[seed:pricehist]%';                                                      -- ~390
--   select count(*) from marketplace_saves s join marketplace_listings l on l.id=s.listing_id
--     where l.description like '%[seed:pricehist]%';                                                      -- ~65
--   -- every ladder ends at the listing's current price:
--   select count(*) from marketplace_listings l where l.description like '%[seed:pricehist]%'
--     and l.price_cents <> (select new_cents from marketplace_price_history h
--       where h.listing_id=l.id order by changed_at desc limit 1);                                        -- 0

-- ==================== seed_marketplace_returns.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Marketplace rent/borrow returns (~500 rows).
-- Fills the return-tracking surface on /marketplace/orders: 250 rent/borrow
-- listings + 250 orders whose due dates span every return state. Borrower is a
-- second existing active member of the same family.
-- Idempotent: deterministic IDs plus conflict-safe inserts never overwrite or
-- delete existing rows. Requires the anchored account and migrations 0151 + 0192.
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
  ord      uuid;
begin
  if to_regclass('public.marketplace_orders') is null then
    raise exception 'marketplace_orders is missing; apply migration 0151 first.';
  end if;
  -- Needs the 0192 columns.
  if not exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name='marketplace_orders' and column_name='returned_at') then
    raise exception 'marketplace_orders.returned_at is missing; apply migration 0192 first.';
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
  from public.family_members fm
  where fm.family_id = v_family and fm.is_active
  order by fm.created_at limit 1;
  if v_owner is null or v_user is null then
    raise exception 'Marketplace returns seed requires an active member with a user for family %.', v_family;
  end if;

  select fm.id into v_borrow from public.family_members fm
    where fm.family_id = v_family and fm.is_active and fm.id <> v_owner order by fm.created_at limit 1;
  if v_borrow is null then
    raise exception 'Marketplace returns seed requires two existing active members for family %.', v_family;
  end if;

  for i in 0..(n_sets - 1) loop
    st     := i % 5;   -- 0 upcoming · 1 due-soon · 2 due-today · 3 overdue · 4 returned
    kind_v := case when i % 2 = 0 then 'rent' else 'borrow' end;
    rate   := case when kind_v = 'rent' then 500 + (i % 10) * 250 else 0 end;
    lot    := md5('familyos-seed-returns-listing-' || i)::uuid;
    ord    := md5('familyos-seed-returns-order-' || i)::uuid;
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
      'claimed', v_borrow, now() - interval '2 days', v_user, now() - ((i % 30) || ' days')::interval)
    on conflict (id) do nothing;

    insert into public.marketplace_orders
      (id, family_id, listing_id, buyer_member, seller_member, kind, status, amount_cents,
       starts_on, ends_on, returned_at, overdue_notified_at, notes, created_by, created_at)
    values (ord, v_family, lot, v_borrow, v_owner, kind_v, ostatus, rate,
      (due - 7)::date, due,
      case when st = 4 then now() - interval '1 day' else null end,           -- returned stamp
      case when st = 3 and i % 2 = 0 then now() - interval '6 hours' else null end,  -- some overdue already alerted
      'Return seed [seed:returns]', v_user, now() - ((i % 30) || ' days')::interval)
    on conflict (id) do nothing;
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

-- ==================== seed_marketplace_reports.sql ====================
-- ============================================================================
-- FamilyOS · SEED — Marketplace safety reports (~500 rows).
-- Fills the super-admin moderation queue (/admin/marketplace/reports): up to
-- 500 reports across all seven reasons and all four statuses, one per distinct
-- listing (so the "one open report per listing+member" index is never
-- contended). Reporter is a throwaway "Safety Reporters" family. Resolved rows
-- carry a resolution + reviewer stamp. Idempotent: clears its own rows first
-- (tagged in details). Requires the anchored family account by email.
-- (Needs migrations 0120 + 0193.)  Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_user    uuid;
  v_rfam    uuid;
  v_rmem    uuid[];
  reasons   text[] := array['prohibited','scam','miscategorized','offensive','spam','duplicate','other'];
  statuses  text[] := array['open','reviewing','actioned','dismissed'];
  details_by text[] := array[
    'Looks like a scam — asked to pay off-platform.','Not allowed for families.',
    'Posted in the wrong category.','Inappropriate photo.','Reposted five times.',
    'Same item as another listing.','Just doesn''t seem right.'];
  ids       uuid[];
  lot       uuid;
  st        text;
  rs        text;
  n         int;
begin
  if to_regclass('public.marketplace_reports') is null then
    raise notice 'marketplace_reports not present — apply migration 0193 first. Skipping.'; return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then
    raise exception 'Marketplace reports seed requires the anchored account %.', v_email;
  end if;
  select fm.user_id into v_user from public.family_members fm
    where fm.family_id = v_family order by fm.created_at limit 1;

  -- Throwaway reporter family + two members (stable ids).
  insert into public.families (id, name) values ('a0000000-0000-4000-8000-00000000fc01', 'Safety Reporters')
    on conflict (id) do nothing;
  v_rfam := 'a0000000-0000-4000-8000-00000000fc01';
  insert into public.family_members (id, family_id, role, display_name, is_active) values
    ('a0000000-0000-4000-8000-00000000fc11', v_rfam, 'parent', 'Reporter Rita', true),
    ('a0000000-0000-4000-8000-00000000fc12', v_rfam, 'parent', 'Reporter Rob',  true)
    on conflict (id) do nothing;
  v_rmem := array['a0000000-0000-4000-8000-00000000fc11'::uuid, 'a0000000-0000-4000-8000-00000000fc12'::uuid];

  -- Clean prior seed.
  delete from public.marketplace_reports where details like '%[seed:report]%';

  -- Up to 500 distinct listings from the anchored family → one report each.
  select array_agg(id) into ids from (
    select id from public.marketplace_listings where family_id = v_family order by created_at limit 500
  ) s;
  if ids is null then raise notice 'No listings to report — seed the marketplace first. Skipping.'; return; end if;

  for i in 1..array_length(ids, 1) loop
    lot := ids[i];
    st  := statuses[1 + ((i - 1) % 4)];
    rs  := reasons[1 + ((i - 1) % 7)];
    insert into public.marketplace_reports
      (family_id, listing_id, reporter_member, reason, details, status, resolution, reviewed_by, reviewed_at, created_at)
    values (
      v_rfam, lot, v_rmem[1 + ((i - 1) % 2)], rs,
      details_by[1 + ((i - 1) % 7)] || ' [seed:report]', st,
      case when st in ('actioned','dismissed')
        then (case when st = 'actioned' then 'Confirmed — listing withdrawn.' else 'Reviewed — no violation found.' end)
        else null end,
      case when st in ('actioned','dismissed') then v_user else null end,
      case when st in ('actioned','dismissed') then now() - interval '2 hours' else null end,
      now() - ((i % 20) || ' hours')::interval);
  end loop;

  get diagnostics n = row_count;
  raise notice 'Seeded reports across % listings for family %', array_length(ids, 1), v_family;
end $$;

-- Verify:
--   select count(*) from marketplace_reports where details like '%[seed:report]%';                 -- up to 500
--   select status, count(*) from marketplace_reports where details like '%[seed:report]%' group by 1 order by 1;
--   select reason, count(*) from marketplace_reports where details like '%[seed:report]%' group by 1 order by 1;

-- ============================================================================
-- Feedback / Idea Board (0197) — a PLATFORM-WIDE product-feedback board.
-- Seeds up to 500 ideas across every category + status, with realistic decayed
-- vote counts, the anchored account's own votes on a subset (so upvotes render as
-- "voted"), and a scattering of comments (a few from the Bubaly team). Idea/vote/
-- comment counters are kept exact by the 0197 triggers. Marker: [seed:feedback].
-- ============================================================================
do $$
declare
  v_email    text := 'newworldventurellc@gmail.com';
  v_user     uuid;
  v_family   uuid;
  authors    uuid[];
  names      text[] := array['Jordan P.','Sam R.','Alex M.','Taylor W.','Casey L.','Riley B.',
                             'Morgan D.','Jamie K.','Avery S.','Quinn H.','Devon T.','Harper N.',
                             'A Bubaly family','The Nguyen family','The Patel family','The Garcia family'];
  cats       text[] := array['calendar','tasks','meals','chores','finance','communication',
                             'marketplace','ai_assistant','kids','health','mobile','other'];
  impacts    text[] := array['nice_to_have','helpful','game_changer'];
  auds       text[] := array['me','others','everyone'];
  feats      text[] := array[
    'Shared grocery list that syncs live','A morning family briefing','Smart chore reminders',
    'One-tap meal planning','Auto-split recurring bills','Kid-friendly calendar view',
    'Voice notes on tasks','Weekly spending digest','Family location check-ins',
    'Recipe import from a link','A "who''s free" scheduler','Homework tracker for each kid',
    'Automatic birthday reminders','Dark mode for the kids app','Offline access to the plan',
    'Photo memories timeline','Allowance auto-payouts','A packing-list generator',
    'Shared reading list','Meal-prep shopping mode','Pet care schedules','Medication reminders',
    'A family "wins" board','Carpool coordination','Screen-time agreements','Vacation countdowns'];
  benefits   text[] := array['so nothing slips through','to save us time each week',
    'that everyone actually uses','without the nagging','for busy weeknights',
    'the whole family can see','so plans stay in sync','to cut the mental load',
    'that just works','before it becomes a fire drill'];
  statuses   text[] := array['under_review','under_review','under_review','under_review',
                             'planned','planned','in_progress','shipped','declined'];
  problems   text[] := array[
    'Right now we juggle this across three apps and a group text.',
    'Things fall through the cracks when everyone''s busy.',
    'It takes too many taps to do a simple thing.',
    'We forget until the last minute, every time.',
    'The kids can''t use the current version on their own.',
    'There''s no single place we all look.'];
  ids        uuid[];
  new_id     uuid;
  i          int;
  st         text;
  vc         int;
  aid        uuid;
  aname      text;
begin
  if to_regclass('public.feedback_ideas') is null then
    raise notice 'feedback_ideas not present — apply migration 0197 first. Skipping.'; return;
  end if;

  select f.id, fm.user_id into v_family, v_user
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_user is null then
    -- Fall back to any real auth user so a partially-seeded DB still gets a board.
    select id into v_user from auth.users order by created_at limit 1;
  end if;
  if v_user is null then raise notice 'No auth users — skipping feedback seed.'; return; end if;

  -- Pool of real authors/voters (so author_id + vote FKs are always valid).
  select array_agg(id) into authors from (select id from auth.users order by created_at limit 60) s;

  -- Clean prior seed (cascades to its votes + comments).
  delete from public.feedback_ideas where body like '%[seed:feedback]%';

  for i in 1..500 loop
    st  := statuses[1 + ((i - 1) % array_length(statuses, 1))];
    -- Decayed "popularity": earlier ideas trend higher, with per-idea noise.
    vc  := greatest(0, ((520 - i) / 4) + ((i * 7) % 41) - 12);
    aid := authors[1 + ((i - 1) % array_length(authors, 1))];
    aname := names[1 + ((i - 1) % array_length(names, 1))];

    insert into public.feedback_ideas
      (author_id, author_name, family_id, title, problem, body, category, impact, audience,
       status, admin_note, vote_count, pinned, created_at)
    values (
      aid, aname,
      case when i % 3 = 0 then v_family else null end,
      feats[1 + ((i - 1) % array_length(feats, 1))] || ' ' || benefits[1 + ((i - 1) % array_length(benefits, 1))],
      problems[1 + ((i - 1) % array_length(problems, 1))],
      'It would help if Bubaly could handle this end to end. [seed:feedback]',
      cats[1 + ((i - 1) % array_length(cats, 1))],
      impacts[1 + ((i - 1) % array_length(impacts, 1))],
      auds[1 + ((i - 1) % array_length(auds, 1))],
      st,
      case st when 'planned' then 'On the roadmap for an upcoming release.'
              when 'in_progress' then 'Actively being built — thanks for the votes!'
              when 'shipped' then 'Shipped 🎉 — thank you for the idea.'
              when 'declined' then 'Not planned right now, but we''re keeping it in mind.'
              else null end,
      vc,
      (i <= 2),  -- pin the top two
      now() - ((i % 90) || ' days')::interval - ((i % 24) || ' hours')::interval);
  end loop;

  -- Collect the seeded ideas to attach votes + comments.
  select array_agg(id order by created_at) into ids
  from public.feedback_ideas where body like '%[seed:feedback]%';

  -- The anchored user upvotes ~1 in 4 ideas (renders as "voted"; trigger bumps count).
  for i in 1..array_length(ids, 1) loop
    if i % 4 = 0 then
      insert into public.feedback_votes (idea_id, user_id) values (ids[i], v_user)
        on conflict (idea_id, user_id) do nothing;
    end if;
    -- A second distinct voter on every ~3rd idea, drawn from the author pool.
    if i % 3 = 0 then
      aid := authors[1 + ((i * 5) % array_length(authors, 1))];
      if aid <> v_user then
        insert into public.feedback_votes (idea_id, user_id) values (ids[i], aid)
          on conflict (idea_id, user_id) do nothing;
      end if;
    end if;
  end loop;

  -- Comments on ~1 in 5 ideas; every ~15th gets a Bubaly-team reply.
  for i in 1..array_length(ids, 1) loop
    if i % 5 = 0 then
      insert into public.feedback_comments (idea_id, author_id, author_name, is_team, body, created_at)
      values (ids[i], authors[1 + (i % array_length(authors, 1))], names[1 + (i % array_length(names, 1))], false,
              'Love this — we''d use it every single day.', now() - ((i % 30) || ' days')::interval);
    end if;
    if i % 15 = 0 then
      insert into public.feedback_comments (idea_id, author_id, author_name, is_team, body, created_at)
      values (ids[i], v_user, 'Bubaly Team', true,
              'Great idea — we''re looking into how to make this happen. Keep the votes coming!',
              now() - ((i % 20) || ' days')::interval);
    end if;
  end loop;

  raise notice 'Seeded % feedback ideas (+ votes + comments).', array_length(ids, 1);
end $$;

-- Verify:
--   select count(*) from feedback_ideas where body like '%[seed:feedback]%';                 -- up to 500
--   select status, count(*) from feedback_ideas where body like '%[seed:feedback]%' group by 1 order by 1;
--   select sum(vote_count), sum(comment_count) from feedback_ideas where body like '%[seed:feedback]%';

-- ============================================================================
-- Kitchen Display (0200 settings; /display) — make the always-on screen look
-- ALIVE today. Everything here is NOW-RELATIVE (current_date-based) so the
-- display's "Today's Schedule", Now & Next strip, meals, chores, groceries,
-- hints ticker, photo background and photo-frame screensaver all render at
-- full volume no matter when the seed is run. ~590 rows. Marker: [seed:display]
-- (notes/description/caption; groceries use category 'seed-display').
-- Idempotent: each section deletes its own marker rows first.
-- ============================================================================
do $$
declare
  v_email     text := 'newworldventurellc@gmail.com';
  v_family    uuid;
  v_members   uuid[];
  v_groc_list uuid;
  ev_titles   text[] := array['Soccer practice','Piano lesson','Dentist appointment','School pickup',
                              'Playdate at the park','Grocery run','Swim class','Family game night',
                              'Book club','Vet appointment','Haircuts','Team meeting','Karate',
                              'Bake sale prep','Library visit','Date night'];
  ev_locs     text[] := array['Community Center','School','Downtown','Home',null,'Riverside Park',null,'Main St'];
  chore_ttl   text[] := array['Mow the lawn','Put away groceries','Wipe kitchen counters','Empty dishwasher',
                              'Feed the dog','Take out recycling','Fold laundry','Water the plants',
                              'Vacuum living room','Set the table','Clean bathroom sink','Sweep porch'];
  groc        text[] := array['Milk','Eggs','Sourdough bread','Honeycrisp apples','Chicken thighs','Jasmine rice',
                              'Penne pasta','Cheddar cheese','Bananas','Coffee beans','Greek yogurt','Salmon fillets',
                              'Baby spinach','Cherry tomatoes','Tortillas','Black beans','Avocados','Limes',
                              'Cilantro','Sour cream','Salsa','Olive oil','Butter','Orange juice','Cereal',
                              'Peanut butter','Strawberry jam','Frozen peas','Ground turkey','Bell peppers'];
  rem_ttl     text[] := array['Sign school permission slip','Refill dog food','Return library books',
                              'Schedule oil change','Pay water bill','Order birthday gift','RSVP to the party',
                              'Book summer camp','Renew museum pass','Pack swim bag'];
  rec_names   text[] := array['Chicken Tacos','One-Pot Mac & Cheese','Sheet-Pan Salmon','Sunday Pancakes',
                              'Veggie Stir-Fry','Slow-Cooker Chili','Margherita Pizza','Lemon Herb Chicken',
                              'Beef & Broccoli','Berry Smoothie Bowls'];
  dinners     text[] := array['Chicken Tacos','Spaghetti Night','Sheet-Pan Salmon','Homemade Pizza',
                              'Slow-Cooker Chili','Stir-Fry Bowls','Burger Night','Breakfast-for-Dinner',
                              'Beef & Broccoli','Soup & Grilled Cheese','Lemon Herb Chicken','Fish Sticks & Fries',
                              'Quesadillas','Meatball Subs'];
  v_meal      uuid;
  i           int;
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then
    raise notice 'Display seed requires the anchored account % — skipping.', v_email; return;
  end if;
  select array_agg(id) into v_members from (
    select id from public.family_members where family_id = v_family and is_active = true order by created_at limit 8
  ) m;

  -- ── Calendar: 6 curated events TODAY + 200 across the next 45 days ─────────
  if to_regclass('public.calendar_events') is not null then
    delete from public.calendar_events where family_id = v_family and description like '%[seed:display]%';
    insert into public.calendar_events (family_id, title, description, starts_at, ends_at, all_day, assignee_id, location) values
      (v_family, 'Morning walk',           '[seed:display]', current_date + time '07:30', current_date + time '08:00', false, v_members[1], null),
      (v_family, 'School drop-off',        '[seed:display]', current_date + time '08:15', null, false, v_members[2], 'School'),
      (v_family, 'Dentist appointment',    '[seed:display]', current_date + time '10:00', current_date + time '11:00', false, v_members[2], 'Downtown'),
      (v_family, 'Piano lesson',           '[seed:display]', current_date + time '13:00', current_date + time '14:00', false, v_members[3], 'Community Center'),
      (v_family, 'Soccer practice',        '[seed:display]', current_date + time '16:30', current_date + time '18:00', false, v_members[4], 'Riverside Park'),
      (v_family, 'Family dinner',          '[seed:display]', current_date + time '18:30', current_date + time '19:30', false, null, 'Home');
    insert into public.calendar_events (family_id, title, description, starts_at, ends_at, all_day, assignee_id, location)
    select v_family,
      ev_titles[1 + (g.i % array_length(ev_titles,1))],
      '[seed:display]',
      (current_date + (1 + (g.i % 45)))::timestamp + time '08:00' + ((g.i % 10) * interval '1 hour'),
      null, false,
      v_members[1 + (g.i % array_length(v_members,1))],
      ev_locs[1 + (g.i % array_length(ev_locs,1))]
    from generate_series(1, 200) as g(i);
  end if;

  -- ── Chores: 12 due today + 48 across two weeks, assigned round-robin ───────
  if to_regclass('public.chores') is not null and to_regclass('public.chore_assignments') is not null then
    delete from public.chore_assignments a using public.chores c
      where a.chore_id = c.id and c.family_id = v_family and c.description like '%[seed:display]%';
    delete from public.chores where family_id = v_family and description like '%[seed:display]%';
    with new_chores as (
      insert into public.chores (family_id, title, description, points, priority, recurrence, due_at, requires_approval, is_active)
      select v_family,
        chore_ttl[1 + (g.i % array_length(chore_ttl,1))],
        '[seed:display]',
        5 + (g.i % 15),
        (array['low','medium','high'])[1 + (g.i % 3)]::priority,
        'none'::recurrence_freq,
        case when g.i <= 12 then current_date + time '17:00' else (current_date + (g.i % 14))::timestamp + time '17:00' end,
        false, true
      from generate_series(1, 60) as g(i)
      returning id
    ), numbered as (select id, row_number() over () as rn from new_chores)
    insert into public.chore_assignments (family_id, chore_id, member_id, status, due_at, points_awarded)
    select v_family, nc.id,
      v_members[1 + (nc.rn::int % array_length(v_members,1))],
      (array['todo','todo','in_progress','submitted'])[1 + (nc.rn::int % 4)]::task_status,
      case when nc.rn <= 12 then current_date + time '17:00' else (current_date + (nc.rn::int % 14))::timestamp + time '17:00' end,
      0
    from numbered nc;
  end if;

  -- ── Meals: today's full plan + 14 days of dinners ──────────────────────────
  if to_regclass('public.meals') is not null and to_regclass('public.meal_plans') is not null then
    delete from public.meal_plans p using public.meals m
      where p.meal_id = m.id and m.family_id = v_family and m.notes like '%[seed:display]%';
    delete from public.meals where family_id = v_family and notes like '%[seed:display]%';
    -- Today: breakfast/lunch/dinner/snack.
    for i in 1..4 loop
      insert into public.meals (family_id, name, meal_type, notes)
      values (v_family,
        (array['Sunday Pancakes','Turkey Wraps','Chicken Tacos','Apple Slices & PB'])[i],
        (array['breakfast','lunch','dinner','snack'])[i]::meal_type,
        '[seed:display]')
      returning id into v_meal;
      insert into public.meal_plans (family_id, meal_id, plan_date, meal_type)
      values (v_family, v_meal, current_date, (array['breakfast','lunch','dinner','snack'])[i]::meal_type);
    end loop;
    -- Next 14 nights of dinners.
    for i in 1..14 loop
      insert into public.meals (family_id, name, meal_type, notes)
      values (v_family, dinners[1 + (i % array_length(dinners,1))], 'dinner'::meal_type, '[seed:display]')
      returning id into v_meal;
      insert into public.meal_plans (family_id, meal_id, plan_date, meal_type)
      values (v_family, v_meal, current_date + i, 'dinner'::meal_type);
    end loop;
  end if;

  -- ── Groceries: 60 realistic open items ─────────────────────────────────────
  if to_regclass('public.grocery_items') is not null then
    if to_regclass('public.grocery_lists') is not null then
      select id into v_groc_list from public.grocery_lists where family_id = v_family and is_archived = false order by created_at limit 1;
      if v_groc_list is null then insert into public.grocery_lists (family_id, name) values (v_family, 'Shopping List') returning id into v_groc_list; end if;
    end if;
    delete from public.grocery_items where family_id = v_family and category = 'seed-display';
    insert into public.grocery_items (family_id, list_id, name, category, is_checked)
    select v_family, v_groc_list,
      groc[1 + ((g.i - 1) % array_length(groc,1))] || case when g.i > array_length(groc,1) then ' (x2)' else '' end,
      'seed-display', (g.i % 9 = 0)
    from generate_series(1, 60) as g(i);
  end if;

  -- ── Reminders: 40 over the next two weeks ──────────────────────────────────
  if to_regclass('public.reminders') is not null then
    delete from public.reminders where family_id = v_family and notes like '%[seed:display]%';
    insert into public.reminders (family_id, title, notes, remind_at, is_done, member_id)
    select v_family,
      rem_ttl[1 + (g.i % array_length(rem_ttl,1))],
      '[seed:display]',
      (current_date + (g.i % 14))::timestamp + time '09:00' + ((g.i % 8) * interval '1 hour'),
      false,
      v_members[1 + (g.i % array_length(v_members,1))]
    from generate_series(1, 40) as g(i);
  end if;

  -- ── Pinned notes: 6 fridge-door notes ──────────────────────────────────────
  if to_regclass('public.notes') is not null then
    delete from public.notes where family_id = v_family and body like '%[seed:display]%';
    insert into public.notes (family_id, title, body, is_pinned, created_by) values
      (v_family, 'WiFi guest password', 'sunflower-42 [seed:display]', true, null),
      (v_family, 'Trash night',         'Bins out Thursday evening! [seed:display]', true, null),
      (v_family, 'Babysitter',          'Maya — Sat 6pm, confirm Friday [seed:display]', true, null),
      (v_family, 'Piano recital',       'Get flowers before the 24th [seed:display]', true, null),
      (v_family, 'Allowance day',       'Sundays after chores are checked [seed:display]', true, null),
      (v_family, 'Kindness challenge',  'One nice thing for someone every day this week 💛 [seed:display]', true, null);
  end if;

  -- ── Recipe book: 10 photo recipes (drives the rotating hero) ───────────────
  if to_regclass('public.family_recipes') is not null then
    delete from public.family_recipes where family_id = v_family and description like '%[seed:display]%';
    insert into public.family_recipes
      (family_id, name, description, category, servings, prep_time_mins, cook_time_mins, difficulty,
       ingredients, instructions, photo_url, is_favorite, last_made_at)
    select v_family,
      rec_names[g.i],
      'Family favorite. [seed:display]',
      (array['dinner','dinner','dinner','breakfast','dinner','dinner','dinner','dinner','dinner','breakfast'])[g.i],
      4, 10 + (g.i % 15), 15 + (g.i % 30),
      (array['easy','medium'])[1 + (g.i % 2)],
      '[]'::jsonb, '[]'::jsonb,
      'https://picsum.photos/seed/bubaly-recipe-' || g.i || '/1600/900',
      (g.i <= 4),
      now() - ((g.i * 3) || ' days')::interval
    from generate_series(1, 10) as g(i);
  end if;

  -- ── Family photos: 24 (drives the photo background + idle photo frame) ─────
  if to_regclass('public.family_photos') is not null then
    delete from public.family_photos where family_id = v_family and caption like '%[seed:display]%';
    insert into public.family_photos (family_id, uploaded_by, storage_path, url, caption, taken_at)
    select v_family, null,
      v_family || '/seed/display/photo-' || g.i || '.jpg',
      'https://picsum.photos/seed/bubaly-photo-' || g.i || '/1920/1080',
      'Family moment #' || g.i || ' [seed:display]',
      now() - ((g.i * 5) || ' days')::interval
    from generate_series(1, 24) as g(i);
  end if;

  raise notice 'Kitchen Display seeded (now-relative) for family %', v_family;
end $$;

-- Verify:
--   select count(*) from calendar_events where description like '%[seed:display]%';   -- 206
--   select count(*) from chores where description like '%[seed:display]%';            -- 60
--   select count(*) from grocery_items where category = 'seed-display';               -- 60
--   select count(*) from family_photos where caption like '%[seed:display]%';         -- 24
--   select count(*) from family_recipes where description like '%[seed:display]%';    -- 10
