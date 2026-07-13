-- ============================================================================
-- 0190 · Marketplace Pickup & Handoff Coordinator.
--
-- Closes the transaction loop. Today an accepted offer / won auction / claimed
-- listing creates a marketplace_orders row and then… nothing coordinates the
-- actual hand-off — eBay leans on shipping labels, Craigslist on "text me".
-- A family-local marketplace can do better: one side proposes a time + a SAFE
-- public meetup spot, the other confirms, it lands on the family calendar, and
-- the exchange is completed in person with a short hand-off code (so "completed"
-- means the item actually changed hands, not just a button click).
--
-- One handoff per order (unique). Family-scoped RLS via is_family_member — both
-- the buyer and seller members live in the order's family for the same-family
-- exchanges the Orders surface shows. Additive + idempotent. Requires 0151.
-- ============================================================================

create table if not exists public.marketplace_handoffs (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null unique references public.marketplace_orders(id) on delete cascade,
  family_id         uuid not null references public.families(id) on delete cascade,
  listing_id        uuid references public.marketplace_listings(id) on delete cascade,
  proposed_by       uuid references public.family_members(id) on delete set null,
  proposer_role     text not null default 'seller' check (proposer_role in ('buyer','seller')),
  meet_at           timestamptz,
  location_label    text,
  location_kind     text not null default 'public_spot'
                      check (location_kind in ('public_spot','seller_place','buyer_place','other')),
  status            text not null default 'proposed'
                      check (status in ('proposed','confirmed','completed','cancelled')),
  confirm_code      text,
  confirmed_at      timestamptz,
  completed_at      timestamptz,
  calendar_event_id uuid references public.calendar_events(id) on delete set null,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_mkt_handoffs_family on public.marketplace_handoffs(family_id, status);
create index if not exists idx_mkt_handoffs_order  on public.marketplace_handoffs(order_id);
create index if not exists idx_mkt_handoffs_meet   on public.marketplace_handoffs(meet_at) where status in ('proposed','confirmed');

alter table public.marketplace_handoffs enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='marketplace_handoffs' and policyname='mkt_handoff_select') then
    create policy mkt_handoff_select on public.marketplace_handoffs for select using (public.is_family_member(family_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='marketplace_handoffs' and policyname='mkt_handoff_insert') then
    create policy mkt_handoff_insert on public.marketplace_handoffs for insert with check (public.is_family_member(family_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='marketplace_handoffs' and policyname='mkt_handoff_update') then
    create policy mkt_handoff_update on public.marketplace_handoffs for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='marketplace_handoffs' and policyname='mkt_handoff_delete') then
    create policy mkt_handoff_delete on public.marketplace_handoffs for delete using (public.is_family_member(family_id));
  end if;
end $$;

drop trigger if exists trg_mkt_handoffs_updated_at on public.marketplace_handoffs;
create trigger trg_mkt_handoffs_updated_at before update on public.marketplace_handoffs
  for each row execute function public.set_updated_at();
