-- Bubaly :: 0322 A review belongs to whoever wrote it
-- ----------------------------------------------------------------------------
-- 0321 fixed the marketplace's order and offer UPDATE policies. Censusing for
-- the same shape — an authorship column pinned on INSERT and left editable on
-- UPDATE — turned up three more tables, and on these the UPDATE policy does not
-- even restrict to the row's owner:
--
--   marketplace_reviews_update  using/with check (is_family_member(family_id))
--   marketplace_saves_update    using/with check (is_family_member(family_id))
--   marketplace_follows_update  using/with check (is_family_member(family_id))
--
-- against INSERT policies that 0154 wrote as, respectively,
-- `reviewer_member = marketplace_member_id(family_id)` and
-- `member_id = marketplace_member_id(family_id)`. So the identity 0154 refuses
-- to let you forge on the way in is rewritable the moment the row exists — and
-- reviews are read as a rating:
--
--   marketplace/item/[id]/page.tsx:82       avg rating for a seller
--   marketplace/creators/[id]/page.tsx:54   the reviews on a creator profile
--   marketplace/creators/page.tsx:29        every reviewee's rating
--   marketplace/store/page.tsx:35           your own rating
--
-- Any member of the family could turn another member's one-star review of them
-- into five stars, or point `reviewee_member` at somebody else. That is the same
-- trust-score forgery C1-S6-08 found on orders, one table over.
--
-- NOTHING IN THE TREE UPDATES ANY OF THE THREE. Not a client, not a server
-- action, not an RPC, not the crons: the only write to `marketplace_reviews` is
-- `leaveReviewAction`'s insert (app/(app)/marketplace/actions.ts:175), and saves
-- and follows are inserted and deleted only. These policies grant a capability
-- no feature uses.
--
-- They are scoped to the row's owner rather than dropped. "Edit your own review"
-- is a plausible thing this product will want, the policies were clearly meant
-- to say that already, and a policy that matches its evident intent is easier to
-- reason about later than an absence someone has to reconstruct.
--
-- ── Why 0321's trigger function is replaced ────────────────────────────────
-- 0321 wrote `marketplace_parties_are_immutable()`, which branches on
-- `tg_table_name` with an `else`. Adding a third, fourth and fifth table to that
-- shape means editing the function every time and an `else` that silently
-- handles the wrong table. This migration replaces it with a generic helper that
-- takes its column list from the trigger definition, and re-points 0321's two
-- triggers at it — same behaviour, stated per table at the point of attachment.
--
-- The helper refuses to run against a column that does not exist. A typo'd
-- column name in a trigger definition would otherwise compare NULL to NULL and
-- report the boundary as held while guarding nothing, which is the defect class
-- this audit has spent most of its length on.
--
-- Additive to the data; policies, triggers and functions replaced by name, so it
-- is idempotent. Asserted by docs/audit/marketplace-ownership-update-check.sql,
-- which CI replays with the rest of docs/audit/*-check.sql.

-- ── Columns that record a fact, not a field ────────────────────────────────
create or replace function public.columns_are_immutable()
returns trigger language plpgsql set search_path = public as $$
declare
  col text;
  before jsonb := to_jsonb(old);
  after  jsonb := to_jsonb(new);
begin
  -- Only for callers row security applies to. A `SECURITY DEFINER` RPC or the
  -- service role is the mechanism that legitimately sets these columns.
  if not row_security_active(tg_relid::regclass::text) then
    return new;
  end if;
  foreach col in array tg_argv loop
    if not (after ? col) then
      raise exception 'immutability trigger % on % names a column that does not exist: %',
        tg_name, tg_table_name, col;
    end if;
    if before -> col is distinct from after -> col then
      raise exception '%.% records who this belongs to; that cannot be edited', tg_table_name, col
        using errcode = 'insufficient_privilege';
    end if;
  end loop;
  return new;
end $$;

comment on function public.columns_are_immutable() is
  'BEFORE UPDATE guard: the columns named in the trigger definition may not change for a caller subject to RLS. Keeps 0154''s object-level authorization from being undone by an UPDATE. Asserted by docs/audit/marketplace-ownership-update-check.sql.';

-- ── 0321's two triggers, re-pointed ────────────────────────────────────────
drop trigger if exists trg_marketplace_orders_parties on public.marketplace_orders;
create trigger trg_marketplace_orders_parties
  before update on public.marketplace_orders
  for each row execute function public.columns_are_immutable(
    'family_id', 'listing_id', 'buyer_member', 'seller_member');

drop trigger if exists trg_marketplace_offers_parties on public.marketplace_offers;
create trigger trg_marketplace_offers_parties
  before update on public.marketplace_offers
  for each row execute function public.columns_are_immutable(
    'family_id', 'listing_id', 'member_id');

drop function if exists public.marketplace_parties_are_immutable();

-- ── Reviews ────────────────────────────────────────────────────────────────
-- The author may revise their own rating and comment. Who wrote it, who it is
-- about and what it is about are settled when it is written.
drop policy if exists marketplace_reviews_update on public.marketplace_reviews;
create policy marketplace_reviews_update on public.marketplace_reviews
  for update
  using (
    public.is_family_member(family_id)
    and reviewer_member = public.marketplace_member_id(family_id)
  )
  with check (
    public.is_family_member(family_id)
    and reviewer_member = public.marketplace_member_id(family_id)
  );

drop trigger if exists trg_marketplace_reviews_subject on public.marketplace_reviews;
create trigger trg_marketplace_reviews_subject
  before update on public.marketplace_reviews
  for each row execute function public.columns_are_immutable(
    'family_id', 'order_id', 'listing_id', 'reviewer_member', 'reviewee_member', 'role');

-- ── Saves and follows ──────────────────────────────────────────────────────
-- Per-member rows whose whole content is the membership they record.
drop policy if exists marketplace_saves_update on public.marketplace_saves;
create policy marketplace_saves_update on public.marketplace_saves
  for update
  using (
    public.is_family_member(family_id)
    and member_id = public.marketplace_member_id(family_id)
  )
  with check (
    public.is_family_member(family_id)
    and member_id = public.marketplace_member_id(family_id)
  );

drop trigger if exists trg_marketplace_saves_owner on public.marketplace_saves;
create trigger trg_marketplace_saves_owner
  before update on public.marketplace_saves
  for each row execute function public.columns_are_immutable('family_id', 'member_id');

drop policy if exists marketplace_follows_update on public.marketplace_follows;
create policy marketplace_follows_update on public.marketplace_follows
  for update
  using (
    public.is_family_member(family_id)
    and member_id = public.marketplace_member_id(family_id)
  )
  with check (
    public.is_family_member(family_id)
    and member_id = public.marketplace_member_id(family_id)
  );

drop trigger if exists trg_marketplace_follows_owner on public.marketplace_follows;
create trigger trg_marketplace_follows_owner
  before update on public.marketplace_follows
  for each row execute function public.columns_are_immutable('family_id', 'member_id');
