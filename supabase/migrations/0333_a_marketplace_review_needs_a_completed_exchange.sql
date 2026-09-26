-- Bubaly :: 0333 - a marketplace review needs a completed exchange; orders
--                   are made by the marketplace functions, not members
--
-- marketplace_orders   every order is created by a SECURITY DEFINER function
--                      (marketplace_buy_now, _accept_offer, _close_auction,
--                      _negotiation_respond); the member INSERT and DELETE
--                      policies are unused. A member could file an order - say
--                      'completed', between any two members - or delete a real
--                      one. Both are dropped; the party-scoped UPDATE the order
--                      lifecycle uses is unchanged.
--
-- marketplace_reviews  leaveReviewAction writes a review only for a completed
--                      order the caller is a party to, about the other party.
--                      The policy checked only reviewer_member, so any member
--                      could rate any member on any order (or none), and any
--                      family member could edit or delete any review. INSERT
--                      now requires the completed order and the matching sides;
--                      member UPDATE and DELETE (unused) are dropped.
--
-- Pinned by docs/audit/marketplace-review-check.sql.

do $$
begin
  if to_regclass('public.marketplace_orders') is not null then
    drop policy if exists marketplace_orders_insert on public.marketplace_orders;
    drop policy if exists marketplace_orders_delete on public.marketplace_orders;
  end if;

  if to_regclass('public.marketplace_reviews') is not null then
    drop policy if exists marketplace_reviews_update on public.marketplace_reviews;
    drop policy if exists marketplace_reviews_delete on public.marketplace_reviews;
    drop policy if exists marketplace_reviews_insert on public.marketplace_reviews;
    create policy marketplace_reviews_insert on public.marketplace_reviews
      for insert to authenticated
      with check (
        public.is_family_member(family_id)
        and reviewer_member = public.marketplace_member_id(family_id)
        and exists (
          select 1 from public.marketplace_orders o
           where o.id = marketplace_reviews.order_id
             and o.family_id = marketplace_reviews.family_id
             and o.status = 'completed'
             and (
               (marketplace_reviews.role = 'buyer'
                  and o.buyer_member = marketplace_reviews.reviewer_member
                  and o.seller_member = marketplace_reviews.reviewee_member)
               or (marketplace_reviews.role = 'seller'
                  and o.seller_member = marketplace_reviews.reviewer_member
                  and o.buyer_member = marketplace_reviews.reviewee_member)
             )
        )
      );
  end if;
end
$$;
