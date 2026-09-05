-- Bubaly :: 0151 Marketplace V2 — the AI-first marketplace
-- ----------------------------------------------------------------------------
-- Upgrades the family marketplace (0120/0150) into the full AI-first design:
-- "Buy, sell, rent, borrow, lend & more — all in one trusted community."
--
--   • listings gain two kinds: swap · donate (check-constraint widened)
--   • marketplace_stores            — member storefronts ("Creators" / My Store)
--   • marketplace_follows           — follow a store
--   • marketplace_saves             — save/♥ a listing
--   • marketplace_collections(+items) — curated groups ("Popular Collections")
--   • marketplace_orders            — the transaction record (rent/buy/borrow/…)
--   • marketplace_reviews           — two-sided reviews (buyer ↔ seller)
--
-- Trust scores, AI picks, and the activity feed are COMPUTED from these tables
-- by pure engines (lib/marketplace/trust.ts, lib/marketplace/discover.ts) — no
-- denormalized score columns to drift.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

-- ── listings: widen kind to include swap + donate ───────────────────────────
alter table public.marketplace_listings
  drop constraint if exists marketplace_listings_kind_check;
alter table public.marketplace_listings
  add constraint marketplace_listings_kind_check
  check (kind in ('sell','rent','borrow','free','wanted','swap','donate'));

-- ── marketplace_stores ──────────────────────────────────────────────────────
create table if not exists public.marketplace_stores (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid not null references public.family_members(id) on delete cascade,
  name        text not null,
  tagline     text,
  description text,
  emoji       text,
  is_active   boolean not null default true,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (family_id, member_id)
);
create index if not exists idx_marketplace_stores_family on public.marketplace_stores(family_id, is_active);

-- ── marketplace_follows ─────────────────────────────────────────────────────
create table if not exists public.marketplace_follows (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  store_id    uuid not null references public.marketplace_stores(id) on delete cascade,
  member_id   uuid not null references public.family_members(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (store_id, member_id)
);
create index if not exists idx_marketplace_follows_family on public.marketplace_follows(family_id);

-- ── marketplace_saves (♥) ───────────────────────────────────────────────────
create table if not exists public.marketplace_saves (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  listing_id  uuid not null references public.marketplace_listings(id) on delete cascade,
  member_id   uuid not null references public.family_members(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (listing_id, member_id)
);
create index if not exists idx_marketplace_saves_family on public.marketplace_saves(family_id, member_id);

-- ── marketplace_collections + items ─────────────────────────────────────────
create table if not exists public.marketplace_collections (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  name        text not null,
  description text,
  emoji       text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_marketplace_collections_family on public.marketplace_collections(family_id);

create table if not exists public.marketplace_collection_items (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  collection_id uuid not null references public.marketplace_collections(id) on delete cascade,
  listing_id    uuid not null references public.marketplace_listings(id) on delete cascade,
  created_at    timestamptz not null default now(),
  unique (collection_id, listing_id)
);
create index if not exists idx_marketplace_coll_items_family on public.marketplace_collection_items(family_id);

-- ── marketplace_orders — the transaction record ─────────────────────────────
create table if not exists public.marketplace_orders (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  listing_id    uuid not null references public.marketplace_listings(id) on delete cascade,
  buyer_member  uuid references public.family_members(id) on delete set null,
  seller_member uuid references public.family_members(id) on delete set null,
  kind          text not null default 'buy'
                  check (kind in ('buy','rent','borrow','swap','donate','free')),
  status        text not null default 'requested'
                  check (status in ('requested','confirmed','active','returned','completed','cancelled')),
  amount_cents  bigint not null default 0,
  starts_on     date,
  ends_on       date,
  notes         text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_marketplace_orders_family on public.marketplace_orders(family_id, status, created_at desc);
create index if not exists idx_marketplace_orders_buyer on public.marketplace_orders(family_id, buyer_member);

-- ── marketplace_reviews — two-sided ─────────────────────────────────────────
create table if not exists public.marketplace_reviews (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null references public.families(id) on delete cascade,
  order_id        uuid references public.marketplace_orders(id) on delete set null,
  listing_id      uuid references public.marketplace_listings(id) on delete set null,
  reviewer_member uuid references public.family_members(id) on delete set null,
  reviewee_member uuid references public.family_members(id) on delete set null,
  role            text not null default 'buyer' check (role in ('buyer','seller')),
  rating          integer not null default 5 check (rating between 1 and 5),
  comment         text,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_marketplace_reviews_family on public.marketplace_reviews(family_id, created_at desc);
create index if not exists idx_marketplace_reviews_reviewee on public.marketplace_reviews(family_id, reviewee_member);
-- one review per side of an order
create unique index if not exists uq_marketplace_reviews_order_side
  on public.marketplace_reviews(order_id, reviewer_member) where order_id is not null;

-- ── updated_at triggers ─────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['marketplace_stores','marketplace_collections','marketplace_orders','marketplace_reviews'] loop
    execute format('drop trigger if exists set_%1$s_updated on public.%1$I', t);
    execute format('create trigger set_%1$s_updated before update on public.%1$I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'marketplace_stores','marketplace_follows','marketplace_saves',
    'marketplace_collections','marketplace_collection_items',
    'marketplace_orders','marketplace_reviews'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t);
  end loop;
end $$;
