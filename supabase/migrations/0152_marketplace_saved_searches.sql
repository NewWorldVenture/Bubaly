-- FamilyOS :: 0152 Marketplace saved searches / alerts
-- ----------------------------------------------------------------------------
-- "Alert me when someone lists X." A member saves a standing search (keyword +
-- optional kind / category / price ceiling); the Alerts page matches it against
-- the live board and badges what's NEW since they last looked (last_seen_at).
-- Pull-based (no trigger/notification hook) — the match logic is the pure
-- lib/marketplace/saved-search.ts. Family-scoped RLS. Additive + idempotent.

create table if not exists public.marketplace_saved_searches (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null references public.families(id) on delete cascade,
  member_id       uuid not null references public.family_members(id) on delete cascade,
  label           text,                       -- optional friendly name
  query           text,                       -- keyword over title/description
  kind            text,                       -- optional: sell/rent/borrow/free/wanted/swap/donate (null = any)
  category        text,                       -- optional category (null = any)
  max_price_cents bigint,                      -- optional ceiling (priced kinds only)
  is_active       boolean not null default true,
  last_seen_at    timestamptz not null default now(),  -- "new since" cursor
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_marketplace_saved_searches_member
  on public.marketplace_saved_searches(family_id, member_id, created_at desc);

-- ── updated_at trigger ──────────────────────────────────────────────────────
drop trigger if exists set_marketplace_saved_searches_updated on public.marketplace_saved_searches;
create trigger set_marketplace_saved_searches_updated before update on public.marketplace_saved_searches
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
begin
  execute 'alter table public.marketplace_saved_searches enable row level security';
  execute 'drop policy if exists marketplace_saved_searches_select on public.marketplace_saved_searches';
  execute 'create policy marketplace_saved_searches_select on public.marketplace_saved_searches for select using (public.is_family_member(family_id))';
  execute 'drop policy if exists marketplace_saved_searches_insert on public.marketplace_saved_searches';
  execute 'create policy marketplace_saved_searches_insert on public.marketplace_saved_searches for insert with check (public.is_family_member(family_id))';
  execute 'drop policy if exists marketplace_saved_searches_update on public.marketplace_saved_searches';
  execute 'create policy marketplace_saved_searches_update on public.marketplace_saved_searches for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))';
  execute 'drop policy if exists marketplace_saved_searches_delete on public.marketplace_saved_searches';
  execute 'create policy marketplace_saved_searches_delete on public.marketplace_saved_searches for delete using (public.is_family_member(family_id))';
end $$;
