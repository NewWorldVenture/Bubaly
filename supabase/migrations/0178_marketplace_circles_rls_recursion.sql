-- FamilyOS :: 0178 - Fix recursive RLS in marketplace circles.
--
-- Migration 0176 used direct reads from marketplace_circle_members inside that
-- table's own SELECT policy (and inside policies on related tables). PostgreSQL
-- therefore detected infinite policy recursion and returned 42P17. These
-- SECURITY DEFINER helpers read the membership table with RLS bypassed, while
-- still requiring the current user to be an active member of the referenced
-- family. The policy boundary remains family/circle scoped.

begin;

create or replace function public.is_marketplace_circle_member(p_circle_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.marketplace_circle_members m
    where m.circle_id = p_circle_id
      and public.is_family_member(m.family_id)
  );
$$;

create or replace function public.is_marketplace_circle_family_member(
  p_circle_id uuid,
  p_family_id uuid
)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.is_family_member(p_family_id)
    and exists (
      select 1
      from public.marketplace_circle_members m
      where m.circle_id = p_circle_id
        and m.family_id = p_family_id
    );
$$;

grant execute on function public.is_marketplace_circle_member(uuid) to authenticated;
grant execute on function public.is_marketplace_circle_family_member(uuid, uuid) to authenticated;

drop policy if exists mkt_circles_select on public.marketplace_circles;
create policy mkt_circles_select on public.marketplace_circles
  for select using (public.is_marketplace_circle_member(id));

drop policy if exists mkt_circle_members_select on public.marketplace_circle_members;
create policy mkt_circle_members_select on public.marketplace_circle_members
  for select using (public.is_marketplace_circle_member(circle_id));

drop policy if exists mkt_listing_shares_select on public.marketplace_listing_shares;
create policy mkt_listing_shares_select on public.marketplace_listing_shares
  for select using (public.is_marketplace_circle_member(circle_id));

drop policy if exists mkt_listing_shares_insert on public.marketplace_listing_shares;
create policy mkt_listing_shares_insert on public.marketplace_listing_shares
  for insert with check (
    public.is_marketplace_circle_family_member(circle_id, family_id)
    and exists (
      select 1
      from public.marketplace_listings l
      where l.id = listing_id
        and l.family_id = marketplace_listing_shares.family_id
    )
  );

drop policy if exists mkt_listing_shares_delete on public.marketplace_listing_shares;
create policy mkt_listing_shares_delete on public.marketplace_listing_shares
  for delete using (
    public.is_marketplace_circle_family_member(circle_id, family_id)
    and exists (
      select 1
      from public.marketplace_listings l
      where l.id = listing_id
        and l.family_id = marketplace_listing_shares.family_id
    )
  );

drop policy if exists marketplace_listings_circle_read on public.marketplace_listings;
create policy marketplace_listings_circle_read on public.marketplace_listings
  for select using (exists (
    select 1
    from public.marketplace_listing_shares s
    where s.listing_id = marketplace_listings.id
      and public.is_marketplace_circle_member(s.circle_id)
  ));

commit;
