-- ============================================================================
-- FamilyOS · SEED — Marketplace matches (500 records).
-- Fills marketplace_matches so the supply↔demand strip (0150) renders at volume:
-- pairs the family's open "wanted" listings with open supply listings (sell /
-- free / rent / borrow) posted by someone else, scored + reasoned. Requires the
-- marketplace itself to be seeded first (seed_marketplace_family.sql / the in-app
-- seed screen) so there are listings to pair. Idempotent: clears prior seed rows
-- (reason like '%[seed]%') for the family before inserting. Resolves family by
-- email. (Needs migrations 0120 + 0150 applied.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_wanted  uuid[];
  v_supply  uuid[];
  nw int; ns int;
  n int := 500;
  inserted int := 0;
begin
  if to_regclass('public.marketplace_matches') is null then
    raise notice 'marketplace_matches not present — apply migration 0150 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select array_agg(id) into v_wanted from public.marketplace_listings
    where family_id = v_family and kind = 'wanted' and status in ('available','pending');
  select array_agg(id) into v_supply from public.marketplace_listings
    where family_id = v_family and kind in ('sell','free','rent','borrow') and status in ('available','pending');

  nw := coalesce(array_length(v_wanted, 1), 0);
  ns := coalesce(array_length(v_supply, 1), 0);
  if nw = 0 or ns = 0 then
    raise notice 'No wanted/supply listings to pair (wanted=%, supply=%). Seed the marketplace first. Skipping.', nw, ns;
    return;
  end if;

  delete from public.marketplace_matches where family_id = v_family and reason like '%[seed]%';

  -- Generate up to 500 distinct (wanted, supply) pairs by walking the cross-grid.
  insert into public.marketplace_matches (family_id, wanted_id, supply_id, score, reason, status)
  select
    v_family,
    v_wanted[1 + (g.i % nw)],
    v_supply[1 + ((g.i / nw) % ns)],
    30 + (g.i % 70),                                   -- score spread 30..99
    'Someone wants what''s on the board. [seed]',
    (array['active','active','active','dismissed','actioned'])[1 + (g.i % 5)]
  from generate_series(0, n - 1) g(i)
  where v_wanted[1 + (g.i % nw)] <> v_supply[1 + ((g.i / nw) % ns)]
  on conflict (family_id, wanted_id, supply_id) do nothing;

  get diagnostics inserted = row_count;
  raise notice 'Marketplace matches seeded % rows (wanted=%, supply=%) for family %', inserted, nw, ns, v_family;
end $$;

-- Verify:
--   select count(*) from marketplace_matches where reason like '%[seed]%';       -- up to 500
--   select status, count(*) from marketplace_matches group by status;
