-- Bubaly :: 0346 - a marketplace pickup is arranged by the two parties
--
-- marketplace_handoffs holds the pickup for an order: when and where, its
-- status, and the hand-off code that completes the exchange. Its INSERT,
-- UPDATE and DELETE policies were family-wide, and the hand-off actions
-- treated anyone who was not the seller as the buyer - so a sibling could
-- propose, confirm (minting the code) or cancel someone else's pickup. The
-- actions now refuse non-parties; RLS says the same: writes need the caller
-- to be the order's buyer or seller. Completion runs through the SECURITY
-- DEFINER marketplace_complete_handoff, which already checks the party.
--
-- Pinned by docs/audit/marketplace-handoff-check.sql.

create or replace function public.is_marketplace_order_party(p_order_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.marketplace_orders o
     where o.id = p_order_id
       and public.marketplace_member_id(o.family_id) in (o.buyer_member, o.seller_member)
  );
$$;
revoke all on function public.is_marketplace_order_party(uuid) from public;
grant execute on function public.is_marketplace_order_party(uuid) to authenticated;

do $$
declare
  p record;
begin
  if to_regclass('public.marketplace_handoffs') is null then
    return;
  end if;
  for p in select policyname from pg_policies
            where schemaname = 'public' and tablename = 'marketplace_handoffs' and cmd <> 'SELECT' loop
    execute format('drop policy %I on public.marketplace_handoffs', p.policyname);
  end loop;
  create policy mkt_handoff_insert on public.marketplace_handoffs for insert to authenticated
    with check (public.is_family_member(family_id) and public.is_marketplace_order_party(order_id));
  create policy mkt_handoff_update on public.marketplace_handoffs for update to authenticated
    using (public.is_family_member(family_id) and public.is_marketplace_order_party(order_id))
    with check (public.is_family_member(family_id) and public.is_marketplace_order_party(order_id));
  create policy mkt_handoff_delete on public.marketplace_handoffs for delete to authenticated
    using (public.is_family_member(family_id) and public.is_marketplace_order_party(order_id));
end
$$;
