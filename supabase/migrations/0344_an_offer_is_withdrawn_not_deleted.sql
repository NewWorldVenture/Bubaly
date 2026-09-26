-- Bubaly :: 0344 - a marketplace offer is withdrawn, not deleted by a sibling
--
-- marketplace_offers INSERT and UPDATE are already the offerer's (or, for a
-- decision, the listing's seller), but DELETE was any family member's. So a
-- sibling could make someone's offer - or the accepted one - simply vanish,
-- and marketplace_offer_flip_pending would reopen the listing. Nothing in the
-- application deletes an offer: an offer is withdrawn or declined by UPDATE.
-- The member DELETE policy is dropped.
--
-- Pinned by docs/audit/marketplace-offer-check.sql.

do $$
begin
  if to_regclass('public.marketplace_offers') is not null then
    drop policy if exists marketplace_offers_delete on public.marketplace_offers;
  end if;
end
$$;
