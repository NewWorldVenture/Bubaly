-- FamilyOS :: 0120 Marketplace ("Buy, sell, rent, borrow within the platform")
-- ----------------------------------------------------------------------------
-- A family-scoped marketplace / lending board: post items to sell, rent out,
-- lend ("borrow"), give away free, or request ("wanted"). Other members express
-- interest or claim an item; the poster accepts an offer to hand it off.
--
--   • marketplace_listings — the items on the board
--   • marketplace_offers    — interest / claim requests against a listing
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

-- ── marketplace_listings ────────────────────────────────────────────────────
create table if not exists public.marketplace_listings (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  member_id    uuid references public.family_members(id) on delete set null,
  title        text not null,
  description  text,
  kind         text not null default 'sell'
                 check (kind in ('sell','rent','borrow','free','wanted')),
  category     text not null default 'other'
                 check (category in ('toys','clothing','books','electronics','furniture',
                                     'sports','tools','baby','games','other')),
  condition    text check (condition in ('new','like_new','good','fair','worn')),
  price_cents  bigint not null default 0,           -- sale price, or rate for rent
  rent_period  text check (rent_period in ('hour','day','week','month')),
  photo_url    text,
  location     text,
  status       text not null default 'available'
                 check (status in ('available','pending','claimed','completed','withdrawn')),
  claimed_by   uuid references public.family_members(id) on delete set null,
  claimed_at   timestamptz,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_marketplace_listings_family
  on public.marketplace_listings(family_id, status, created_at desc);
create index if not exists idx_marketplace_listings_member
  on public.marketplace_listings(family_id, member_id);

-- ── marketplace_offers ──────────────────────────────────────────────────────
create table if not exists public.marketplace_offers (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  listing_id  uuid not null references public.marketplace_listings(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,
  kind        text not null default 'interest'
                check (kind in ('interest','claim','offer')),
  amount_cents bigint,                              -- optional counter-offer for 'offer'
  message     text,
  status      text not null default 'open'
                check (status in ('open','accepted','declined','withdrawn')),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_marketplace_offers_listing
  on public.marketplace_offers(listing_id, status);
create index if not exists idx_marketplace_offers_family
  on public.marketplace_offers(family_id, created_at desc);

-- ── updated_at triggers ─────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['marketplace_listings','marketplace_offers'] loop
    execute format('drop trigger if exists set_%1$s_updated on public.%1$I', t);
    execute format('create trigger set_%1$s_updated before update on public.%1$I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['marketplace_listings','marketplace_offers'] loop
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
