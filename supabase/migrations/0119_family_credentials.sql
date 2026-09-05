-- Bubaly :: 0119 family_credentials (Wi-Fi & Passwords vault)
-- ----------------------------------------------------------------------------
-- Backs the Family hub's "Wi-Fi & Passwords" card with a real store: shared
-- family credentials (Wi-Fi networks, streaming/website/app logins, door PINs,
-- membership numbers, cards). Family-scoped RLS via public.is_family_member;
-- soft-deletable; updated_at trigger. Additive + idempotent.
--
-- NOTE: secrets are stored as text behind RLS (family-only). The UI masks them
-- by default (reveal on demand). Client-side/at-rest encryption is a documented
-- future hardening — see docs/family-vault.md.

create table if not exists public.family_credentials (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  category    text not null default 'other'
              check (category in ('wifi','website','app','streaming','email','card','pin','membership','other')),
  label       text not null,
  username    text,
  secret      text not null default '',
  url         text,
  notes       text,
  member_id   uuid references public.family_members(id) on delete set null,
  is_favorite boolean not null default false,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index if not exists idx_family_credentials_family    on public.family_credentials(family_id, category);
create index if not exists idx_family_credentials_active    on public.family_credentials(family_id, created_at desc) where deleted_at is null;
create index if not exists idx_family_credentials_favorite  on public.family_credentials(family_id, is_favorite) where is_favorite and deleted_at is null;

-- updated_at trigger
drop trigger if exists set_family_credentials_updated on public.family_credentials;
create trigger set_family_credentials_updated
  before update on public.family_credentials
  for each row execute function public.set_updated_at();

-- RLS: family-scoped for all operations
alter table public.family_credentials enable row level security;
drop policy if exists family_credentials_select on public.family_credentials;
create policy family_credentials_select on public.family_credentials
  for select using (public.is_family_member(family_id));
drop policy if exists family_credentials_insert on public.family_credentials;
create policy family_credentials_insert on public.family_credentials
  for insert with check (public.is_family_member(family_id));
drop policy if exists family_credentials_update on public.family_credentials;
create policy family_credentials_update on public.family_credentials
  for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));
drop policy if exists family_credentials_delete on public.family_credentials;
create policy family_credentials_delete on public.family_credentials
  for delete using (public.is_family_member(family_id));
