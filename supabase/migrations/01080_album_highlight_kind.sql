-- Bubaly :: 0108 family_albums 'highlight' kind + RLS safeguard
-- ----------------------------------------------------------------------------
-- The redesigned Memories page distinguishes "Recent Highlights" (curated,
-- front-and-center albums) from ordinary "Albums". Highlights are stored as
-- family_albums rows with kind = 'highlight', but the original CHECK constraint
-- from 0014_core_platform.sql did not allow that value, so those inserts would
-- fail. This migration widens the allowed kinds to include 'highlight'.
--
-- It also re-asserts the canonical family-scoped RLS policies on family_albums
-- and family_photos (idempotently) as a guard against the kind of production
-- policy drift that previously left family pages silently empty (see 0105-0107).
--
-- Safe to run anywhere: additive + idempotent.

-- ── Widen the album kind CHECK to include 'highlight' ────────────────────────
alter table public.family_albums drop constraint if exists family_albums_kind_check;
alter table public.family_albums
  add constraint family_albums_kind_check
  check (kind in (
    'general', 'vacation', 'school', 'sports', 'milestones',
    'holiday', 'birthday', 'highlight', 'other'
  ));

-- Fast lookups of an album's highlights within a family, newest first.
create index if not exists idx_family_albums_family_kind
  on public.family_albums (family_id, kind, created_at desc);

-- ── Re-assert canonical RLS (family-scoped, all verbs) ───────────────────────
alter table public.family_albums enable row level security;
drop policy if exists "family members can manage albums" on public.family_albums;
create policy "family members can manage albums"
  on public.family_albums for all
  using (family_id in (select family_id from public.family_members where user_id = auth.uid()))
  with check (family_id in (select family_id from public.family_members where user_id = auth.uid()));

alter table public.family_photos enable row level security;
drop policy if exists "family members can manage photos" on public.family_photos;
create policy "family members can manage photos"
  on public.family_photos for all
  using (family_id in (select family_id from public.family_members where user_id = auth.uid()))
  with check (family_id in (select family_id from public.family_members where user_id = auth.uid()));
