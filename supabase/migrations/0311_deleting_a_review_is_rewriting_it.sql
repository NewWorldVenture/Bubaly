-- Bubaly :: 0311 Deleting a review is rewriting it
-- ----------------------------------------------------------------------------
-- 0310 stopped a member rewriting another member's review. It did not stop them
-- deleting it, and for a one-star review about yourself those are the same act
-- with the same result on the same four screens. I fixed one verb and did not
-- check the next one in the same pass; this is that check.
--
-- The DELETE policies 0154 left on the four per-member marketplace tables are
-- family-wide, against INSERT policies that pin the author:
--
--   marketplace_reviews_delete   using (is_family_member(family_id))
--   marketplace_offers_delete    using (is_family_member(family_id))
--   marketplace_saves_delete     using (is_family_member(family_id))
--   marketplace_follows_delete   using (is_family_member(family_id))
--
-- Measured before this migration: the member a review was ABOUT deleted it, and
-- a member with no connection to a listing deleted a competing offer on it.
--
-- WHAT THE APPLICATION ACTUALLY DELETES, all of it:
--   * toggleSaveAction and toggleFollowAction (app/(app)/marketplace/actions.ts:55,
--     :85) delete the row they just read back by `member_id = <themselves>`, so
--     scoping the policy to the owner is a no-op for both.
--   * Nothing deletes a review or an offer. Anywhere. The decline and withdraw
--     paths are status updates through the definer RPCs.
--
-- ── One judgement call, made explicitly ────────────────────────────────────
-- Scoping reviews to the author alone would mean a parent cannot remove an
-- abusive review written by a child — a real thing to lose in a product whose
-- reviewers are members of one household. So a family manager may moderate, and
-- the predicate names the one case that would otherwise reopen the defect: a
-- manager may delete any review EXCEPT one about themselves. Without that
-- clause, "the adults can moderate" would hand every adult the exact erasure
-- this migration exists to stop.
--
-- Additive to the data; policies replaced by name, idempotent. Asserted by
-- docs/audit/marketplace-delete-authorship-check.sql, which CI replays with the
-- rest of docs/audit/*-check.sql.

-- ── Reviews ────────────────────────────────────────────────────────────────
drop policy if exists marketplace_reviews_delete on public.marketplace_reviews;
create policy marketplace_reviews_delete on public.marketplace_reviews
  for delete using (
    public.is_family_member(family_id)
    and (
      reviewer_member = public.marketplace_member_id(family_id)
      or (
        public.can_manage_family(family_id)
        and reviewee_member is distinct from public.marketplace_member_id(family_id)
      )
    )
  );

-- ── Offers ─────────────────────────────────────────────────────────────────
-- The same two parties its UPDATE policy names: the member who made the offer,
-- and the owner of the listing it is on.
drop policy if exists marketplace_offers_delete on public.marketplace_offers;
create policy marketplace_offers_delete on public.marketplace_offers
  for delete using (
    public.is_family_member(family_id)
    and (
      member_id = public.marketplace_member_id(family_id)
      or exists (
        select 1 from public.marketplace_listings l
        where l.id = listing_id and l.member_id = public.marketplace_member_id(family_id)
      )
    )
  );

-- ── Saves and follows ──────────────────────────────────────────────────────
drop policy if exists marketplace_saves_delete on public.marketplace_saves;
create policy marketplace_saves_delete on public.marketplace_saves
  for delete using (
    public.is_family_member(family_id)
    and member_id = public.marketplace_member_id(family_id)
  );

drop policy if exists marketplace_follows_delete on public.marketplace_follows;
create policy marketplace_follows_delete on public.marketplace_follows
  for delete using (
    public.is_family_member(family_id)
    and member_id = public.marketplace_member_id(family_id)
  );
