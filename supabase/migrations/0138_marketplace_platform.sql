-- FamilyOS :: 0138 Marketplace Platform — AI-first community marketplace data model
-- ----------------------------------------------------------------------------
-- Extends the shipped family board (0120: marketplace_listings, marketplace_offers)
-- into the full commerce data model from the owner spec: profiles, verification,
-- taxonomy, rich listings (media/video/attributes/availability/pricing/location),
-- wanted requests + matching, offers/orders, rentals + borrow/lend agreements +
-- returns/deposits, payments/refunds/disputes, messaging, two-sided reviews +
-- ratings + trust scores, Pinterest collections, creator storefronts, saved items
-- + searches, AI generations/matches, reports + moderation, notifications, and
-- activity/audit/usage logs.
--
-- RLS model (three layers, applied by loops at the bottom):
--   • REFERENCE  (global taxonomy) — public SELECT, writes via service role only.
--   • DISCOVERY  (listings & their public children, stores, collections, reviews,
--                 profiles, ratings, trust) — public SELECT (cross-family
--                 discovery), family-scoped writes.
--   • PRIVATE    (requests, offers, orders, rentals, agreements, payments,
--                 messaging, moderation, logs, settings, …) — family-scoped for
--                 every operation.
-- NOTE (documented follow-up): cross-family transactions (a buyer in family A
--   purchasing from a seller in family B) currently keep PRIVATE rows visible to
--   the owning family only — a safe default that never leaks. A later slice adds a
--   participant model so both sides of a cross-family order/thread can see it.
--
-- Additive + idempotent. Every table is family-scoped (family_id NOT NULL),
-- has FKs with sensible cascades, indexes, updated_at triggers, and RLS.

-- ============================================================================
-- 0) Extend the existing 0120 tables (additive columns; keep back-compat)
-- ============================================================================
alter table public.marketplace_listings
  add column if not exists owner_user_id  uuid references auth.users(id) on delete set null,
  add column if not exists visibility      text not null default 'public'
    check (visibility in ('public','family','unlisted','private')),
  add column if not exists modes           text[] not null default '{}',   -- buy/rent/borrow/lend/donate/swap/auction/wanted
  add column if not exists subcategory     text,
  add column if not exists brand           text,
  add column if not exists color           text,
  add column if not exists size            text,
  add column if not exists deposit_cents   bigint check (deposit_cents is null or deposit_cents >= 0),
  add column if not exists late_fee_cents  bigint check (late_fee_cents is null or late_fee_cents >= 0),
  add column if not exists allow_offers    boolean not null default true,
  add column if not exists is_auction      boolean not null default false,
  add column if not exists currency        text not null default 'USD',
  add column if not exists latitude        double precision,
  add column if not exists longitude       double precision,
  add column if not exists view_count      integer not null default 0,
  add column if not exists tags            text[] not null default '{}',
  add column if not exists updated_by      uuid references auth.users(id) on delete set null,
  add column if not exists deleted_at      timestamptz,
  add column if not exists metadata        jsonb not null default '{}';
create index if not exists idx_marketplace_listings_visibility
  on public.marketplace_listings(visibility, status, created_at desc);

alter table public.marketplace_offers
  add column if not exists buyer_user_id   uuid references auth.users(id) on delete set null,
  add column if not exists deleted_at      timestamptz,
  add column if not exists metadata        jsonb not null default '{}';

-- ============================================================================
-- 1) Identity, verification, taxonomy
-- ============================================================================
create table if not exists public.marketplace_profiles (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete set null,
  member_id    uuid references public.family_members(id) on delete set null,
  display_name text not null,
  bio          text,
  avatar_url   text,
  banner_url   text,
  location     text,
  is_creator   boolean not null default false,
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  metadata     jsonb not null default '{}',
  unique (family_id, member_id)
);
create index if not exists idx_marketplace_profiles_family on public.marketplace_profiles(family_id);

create table if not exists public.marketplace_verifications (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete set null,
  member_id    uuid references public.family_members(id) on delete set null,
  kind         text not null check (kind in ('email','phone','payment_method','identity','address','community')),
  status       text not null default 'pending' check (status in ('pending','verified','failed','revoked')),
  verified_at  timestamptz,
  provider     text,
  reference    text,
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  metadata     jsonb not null default '{}',
  unique (family_id, member_id, kind)
);
create index if not exists idx_marketplace_verifications_family on public.marketplace_verifications(family_id, kind, status);

create table if not exists public.marketplace_categories (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  icon        text,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  metadata    jsonb not null default '{}'
);

create table if not exists public.marketplace_subcategories (
  id          uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.marketplace_categories(id) on delete cascade,
  slug        text not null,
  name        text not null,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  metadata    jsonb not null default '{}',
  unique (category_id, slug)
);

-- ============================================================================
-- 2) Creator storefronts + Pinterest collections
-- ============================================================================
create table if not exists public.marketplace_creator_stores (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  owner_user_id uuid references auth.users(id) on delete set null,
  member_id    uuid references public.family_members(id) on delete set null,
  slug         text not null unique,
  name         text not null,
  tagline      text,
  bio          text,
  avatar_url   text,
  banner_url   text,
  policies     text,
  is_active    boolean not null default true,
  follower_count integer not null default 0,
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  metadata     jsonb not null default '{}'
);
create index if not exists idx_marketplace_stores_family on public.marketplace_creator_stores(family_id);

create table if not exists public.marketplace_creator_products (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  store_id     uuid not null references public.marketplace_creator_stores(id) on delete cascade,
  listing_id   uuid references public.marketplace_listings(id) on delete set null,
  title        text not null,
  is_featured  boolean not null default false,
  sort_order   integer not null default 0,
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  metadata     jsonb not null default '{}'
);
create index if not exists idx_marketplace_products_store on public.marketplace_creator_products(store_id, sort_order);

create table if not exists public.marketplace_collections (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  owner_user_id uuid references auth.users(id) on delete set null,
  member_id    uuid references public.family_members(id) on delete set null,
  title        text not null,
  description  text,
  kind         text not null default 'board'
                 check (kind in ('board','mood','product','closet','event','rental','gift_guide','seasonal','favorites')),
  cover_url    text,
  is_public    boolean not null default true,
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  metadata     jsonb not null default '{}'
);
create index if not exists idx_marketplace_collections_family on public.marketplace_collections(family_id, kind);

create table if not exists public.marketplace_collection_items (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  collection_id uuid not null references public.marketplace_collections(id) on delete cascade,
  listing_id    uuid references public.marketplace_listings(id) on delete cascade,
  note          text,
  sort_order    integer not null default 0,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  metadata      jsonb not null default '{}',
  unique (collection_id, listing_id)
);
create index if not exists idx_marketplace_collection_items_col on public.marketplace_collection_items(collection_id, sort_order);

-- ============================================================================
-- 3) Listing detail children (media, video, attributes, availability, pricing, location)
-- ============================================================================
create table if not exists public.marketplace_listing_media (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  listing_id  uuid not null references public.marketplace_listings(id) on delete cascade,
  url         text not null,
  alt_text    text,
  is_cover    boolean not null default false,
  sort_order  integer not null default 0,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  metadata    jsonb not null default '{}'
);
create index if not exists idx_marketplace_media_listing on public.marketplace_listing_media(listing_id, sort_order);

create table if not exists public.marketplace_listing_videos (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  listing_id  uuid not null references public.marketplace_listings(id) on delete cascade,
  url         text not null,
  thumbnail_url text,
  duration_sec integer check (duration_sec is null or duration_sec >= 0),
  sort_order  integer not null default 0,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  metadata    jsonb not null default '{}'
);
create index if not exists idx_marketplace_videos_listing on public.marketplace_listing_videos(listing_id, sort_order);

create table if not exists public.marketplace_listing_attributes (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  listing_id  uuid not null references public.marketplace_listings(id) on delete cascade,
  key         text not null,
  value       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  metadata    jsonb not null default '{}',
  unique (listing_id, key)
);
create index if not exists idx_marketplace_attributes_listing on public.marketplace_listing_attributes(listing_id);

create table if not exists public.marketplace_listing_availability (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  listing_id  uuid not null references public.marketplace_listings(id) on delete cascade,
  starts_on   date,
  ends_on     date,
  is_blocked  boolean not null default false,   -- blocked = unavailable window
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  metadata    jsonb not null default '{}'
);
create index if not exists idx_marketplace_availability_listing on public.marketplace_listing_availability(listing_id, starts_on);

create table if not exists public.marketplace_listing_pricing (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  listing_id    uuid not null references public.marketplace_listings(id) on delete cascade,
  mode          text not null check (mode in ('buy','rent','borrow','deposit','swap')),
  period        text check (period in ('hour','day','week','month')),
  amount_cents  bigint not null default 0 check (amount_cents >= 0),
  currency      text not null default 'USD',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  metadata      jsonb not null default '{}',
  unique (listing_id, mode, period)
);
create index if not exists idx_marketplace_pricing_listing on public.marketplace_listing_pricing(listing_id);

create table if not exists public.marketplace_listing_locations (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  listing_id  uuid not null references public.marketplace_listings(id) on delete cascade,
  label       text,
  city        text,
  region      text,
  postal_code text,
  latitude    double precision,
  longitude   double precision,
  radius_miles numeric(8,1) check (radius_miles is null or radius_miles >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  metadata    jsonb not null default '{}'
);
create index if not exists idx_marketplace_locations_listing on public.marketplace_listing_locations(listing_id);

-- ============================================================================
-- 4) Wanted requests + AI matching
-- ============================================================================
create table if not exists public.marketplace_requests (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  owner_user_id uuid references auth.users(id) on delete set null,
  member_id    uuid references public.family_members(id) on delete set null,
  title        text not null,
  description  text,
  item_type    text,
  preferred_mode text check (preferred_mode in ('buy','rent','borrow','any')),
  size         text,
  color        text,
  brand        text,
  condition    text,
  needed_on    date,
  return_by    date,
  location     text,
  radius_miles numeric(8,1) check (radius_miles is null or radius_miles >= 0),
  budget_cents bigint check (budget_cents is null or budget_cents >= 0),
  status       text not null default 'open' check (status in ('open','matched','fulfilled','expired','withdrawn')),
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  metadata     jsonb not null default '{}'
);
create index if not exists idx_marketplace_requests_family on public.marketplace_requests(family_id, status, created_at desc);

create table if not exists public.marketplace_request_matches (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  request_id  uuid not null references public.marketplace_requests(id) on delete cascade,
  listing_id  uuid references public.marketplace_listings(id) on delete cascade,
  score       numeric(5,2),                         -- 0..100 match confidence
  reason      text,
  status      text not null default 'suggested' check (status in ('suggested','viewed','accepted','dismissed')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  metadata    jsonb not null default '{}',
  unique (request_id, listing_id)
);
create index if not exists idx_marketplace_matches_request on public.marketplace_request_matches(request_id, score desc);

-- ============================================================================
-- 5) Orders, rentals, agreements, returns, deposits
-- ============================================================================
create table if not exists public.marketplace_orders (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  listing_id   uuid references public.marketplace_listings(id) on delete set null,
  offer_id     uuid references public.marketplace_offers(id) on delete set null,
  seller_user_id uuid references auth.users(id) on delete set null,
  buyer_user_id  uuid references auth.users(id) on delete set null,
  seller_member_id uuid references public.family_members(id) on delete set null,
  buyer_member_id  uuid references public.family_members(id) on delete set null,
  mode         text not null default 'buy' check (mode in ('buy','rent','borrow','swap','donate')),
  fulfillment  text check (fulfillment in ('pickup','shipping','digital')),
  subtotal_cents bigint not null default 0 check (subtotal_cents >= 0),
  fee_cents    bigint not null default 0 check (fee_cents >= 0),
  deposit_cents bigint not null default 0 check (deposit_cents >= 0),
  tax_cents    bigint not null default 0 check (tax_cents >= 0),
  total_cents  bigint not null default 0 check (total_cents >= 0),
  currency     text not null default 'USD',
  status       text not null default 'pending'
                 check (status in ('pending','available','sold','canceled','refunded','disputed','completed')),
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  metadata     jsonb not null default '{}'
);
create index if not exists idx_marketplace_orders_family on public.marketplace_orders(family_id, status, created_at desc);
create index if not exists idx_marketplace_orders_listing on public.marketplace_orders(listing_id);

create table if not exists public.marketplace_rentals (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  order_id     uuid references public.marketplace_orders(id) on delete cascade,
  listing_id   uuid references public.marketplace_listings(id) on delete set null,
  owner_user_id uuid references auth.users(id) on delete set null,
  renter_user_id uuid references auth.users(id) on delete set null,
  starts_at    timestamptz,
  ends_at      timestamptz,
  picked_up_at timestamptz,
  returned_at  timestamptz,
  rate_cents   bigint not null default 0 check (rate_cents >= 0),
  deposit_cents bigint not null default 0 check (deposit_cents >= 0),
  status       text not null default 'requested'
                 check (status in ('requested','approved','declined','active','picked_up','returned','late','damaged','completed','disputed')),
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  metadata     jsonb not null default '{}'
);
create index if not exists idx_marketplace_rentals_family on public.marketplace_rentals(family_id, status);

create table if not exists public.marketplace_borrowing_agreements (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  order_id     uuid references public.marketplace_orders(id) on delete cascade,
  listing_id   uuid references public.marketplace_listings(id) on delete set null,
  lender_user_id   uuid references auth.users(id) on delete set null,
  borrower_user_id uuid references auth.users(id) on delete set null,
  due_back_on  date,
  terms        text,
  deposit_cents bigint not null default 0 check (deposit_cents >= 0),
  status       text not null default 'requested'
                 check (status in ('requested','approved','declined','active','returned','late','damaged','completed','disputed')),
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  metadata     jsonb not null default '{}'
);
create index if not exists idx_marketplace_borrowing_family on public.marketplace_borrowing_agreements(family_id, status);

create table if not exists public.marketplace_lending_agreements (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  order_id     uuid references public.marketplace_orders(id) on delete cascade,
  listing_id   uuid references public.marketplace_listings(id) on delete set null,
  lender_user_id   uuid references auth.users(id) on delete set null,
  borrower_user_id uuid references auth.users(id) on delete set null,
  due_back_on  date,
  terms        text,
  status       text not null default 'active'
                 check (status in ('active','returned','late','damaged','completed','disputed')),
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  metadata     jsonb not null default '{}'
);
create index if not exists idx_marketplace_lending_family on public.marketplace_lending_agreements(family_id, status);

create table if not exists public.marketplace_returns (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  order_id     uuid references public.marketplace_orders(id) on delete cascade,
  rental_id    uuid references public.marketplace_rentals(id) on delete set null,
  condition    text check (condition in ('as_sent','minor_wear','damaged','lost')),
  returned_at  timestamptz,
  checklist    jsonb not null default '[]',
  damage_note  text,
  status       text not null default 'pending' check (status in ('pending','confirmed','disputed')),
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  metadata     jsonb not null default '{}'
);
create index if not exists idx_marketplace_returns_order on public.marketplace_returns(order_id);

create table if not exists public.marketplace_deposits (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  order_id     uuid references public.marketplace_orders(id) on delete cascade,
  rental_id    uuid references public.marketplace_rentals(id) on delete set null,
  amount_cents bigint not null default 0 check (amount_cents >= 0),
  held_cents   bigint not null default 0 check (held_cents >= 0),
  released_cents bigint not null default 0 check (released_cents >= 0),
  currency     text not null default 'USD',
  status       text not null default 'held' check (status in ('held','partially_released','released','forfeited')),
  stripe_payment_intent_id text,
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  metadata     jsonb not null default '{}'
);
create index if not exists idx_marketplace_deposits_order on public.marketplace_deposits(order_id);

-- ============================================================================
-- 6) Payments, refunds, disputes
-- ============================================================================
create table if not exists public.marketplace_payments (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  order_id     uuid references public.marketplace_orders(id) on delete cascade,
  buyer_user_id  uuid references auth.users(id) on delete set null,
  seller_user_id uuid references auth.users(id) on delete set null,
  amount_cents bigint not null default 0 check (amount_cents >= 0),
  fee_cents    bigint not null default 0 check (fee_cents >= 0),
  currency     text not null default 'USD',
  status       text not null default 'pending'
                 check (status in ('pending','processing','succeeded','failed','canceled','refunded')),
  stripe_payment_intent_id text,
  stripe_checkout_session_id text,
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  metadata     jsonb not null default '{}'
);
create index if not exists idx_marketplace_payments_order on public.marketplace_payments(order_id);

create table if not exists public.marketplace_refunds (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  order_id     uuid references public.marketplace_orders(id) on delete cascade,
  payment_id   uuid references public.marketplace_payments(id) on delete set null,
  amount_cents bigint not null default 0 check (amount_cents >= 0),
  reason       text,
  kind         text not null default 'full' check (kind in ('full','partial','deposit','cancellation','failed_delivery')),
  initiator    text check (initiator in ('buyer','seller','admin','system')),
  status       text not null default 'pending' check (status in ('pending','processing','succeeded','failed')),
  stripe_refund_id text,
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  metadata     jsonb not null default '{}'
);
create index if not exists idx_marketplace_refunds_order on public.marketplace_refunds(order_id);

create table if not exists public.marketplace_disputes (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  order_id     uuid references public.marketplace_orders(id) on delete cascade,
  opened_by_user_id uuid references auth.users(id) on delete set null,
  kind         text not null check (kind in ('not_received','damaged','not_as_described','rental_damage','late_return','fraud')),
  status       text not null default 'open' check (status in ('open','under_review','resolved','rejected','escalated')),
  description  text,
  evidence     jsonb not null default '[]',         -- images/videos/messages/timeline refs
  resolution   text,
  resolved_at  timestamptz,
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  metadata     jsonb not null default '{}'
);
create index if not exists idx_marketplace_disputes_family on public.marketplace_disputes(family_id, status);

-- ============================================================================
-- 7) Messaging
-- ============================================================================
create table if not exists public.marketplace_conversations (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  listing_id   uuid references public.marketplace_listings(id) on delete set null,
  order_id     uuid references public.marketplace_orders(id) on delete set null,
  buyer_user_id  uuid references auth.users(id) on delete set null,
  seller_user_id uuid references auth.users(id) on delete set null,
  subject      text,
  last_message_at timestamptz,
  status       text not null default 'open' check (status in ('open','archived','blocked')),
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  metadata     jsonb not null default '{}'
);
create index if not exists idx_marketplace_conversations_family on public.marketplace_conversations(family_id, last_message_at desc);

create table if not exists public.marketplace_messages (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  conversation_id uuid not null references public.marketplace_conversations(id) on delete cascade,
  sender_user_id uuid references auth.users(id) on delete set null,
  sender_member_id uuid references public.family_members(id) on delete set null,
  body         text,
  media_url    text,
  card_kind    text check (card_kind in ('offer','rental_request','borrow_request','pickup','system')),
  card_payload jsonb,
  read_at      timestamptz,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  metadata     jsonb not null default '{}'
);
create index if not exists idx_marketplace_messages_convo on public.marketplace_messages(conversation_id, created_at);

-- ============================================================================
-- 8) Reviews, ratings, trust
-- ============================================================================
create table if not exists public.marketplace_reviews (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  order_id     uuid references public.marketplace_orders(id) on delete set null,
  reviewer_user_id uuid references auth.users(id) on delete set null,
  reviewee_user_id uuid references auth.users(id) on delete set null,
  role         text check (role in ('buyer','seller','renter','owner','borrower','lender')),
  rating       integer check (rating between 1 and 5),
  body         text,
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  metadata     jsonb not null default '{}',
  unique (order_id, reviewer_user_id, role)
);
create index if not exists idx_marketplace_reviews_reviewee on public.marketplace_reviews(reviewee_user_id);

create table if not exists public.marketplace_ratings (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  review_id    uuid references public.marketplace_reviews(id) on delete cascade,
  dimension    text not null check (dimension in ('communication','reliability','item_accuracy','timeliness','condition_returned','overall')),
  score        integer not null check (score between 1 and 5),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  metadata     jsonb not null default '{}',
  unique (review_id, dimension)
);
create index if not exists idx_marketplace_ratings_review on public.marketplace_ratings(review_id);

create table if not exists public.marketplace_trust_scores (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete set null,
  member_id    uuid references public.family_members(id) on delete set null,
  score        integer not null default 0 check (score between 0 and 100),
  completed_transactions integer not null default 0,
  average_rating numeric(3,2),
  response_minutes integer,
  disputes     integer not null default 0,
  cancellations integer not null default 0,
  badges       text[] not null default '{}',
  computed_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  metadata     jsonb not null default '{}',
  unique (family_id, member_id)
);
create index if not exists idx_marketplace_trust_family on public.marketplace_trust_scores(family_id);

-- ============================================================================
-- 9) Saved items/searches, AI, reports/moderation, logs, notifications, settings
-- ============================================================================
create table if not exists public.marketplace_saved_items (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  member_id   uuid references public.family_members(id) on delete set null,
  listing_id  uuid not null references public.marketplace_listings(id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  metadata    jsonb not null default '{}',
  unique (member_id, listing_id)
);
create index if not exists idx_marketplace_saved_items_family on public.marketplace_saved_items(family_id, member_id);

create table if not exists public.marketplace_saved_searches (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  member_id   uuid references public.family_members(id) on delete set null,
  name        text,
  query       text,
  filters     jsonb not null default '{}',
  alerts_enabled boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  metadata    jsonb not null default '{}'
);
create index if not exists idx_marketplace_saved_searches_family on public.marketplace_saved_searches(family_id, member_id);

create table if not exists public.marketplace_search_events (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  member_id   uuid references public.family_members(id) on delete set null,
  query       text,
  filters     jsonb not null default '{}',
  result_count integer,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  metadata    jsonb not null default '{}'
);
create index if not exists idx_marketplace_search_events_family on public.marketplace_search_events(family_id, created_at desc);

create table if not exists public.marketplace_ai_generations (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  listing_id  uuid references public.marketplace_listings(id) on delete set null,
  member_id   uuid references public.family_members(id) on delete set null,
  kind        text not null check (kind in ('listing','pricing','caption','seo','buyer_search','seller_tips')),
  input       jsonb not null default '{}',
  output      jsonb not null default '{}',
  model       text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  metadata    jsonb not null default '{}'
);
create index if not exists idx_marketplace_ai_generations_family on public.marketplace_ai_generations(family_id, kind);

create table if not exists public.marketplace_ai_matches (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  request_id  uuid references public.marketplace_requests(id) on delete cascade,
  listing_id  uuid references public.marketplace_listings(id) on delete set null,
  score       numeric(5,2),
  reason      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  metadata    jsonb not null default '{}'
);
create index if not exists idx_marketplace_ai_matches_request on public.marketplace_ai_matches(request_id, score desc);

create table if not exists public.marketplace_reports (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  reporter_user_id uuid references auth.users(id) on delete set null,
  listing_id  uuid references public.marketplace_listings(id) on delete set null,
  reported_user_id uuid references auth.users(id) on delete set null,
  reason      text not null,
  detail      text,
  status      text not null default 'open' check (status in ('open','reviewing','actioned','dismissed')),
  created_by  uuid references auth.users(id) on delete set null,
  updated_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  metadata    jsonb not null default '{}'
);
create index if not exists idx_marketplace_reports_family on public.marketplace_reports(family_id, status);

create table if not exists public.marketplace_moderation_queue (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  listing_id  uuid references public.marketplace_listings(id) on delete set null,
  report_id   uuid references public.marketplace_reports(id) on delete set null,
  reason      text,
  status      text not null default 'pending' check (status in ('pending','approved','rejected','escalated')),
  reviewer_user_id uuid references auth.users(id) on delete set null,
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  metadata    jsonb not null default '{}'
);
create index if not exists idx_marketplace_moderation_family on public.marketplace_moderation_queue(family_id, status);

create table if not exists public.marketplace_activity_logs (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  listing_id  uuid references public.marketplace_listings(id) on delete set null,
  action      text not null,
  detail      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  metadata    jsonb not null default '{}'
);
create index if not exists idx_marketplace_activity_family on public.marketplace_activity_logs(family_id, created_at desc);

create table if not exists public.marketplace_audit_logs (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  table_name  text not null,
  record_id   uuid,
  action      text not null,
  changes     jsonb not null default '{}',
  actor_user_id uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  metadata    jsonb not null default '{}'
);
create index if not exists idx_marketplace_audit_family on public.marketplace_audit_logs(family_id, created_at desc);

create table if not exists public.marketplace_notifications (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  member_id   uuid references public.family_members(id) on delete set null,
  title       text not null,
  body        text,
  href        text,
  kind        text,
  read        boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  metadata    jsonb not null default '{}'
);
create index if not exists idx_marketplace_notifications_family on public.marketplace_notifications(family_id, member_id, read);

create table if not exists public.marketplace_usage_events (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  event       text not null,
  properties  jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  metadata    jsonb not null default '{}'
);
create index if not exists idx_marketplace_usage_family on public.marketplace_usage_events(family_id, created_at desc);

create table if not exists public.marketplace_settings (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  default_currency text not null default 'USD',
  default_fulfillment text check (default_fulfillment in ('pickup','shipping','digital')),
  commission_bps integer check (commission_bps is null or commission_bps >= 0),
  require_verification boolean not null default false,
  preferences jsonb not null default '{}',
  created_by  uuid references auth.users(id) on delete set null,
  updated_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  metadata    jsonb not null default '{}',
  unique (family_id)
);

-- ============================================================================
-- updated_at triggers — applied to every table above (all have updated_at)
-- ============================================================================
do $$
declare t text;
declare tbls text[] := array[
  'marketplace_profiles','marketplace_verifications','marketplace_categories','marketplace_subcategories',
  'marketplace_creator_stores','marketplace_creator_products','marketplace_collections','marketplace_collection_items',
  'marketplace_listing_media','marketplace_listing_videos','marketplace_listing_attributes',
  'marketplace_listing_availability','marketplace_listing_pricing','marketplace_listing_locations',
  'marketplace_requests','marketplace_request_matches','marketplace_orders','marketplace_rentals',
  'marketplace_borrowing_agreements','marketplace_lending_agreements','marketplace_returns','marketplace_deposits',
  'marketplace_payments','marketplace_refunds','marketplace_disputes','marketplace_conversations',
  'marketplace_messages','marketplace_reviews','marketplace_ratings','marketplace_trust_scores',
  'marketplace_saved_items','marketplace_saved_searches','marketplace_search_events','marketplace_ai_generations',
  'marketplace_ai_matches','marketplace_reports','marketplace_moderation_queue','marketplace_activity_logs',
  'marketplace_audit_logs','marketplace_notifications','marketplace_usage_events','marketplace_settings'
];
begin
  foreach t in array tbls loop
    execute format('drop trigger if exists set_%1$s_updated on public.%1$I', t);
    execute format('create trigger set_%1$s_updated before update on public.%1$I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ============================================================================
-- RLS — three layers
-- ============================================================================

-- REFERENCE: global taxonomy → public SELECT, writes via service role only.
do $$
declare t text;
begin
  foreach t in array array['marketplace_categories','marketplace_subcategories'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (true)', t, t);
  end loop;
end $$;

-- DISCOVERY (parent listing): a listing is visible when it is PUBLIC or belongs
-- to the viewer's family. Overrides 0120's family-only SELECT so cross-family
-- discovery works, while family/unlisted/private listings stay restricted. Writes
-- remain family-scoped (from 0120). (The existing family board UI filters by
-- family_id in its query, so broadening SELECT does not change its results.)
drop policy if exists marketplace_listings_select on public.marketplace_listings;
create policy marketplace_listings_select on public.marketplace_listings
  for select using (visibility = 'public' or public.is_family_member(family_id));

-- DISCOVERY (listing children): visibility FOLLOWS the parent listing, so media/
-- pricing/etc. for a private listing never leak. Writes are family-scoped.
do $$
declare t text;
begin
  foreach t in array array[
    'marketplace_listing_media','marketplace_listing_videos','marketplace_listing_attributes',
    'marketplace_listing_availability','marketplace_listing_pricing','marketplace_listing_locations'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format($p$create policy %1$s_select on public.%1$I for select using (
      exists (select 1 from public.marketplace_listings l
              where l.id = %1$I.listing_id
                and (l.visibility = 'public' or public.is_family_member(l.family_id))))$p$, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;

-- DISCOVERY (collections): visible when the board is public or family-owned;
-- items follow their parent collection. Writes family-scoped.
alter table public.marketplace_collections enable row level security;
drop policy if exists marketplace_collections_select on public.marketplace_collections;
create policy marketplace_collections_select on public.marketplace_collections
  for select using (is_public or public.is_family_member(family_id));
drop policy if exists marketplace_collections_insert on public.marketplace_collections;
create policy marketplace_collections_insert on public.marketplace_collections for insert with check (public.is_family_member(family_id));
drop policy if exists marketplace_collections_update on public.marketplace_collections;
create policy marketplace_collections_update on public.marketplace_collections for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));
drop policy if exists marketplace_collections_delete on public.marketplace_collections;
create policy marketplace_collections_delete on public.marketplace_collections for delete using (public.is_family_member(family_id));

alter table public.marketplace_collection_items enable row level security;
drop policy if exists marketplace_collection_items_select on public.marketplace_collection_items;
create policy marketplace_collection_items_select on public.marketplace_collection_items for select using (
  exists (select 1 from public.marketplace_collections c
          where c.id = marketplace_collection_items.collection_id
            and (c.is_public or public.is_family_member(c.family_id))));
drop policy if exists marketplace_collection_items_insert on public.marketplace_collection_items;
create policy marketplace_collection_items_insert on public.marketplace_collection_items for insert with check (public.is_family_member(family_id));
drop policy if exists marketplace_collection_items_update on public.marketplace_collection_items;
create policy marketplace_collection_items_update on public.marketplace_collection_items for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));
drop policy if exists marketplace_collection_items_delete on public.marketplace_collection_items;
create policy marketplace_collection_items_delete on public.marketplace_collection_items for delete using (public.is_family_member(family_id));

-- DISCOVERY (inherently public surfaces): seller profiles, storefronts, products,
-- and the reviews/ratings/trust shown on them are public read; writes family-scoped.
do $$
declare t text;
begin
  foreach t in array array[
    'marketplace_profiles','marketplace_creator_stores','marketplace_creator_products',
    'marketplace_reviews','marketplace_ratings','marketplace_trust_scores'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (true)', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;

-- PRIVATE: family-scoped for every operation.
do $$
declare t text;
begin
  foreach t in array array[
    'marketplace_verifications','marketplace_requests','marketplace_request_matches','marketplace_orders',
    'marketplace_rentals','marketplace_borrowing_agreements','marketplace_lending_agreements',
    'marketplace_returns','marketplace_deposits','marketplace_payments','marketplace_refunds',
    'marketplace_disputes','marketplace_conversations','marketplace_messages','marketplace_saved_items',
    'marketplace_saved_searches','marketplace_search_events','marketplace_ai_generations',
    'marketplace_ai_matches','marketplace_reports','marketplace_moderation_queue','marketplace_activity_logs',
    'marketplace_audit_logs','marketplace_notifications','marketplace_usage_events','marketplace_settings'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;

-- ============================================================================
-- Done! 43 marketplace tables (2 extended + 41 new) powering the Bubaly
-- AI-first community marketplace. Family-scoped, public discovery, RLS + audit.
-- ============================================================================
