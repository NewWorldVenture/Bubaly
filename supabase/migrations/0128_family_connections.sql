-- FamilyOS :: 0128 Family connections (North Star pillar #9 — Family API)
-- ----------------------------------------------------------------------------
-- The orchestration hub: a durable, family-scoped record of the external
-- services a family connects (calendars, email, banking, grocery, smart home).
-- This is the data model the OAuth/token flows populate as each provider is
-- enabled server-side; the /dashboard/connections surface reads + manages it.
-- Tokens themselves are NOT stored here (they belong in a secret store) — this
-- tracks the connection, account label, status, and last sync.
--
-- Family-scoped RLS. Additive + idempotent.

create table if not exists public.family_connections (
  id                  uuid primary key default gen_random_uuid(),
  family_id           uuid not null references public.families(id) on delete cascade,
  provider            text not null,                 -- e.g. 'google_calendar'
  category            text not null default 'other'
                        check (category in ('calendar','email','banking','grocery','smart_home','other')),
  status              text not null default 'connected'
                        check (status in ('connected','syncing','error','disconnected')),
  account_label       text,                          -- e.g. 'mom@gmail.com'
  external_account_id text,
  last_synced_at      timestamptz,
  error_message       text,
  metadata            jsonb not null default '{}'::jsonb,
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- One live row per family+provider+account (re-connecting the same account is an upsert).
  unique (family_id, provider, external_account_id)
);
create index if not exists idx_family_connections_family on public.family_connections(family_id, status, category);

-- updated_at trigger
drop trigger if exists set_family_connections_updated on public.family_connections;
create trigger set_family_connections_updated before update on public.family_connections
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['family_connections'] loop
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
