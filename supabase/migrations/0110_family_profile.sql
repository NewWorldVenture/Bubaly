-- FamilyOS :: 0110 family profile fields + member contact fields + RLS safeguard
-- ----------------------------------------------------------------------------
-- The new Family hub page (/dashboard/family) shows a richer family profile
-- (cover photo, mailing address, a shareable family code) and per-member
-- contact details (email, phone, avatar). This migration adds those columns to
-- the existing tables — no new tables, no duplicate domains.
--
--   families:        + cover_url, + address, + family_code (unique)
--   family_members:  + email, + phone, + avatar_url
--
-- It backfills a stable family_code for existing families and re-asserts the
-- canonical RLS on families + family_members (drift guard, see 0105-0109).
--
-- Safe to run anywhere: additive + idempotent.

-- ── families: profile fields ────────────────────────────────────────────────
alter table public.families add column if not exists cover_url   text;
alter table public.families add column if not exists address     text;
alter table public.families add column if not exists family_code text;

-- Backfill a human-friendly, stable share code for families that lack one:
-- three letters from the name + a 4-char hash suffix, e.g. "PAR-7X9M".
update public.families
   set family_code = upper(
         coalesce(nullif(regexp_replace(left(name, 3), '[^A-Za-z]', '', 'g'), ''), 'FAM')
       ) || '-' || upper(substr(md5(id::text), 1, 4))
 where family_code is null;

create unique index if not exists idx_families_family_code on public.families (family_code);

-- ── family_members: contact fields ──────────────────────────────────────────
alter table public.family_members add column if not exists email      text;
alter table public.family_members add column if not exists phone      text;
alter table public.family_members add column if not exists avatar_url text;

create index if not exists idx_family_members_family_active
  on public.family_members (family_id, is_active);

-- ── Re-assert canonical RLS (drift guard) ───────────────────────────────────
alter table public.families enable row level security;
drop policy if exists families_select on public.families;
create policy families_select on public.families for select using (public.is_family_member(id));
drop policy if exists families_update on public.families;
create policy families_update on public.families for update using (public.can_manage_family(id)) with check (public.can_manage_family(id));

alter table public.family_members enable row level security;
drop policy if exists fm_manage on public.family_members;
drop policy if exists fm_select on public.family_members;
create policy fm_select on public.family_members for select using (public.is_family_member(family_id));
drop policy if exists fm_insert on public.family_members;
create policy fm_insert on public.family_members for insert with check (public.can_manage_family(family_id));
drop policy if exists fm_update on public.family_members;
create policy fm_update on public.family_members for update using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id));
drop policy if exists fm_delete on public.family_members;
create policy fm_delete on public.family_members for delete using (public.can_manage_family(family_id));
