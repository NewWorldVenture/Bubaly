-- ============================================================================
-- 0191 · Marketplace price history + drop watch.
--
-- Today "Saved" (♥) is static: a buyer who hearts an item never hears that the
-- seller cut the price — eBay's "price reduced on an item you're watching" is a
-- top conversion driver; Craigslist has nothing. This adds:
--   • marketplace_price_history — an append-only log of every price change on a
--     fixed-price listing (old → new), so the item page can show a real history
--     and "lowest in N days";
--   • a trigger that, on any price change, writes the history row AND — when the
--     price DROPS on a live listing — notifies every family watching it (♥).
--
-- The trigger is the robust hook: it fires no matter which path edits the price
-- (quick-post, module edit, seed, admin), so a drop can never slip past a
-- watcher. Additive + idempotent. Requires 0120 + 0151.
-- ============================================================================

create table if not exists public.marketplace_price_history (
  id          uuid primary key default gen_random_uuid(),
  listing_id  uuid not null references public.marketplace_listings(id) on delete cascade,
  family_id   uuid not null references public.families(id) on delete cascade,
  old_cents   bigint not null,
  new_cents   bigint not null,
  changed_at  timestamptz not null default now()
);
create index if not exists idx_mkt_price_hist_listing on public.marketplace_price_history(listing_id, changed_at desc);

alter table public.marketplace_price_history enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='marketplace_price_history' and policyname='mkt_price_hist_select') then
    create policy mkt_price_hist_select on public.marketplace_price_history for select using (public.is_family_member(family_id));
  end if;
end $$;

-- ── Log every price change; notify watchers on a drop ────────────────────────
create or replace function public.marketplace_log_price_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_old text := '$' || to_char(old.price_cents / 100.0, 'FM999990.00');
  v_new text := '$' || to_char(new.price_cents / 100.0, 'FM999990.00');
begin
  -- Only meaningful for fixed-price sale listings (auctions carry price_cents=0).
  if coalesce(new.sale_format, 'fixed') = 'auction' then return new; end if;

  insert into public.marketplace_price_history (listing_id, family_id, old_cents, new_cents)
  values (new.id, new.family_id, old.price_cents, new.price_cents);

  -- A genuine drop on a still-available listing → alert every watcher (♥).
  if new.price_cents < old.price_cents and new.price_cents > 0
     and new.status in ('available', 'pending') then
    insert into public.notifications (family_id, user_id, type, title, body, related_type, related_id)
    select distinct s.family_id, null::uuid, 'system'::public.notification_type,
      'Price dropped: "' || left(new.title, 60) || '"',
      v_old || ' → ' || v_new || ' — you saved this. Grab it before it''s gone.',
      'marketplace_listings', new.id
    from public.marketplace_saves s
    where s.listing_id = new.id;
  end if;

  return new;
end $$;

drop trigger if exists trg_marketplace_log_price_change on public.marketplace_listings;
create trigger trg_marketplace_log_price_change
  after update of price_cents on public.marketplace_listings
  for each row when (old.price_cents is distinct from new.price_cents)
  execute function public.marketplace_log_price_change();
