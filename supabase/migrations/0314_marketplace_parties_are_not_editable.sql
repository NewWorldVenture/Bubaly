-- Bubaly :: 0314 An order records who the deal was with, and that is not a field
-- ----------------------------------------------------------------------------
-- 0154 exists to stop exactly this. Its own header says prior policies gated
-- the marketplace "by family membership ALONE, so any member could edit another
-- member's listing/store, accept offers they don't own, or forge saves/offers/
-- reviews with a spoofed member id (inflating trust scores)", and it fixed that
-- by tying every INSERT to the acting member and every UPDATE to the row owner.
--
-- The UPDATE half was only half done. Both policies it wrote end:
--
--     using (... and (buyer_member = marketplace_member_id(family_id)
--                     or seller_member = marketplace_member_id(family_id)))
--     with check (public.is_family_member(family_id))
--
-- `using` picks which rows you may touch; `with check` decides what the row is
-- allowed to BECOME. Writing the weaker predicate in the second slot means the
-- ownership test governs the row you start from and nothing at all about the
-- row you end with — so a party may edit itself out of the deal, or another
-- member into it.
--
-- Measured against the replayed schema before this migration
-- (docs/audit/marketplace-ownership-update-check.sql), as member C who was the
-- BUYER on a completed order:
--
--     update marketplace_orders set seller_member = <C> where id = <order>;
--     -- NOTICE: orders: buyer rewrote seller_member on 1 row(s)
--     -- NOTICE: reputation read: C now shows 1 completed sale(s)
--
-- That last number is not hypothetical. `marketplace/item/[id]/page.tsx:87` and
-- `marketplace/creators/[id]/page.tsx:58` both count
-- `marketplace_orders where seller_member = <them> and status = 'completed'`
-- and show it as the seller's track record. A member who buys twenty things can
-- claim twenty sales. That is the trust-score forgery 0154 named and closed on
-- the INSERT path, reopened on the UPDATE path.
--
-- The offers policy has the same shape: the offer's own author, or the listing
-- owner who may touch every offer on their listing, could reassign `member_id`
-- to somebody else — re-planting the spoofed member id that
-- `marketplace_offers_insert` refuses outright.
--
-- TIGHTENING `with check` TO MATCH `using` IS NOT ENOUGH, AND THE FIRST DRAFT OF
-- THIS MIGRATION DID EXACTLY THAT AND STAYED RED. The predicate is symmetric:
-- C setting `seller_member = C` produces a row on which C IS a party, so a
-- check written as "the caller is the buyer or the seller" passes the very
-- write it is meant to stop. RLS cannot see the old row, so no `with check`
-- can express "you may not change who the parties are".
--
-- So the identity columns are made immutable by a trigger, which is the shape
-- of the invariant: after insert, `family_id`, `listing_id` and the two party
-- columns are facts about a deal that happened, not fields. It fires only when
-- row security is active for the caller (`row_security_active`), so the
-- `SECURITY DEFINER` RPCs and the service role — the paths that legitimately
-- create and close these rows — are untouched.
--
-- The `with check` clauses are tightened anyway. They are no longer the load-
-- bearing part, but 0154's own comments claim the policies already say this
-- ("only the two parties may advance the lifecycle"), and a policy whose
-- comment overstates it is how this defect survived two years.
--
-- NOTHING LEGITIMATE LOSES ACCESS. Every write to either table in the tree was
-- read: `setOrderStatusAction` (app/(app)/marketplace/actions.ts:147) updates
-- `status` alone; `marketplace_complete_handoff` (0199) updates `status` alone;
-- the return-reminder cron writes two timestamps through the service client;
-- the auction close and accept-offer RPCs INSERT orders and never re-point an
-- existing one; and no client anywhere updates `marketplace_offers` at all.
-- Not one of them touches a party column after the row exists.
--
-- Policies and trigger dropped and recreated by name, no data change;
-- idempotent. The boundary is asserted by
-- docs/audit/marketplace-ownership-update-check.sql, which CI replays with the
-- rest of docs/audit/*-check.sql.

-- ── The parties to a deal are not editable fields ───────────────────────────
create or replace function public.marketplace_parties_are_immutable()
returns trigger language plpgsql set search_path = public as $$
begin
  -- Only for callers row security applies to. A definer RPC or the service
  -- role is the mechanism that legitimately sets these columns.
  if not row_security_active(tg_relid::regclass::text) then
    return new;
  end if;
  if tg_table_name = 'marketplace_orders' then
    if new.family_id     is distinct from old.family_id
    or new.listing_id    is distinct from old.listing_id
    or new.buyer_member  is distinct from old.buyer_member
    or new.seller_member is distinct from old.seller_member then
      raise exception 'A marketplace order records who the deal was with; that cannot be edited'
        using errcode = 'insufficient_privilege';
    end if;
  else
    if new.family_id  is distinct from old.family_id
    or new.listing_id is distinct from old.listing_id
    or new.member_id  is distinct from old.member_id then
      raise exception 'A marketplace offer records who made it; that cannot be edited'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end $$;

comment on function public.marketplace_parties_are_immutable() is
  'Keeps 0154''s object-level authorization from being undone by an UPDATE: a party may advance their own deal but may not rewrite whose deal it is. Asserted by docs/audit/marketplace-ownership-update-check.sql.';

drop trigger if exists trg_marketplace_orders_parties on public.marketplace_orders;
create trigger trg_marketplace_orders_parties
  before update on public.marketplace_orders
  for each row execute function public.marketplace_parties_are_immutable();

drop trigger if exists trg_marketplace_offers_parties on public.marketplace_offers;
create trigger trg_marketplace_offers_parties
  before update on public.marketplace_offers
  for each row execute function public.marketplace_parties_are_immutable();

-- ── And the policies say what their comments always claimed ─────────────────
drop policy if exists marketplace_offers_update on public.marketplace_offers;
create policy marketplace_offers_update on public.marketplace_offers
  for update
  using (
    public.is_family_member(family_id)
    and (
      member_id = public.marketplace_member_id(family_id)
      or exists (
        select 1 from public.marketplace_listings l
        where l.id = listing_id and l.member_id = public.marketplace_member_id(family_id)
      )
    )
  )
  with check (
    public.is_family_member(family_id)
    and (
      member_id = public.marketplace_member_id(family_id)
      or exists (
        select 1 from public.marketplace_listings l
        where l.id = listing_id and l.member_id = public.marketplace_member_id(family_id)
      )
    )
  );

drop policy if exists marketplace_orders_update on public.marketplace_orders;
create policy marketplace_orders_update on public.marketplace_orders
  for update
  using (
    public.is_family_member(family_id)
    and (
      buyer_member = public.marketplace_member_id(family_id)
      or seller_member = public.marketplace_member_id(family_id)
    )
  )
  with check (
    public.is_family_member(family_id)
    and (
      buyer_member = public.marketplace_member_id(family_id)
      or seller_member = public.marketplace_member_id(family_id)
    )
  );
