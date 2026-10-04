-- Bubaly :: 0489 a notification is written once per occurrence
-- ----------------------------------------------------------------------------
-- Both writers of public.notifications decide what to write with a READ, then
-- INSERT: the engine (lib/server/notifications.ts) reads the keys it is about
-- to announce and skips the ones already there; notify() (lib/services/
-- notifications) reads the unread copies of its key. Nothing in the database
-- stood behind either read. Two of the engine's callers run for one family at
-- the same minute — the daily `notifications` cron and the two-hourly
-- `push-scan` are each mirrored by Vercel and the GitHub dispatcher — so two
-- runs could both read "not yet announced" and both write: one duplicate per
-- occurrence per concurrent pair, for every candidate type the engine writes.
-- (Audit note of 2026-10-04 07:34 UTC on #936.)
--
-- THE KEY. (family_id, type, related_id, user_id). `related_id` has been a
-- dedupe KEY, not a uuid, since 0293: the engine names the occurrence in it
-- (`moment:<event>:<date>`, `<renewal>:<expires_at>`, `<document>:<day>:<manager>`,
-- and from this unit `<medication>:<day>`), and notify() dedupes on it when the
-- caller gives one. `user_id` is NULL for the family-wide row, and two
-- family-wide copies of one occurrence are the duplicate this is about, so the
-- index treats NULLs as equal (NULLS NOT DISTINCT, Postgres 15).
--
-- THE PREDICATE. Unread rows with a key. notify() dedupes against UNREAD copies
-- by default — a later notice under the same key is legitimate once the first
-- was read, and only `once: true` widens that to ever — so an index over every
-- row would refuse that second, legitimate notice. A concurrent duplicate is
-- always unread at the instant it is written, so `is_read = false` still
-- refuses exactly the race; a row that is read leaves the index and notify()'s
-- rule is kept as it is. Rows with no key dedupe by title in notify() and are
-- outside this index.
--
-- WHAT A REFUSAL MEANS TO THE WRITERS. Postgres refuses the whole statement for
-- one duplicate row. Both writers insert a batch, so on 23505 each writes the
-- batch again one row at a time and leaves out only the rows the index refuses
-- (lib/notifications/insert-once.ts). The engine counts them in its log;
-- notify() counts them as duplicates. Nothing else about either changes.
--
-- THE ONE WRITER IN THE DATABASE. 0191's price-drop trigger writes a
-- family-wide `system` row keyed by the listing to every family that saved it.
-- A second drop while that row is unread would now be refused — inside a
-- trigger, where it would fail the seller's price change. The function below
-- is 0191's body with ON CONFLICT DO NOTHING on that insert: the family keeps
-- the notice it has not read yet, and the price change goes through. (No other
-- migration writes notifications: `grep -il 'into public.notifications'
-- supabase/migrations` names 0191 and this file; 0301 only quotes a statement.)
--
-- PRE-FLIGHT, READ ONLY, to be run and recorded BEFORE this is applied anywhere
-- with data. The index cannot be created over existing duplicates, so this is
-- what the repair below will touch — and the operator should see it first:
--
--   select family_id, type, related_id, user_id, count(*)
--     from public.notifications
--    where related_id is not null and is_read = false
--    group by 1, 2, 3, 4 having count(*) > 1;
--
-- THE REPAIR, AND WHY IT DELETES NOTHING. Of each group of UNREAD rows under one
-- key, the oldest (created_at, then id) stays unread and the others are marked
-- READ. Every row is kept: a member who opens their history sees what was sent
-- and when; the unread badge counts one notice for one occurrence, which is
-- what it was meant to count; and the index can be built. A delete would reach
-- the same index with less history, so it is not used. Read rows and rows with
-- no key are not touched. Re-applying this file (LB-016 §4) finds no group with
-- more than one unread row and changes nothing.
--
-- WHAT CHANGES FOR A MEMBER, exactly: only rows that are exact unread copies of
-- an older unread row — same family, type, key and recipient — move from unread
-- to read. The member's unread count drops by the number of such copies and by
-- nothing else; the copy they keep unread is the first one written; no title,
-- body, time or recipient changes; nothing is removed from their history. The
-- pre-flight above lists every such group before anything runs. This file is a
-- repository candidate: it is not to be run against any existing dataset until
-- that listing has been reviewed and the execution hold on #699 is lifted.
--
-- THE TRIGGER CHANGE IS THE INDEX'S OWN. `marketplace_log_price_change()` is
-- re-created here, not in a file of its own, because the two cannot be applied
-- apart: with the index and without the ON CONFLICT clause a second price drop
-- on a saved listing fails the seller's UPDATE (23505 raised inside the
-- trigger); with the clause and without the index the clause is inert. The
-- function body is otherwise 0191's, statement for statement; the probe asserts
-- what it still does (every change logged, a read watcher told again, a rise
-- telling nobody).
--
-- Verified on a replayed database: before, two inserts of one key both land;
-- after, the second is refused with 23505 naming the index, the family-wide
-- pair likewise, a key whose first row is read takes a second, and a listing
-- saved by another family can drop its price twice.

-- 1. The price-drop trigger steps aside where the index refuses it.
create or replace function public.marketplace_log_price_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_old text := '$' || to_char(old.price_cents / 100.0, 'FM999990.00');
  v_new text := '$' || to_char(new.price_cents / 100.0, 'FM999990.00');
begin
  -- Only meaningful for fixed-price sale listings (auctions carry price_cents=0).
  if coalesce(new.sale_format, 'fixed') = 'auction' then return new; end if;

  insert into public.marketplace_price_history (listing_id, family_id, old_cents, new_cents)
  values (new.id, new.family_id, old.price_cents, new.price_cents);

  -- A genuine drop on a still-available listing → alert every watcher (♥).
  -- 0489: a watcher who has not read the previous drop's notice keeps that one;
  -- the index refuses a second unread copy, and the price change must not fail
  -- on a courtesy notice.
  if new.price_cents < old.price_cents and new.price_cents > 0
     and new.status in ('available', 'pending') then
    insert into public.notifications (family_id, user_id, type, title, body, related_type, related_id)
    select distinct s.family_id, null::uuid, 'system'::public.notification_type,
      'Price dropped: "' || left(new.title, 60) || '"',
      v_old || ' → ' || v_new || ' — you saved this. Grab it before it''s gone.',
      'marketplace_listings', new.id
    from public.marketplace_saves s
    where s.listing_id = new.id
    on conflict do nothing;
  end if;

  return new;
end $$;

-- 2. The repair: the oldest unread row of each key stays unread; the others are
--    marked read. Nothing is deleted.
with ranked as (
  select id,
         row_number() over (partition by family_id, type, related_id, user_id order by created_at, id) as rn
    from public.notifications
   where related_id is not null and is_read = false
)
update public.notifications n
   set is_read = true
  from ranked r
 where r.id = n.id and r.rn > 1;

-- 3. The index.
create unique index if not exists uq_notifications_unread_occurrence
  on public.notifications (family_id, type, related_id, user_id) nulls not distinct
  where related_id is not null and is_read = false;

-- 4. Say so, or fail.
do $$
declare
  def text;
begin
  select indexdef into def from pg_indexes
   where schemaname = 'public' and tablename = 'notifications' and indexname = 'uq_notifications_unread_occurrence';
  if def is null then
    raise exception '0489 FAILED: uq_notifications_unread_occurrence was not created';
  end if;
  if def not like '%UNIQUE INDEX%' or def not like '%(family_id, type, related_id, user_id) NULLS NOT DISTINCT%'
     or def not like '%WHERE ((related_id IS NOT NULL) AND (is_read = false))%' then
    raise exception '0489 FAILED: uq_notifications_unread_occurrence is not the index this migration describes: %', def;
  end if;
  if (select count(*) from (
        select 1 from public.notifications
         where related_id is not null and is_read = false
         group by family_id, type, related_id, user_id having count(*) > 1) d) > 0 then
    raise exception '0489 FAILED: unread duplicates remain under the index';
  end if;
  raise notice '0489 OK: a notification is written once per unread occurrence; the price-drop trigger steps aside.';
end $$;
