-- 0505 — A listing other families hold records of is withdrawn, not erased.
-- Decided by the account holder on the lead in #771 comment 6097101249; found
-- 2026-10-10 in the cascade census behind 0502.
--
-- marketplace_listings_delete lets a listing's own seller delete it
-- (is_family_member(family_id) and member_id = marketplace_member_id(family_id)),
-- and components/modules/marketplace-module.tsx offers that hard delete as
-- "Remove". Every table that records a dealing with the listing cascades on
-- listing_id: marketplace_orders, _offers, _questions, _bids, _negotiations,
-- _negotiation_rounds, _handoffs and _reports. Those rows are other families'
-- (a report carries the reporter's family, an order the buyer's), and RLS does
-- not gate a cascade. Measured on a replay of every runnable migration: Seller
-- House lists a bike; Buyer House has a confirmed order on it and has filed a
-- report ("scam"). As Seller House's parent, under PostgREST's role:
--
--   delete the listing                                  1 row
--   Buyer House's confirmed order afterwards            0
--   Buyer House's scam report afterwards                0
--
-- So a reported seller removed the evidence and the buyer's record of the deal
-- in one tap.
--
-- This adds a BEFORE DELETE guard on marketplace_listings, SECURITY DEFINER so
-- it sees every family's rows: a signed-in caller's delete of a listing that
-- has any order, offer, question, bid, negotiation (or round), handoff or
-- report is refused (42501, its own sentence). Such a listing is withdrawn
-- instead (marketplace_set_listing_status), which keeps every record; the
-- module's Remove does exactly that when this refuses. A listing with none of
-- those still deletes as before. Reviews already survive a delete (ON DELETE
-- SET NULL); saves, collection items, matches, shares and price history are
-- the listing's own or a bookmark, and still go with it.
--
-- The service role and session-less writers are exempt, as in every guard of
-- this family, and a family being deleted still takes its listings: by the
-- time that cascade reaches a listing the family row is gone (0502's branch).
--
-- No race with a record inserted alongside: a DELETE locks the listing row FOR
-- UPDATE before this trigger runs, which waits for the KEY SHARE an in-flight
-- insert's foreign key holds, and this trigger's statement then sees that
-- record once it commits (the timing 0502's two-session probe proves).
--
-- HELD: 0505, the first number above 0504, requested on #771 in comment
-- 6100826185 and not yet confirmed. It stays in supabase/reserved/ until every
-- number below it has landed. Proven by
-- docs/audit/reserved/a-listing-others-hold-records-of-is-withdrawn-not-erased-check.sql
-- and .github/workflows/marketplace-records-runtime.yml. Not applied to
-- production by an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
declare t text;
begin
  foreach t in array array['marketplace_listings', 'marketplace_orders', 'marketplace_offers',
                           'marketplace_questions', 'marketplace_bids', 'marketplace_negotiations',
                           'marketplace_negotiation_rounds', 'marketplace_handoffs', 'marketplace_reports'] loop
    if to_regclass('public.' || t) is null then
      raise exception '0505 needs public.%', t;
    end if;
  end loop;
end
$$;

create or replace function public.marketplace_listing_keeps_others_records()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- The trusted server (service role, or a migration/seed with no session).
  if current_user = 'service_role'
     or coalesce(auth.role(), '') = 'service_role'
     or auth.uid() is null then
    return old;
  end if;
  -- A family being deleted takes its listings: by the time the cascade reaches
  -- a listing, the family row is gone.
  if not exists (select 1 from public.families f where f.id = old.family_id) then
    return old;
  end if;
  if exists (select 1 from public.marketplace_orders x where x.listing_id = old.id)
     or exists (select 1 from public.marketplace_offers x where x.listing_id = old.id)
     or exists (select 1 from public.marketplace_questions x where x.listing_id = old.id)
     or exists (select 1 from public.marketplace_bids x where x.listing_id = old.id)
     or exists (select 1 from public.marketplace_negotiations x where x.listing_id = old.id)
     or exists (select 1 from public.marketplace_negotiation_rounds x where x.listing_id = old.id)
     or exists (select 1 from public.marketplace_handoffs x where x.listing_id = old.id)
     or exists (select 1 from public.marketplace_reports x where x.listing_id = old.id) then
    raise exception 'A listing other families hold records of is withdrawn, not removed'
      using errcode = '42501';
  end if;
  return old;
end
$$;

comment on function public.marketplace_listing_keeps_others_records() is
  'Refuses (42501) a signed-in caller deleting a marketplace listing that has any order, offer, question, bid, negotiation or round, handoff or report, since the ON DELETE CASCADE would erase other families'' records of it (0505); such a listing is withdrawn instead. The service role, session-less writers and a family deletion cascade are unaffected.';

revoke all on function public.marketplace_listing_keeps_others_records() from public;

drop trigger if exists trg_marketplace_listing_keeps_others_records on public.marketplace_listings;
create trigger trg_marketplace_listing_keeps_others_records
  before delete on public.marketplace_listings
  for each row execute function public.marketplace_listing_keeps_others_records();

do $$
begin
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.marketplace_listings'::regclass
                    and t.tgname = 'trg_marketplace_listing_keeps_others_records'
                    and t.tgfoid = 'public.marketplace_listing_keeps_others_records()'::regprocedure
                    and t.tgenabled <> 'D'
                    and (t.tgtype & 2) = 2      -- BEFORE
                    and (t.tgtype & 1) = 1      -- ROW
                    and (t.tgtype & 8) = 8) then -- DELETE
    raise exception '0505: marketplace_listings does not carry the enabled BEFORE DELETE row guard';
  end if;
  if not exists (select 1 from pg_proc f
                  where f.oid = 'public.marketplace_listing_keeps_others_records()'::regprocedure
                    and f.prosecdef
                    and exists (select 1 from unnest(f.proconfig) c where c ~ '^search_path=')) then
    raise exception '0505: the guard is not SECURITY DEFINER with a pinned search_path';
  end if;
end
$$;
