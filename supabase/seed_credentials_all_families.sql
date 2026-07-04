-- ============================================================================
-- seed_credentials_all_families.sql — seeds the Wi-Fi & Passwords vault
-- (public.family_credentials) for EVERY family / profile.
-- ----------------------------------------------------------------------------
-- WHAT IT DOES
--   1. Folds in migration 0119 (creates family_credentials + RLS) so this seed
--      runs standalone, then re-asserts the table exists.
--   2. For EVERY family in public.families, inserts ~13 realistic shared
--      credentials covering every category (wifi, streaming, email, website,
--      app, card, pin, membership, other) — networks, logins, door codes,
--      membership numbers — attributed to a real family member where possible.
--
-- TABLES TOUCHED: public.family_credentials (only).
-- SCOPE: ALL families (all profiles), not a single test family.
--
-- IDEMPOTENT: every seeded row carries a '[seed:vault]' marker in `notes`. The
--   block deletes those rows (across all families) before re-inserting, so
--   re-running yields the same dataset — no duplicates or unbounded growth.
--   Real (user-created) rows are never touched.
--
-- SAFETY: the secrets are obviously fake demo values. RLS keeps every row
--   family-scoped. Run in the Supabase SQL editor, then hard-refresh
--   /dashboard/passwords (or the Family hub "Wi-Fi & Passwords" card).
-- ============================================================================

-- 0) Self-contained schema safeguard (folds in migration 0119) ----------------
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
create index if not exists idx_family_credentials_family on public.family_credentials(family_id, category);

alter table public.family_credentials enable row level security;
drop policy if exists family_credentials_select on public.family_credentials;
create policy family_credentials_select on public.family_credentials for select using (public.is_family_member(family_id));
drop policy if exists family_credentials_insert on public.family_credentials;
create policy family_credentials_insert on public.family_credentials for insert with check (public.is_family_member(family_id));
drop policy if exists family_credentials_update on public.family_credentials;
create policy family_credentials_update on public.family_credentials for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));
drop policy if exists family_credentials_delete on public.family_credentials;
create policy family_credentials_delete on public.family_credentials for delete using (public.is_family_member(family_id));

-- 1) Seed every family --------------------------------------------------------
do $$
declare
  f        record;
  v_uid    uuid;      -- a member's auth user id (created_by)
  v_mems   uuid[];    -- family_member ids (member_id owner)
  n_mem    int;
  i        int;
  seeded   int := 0;
  fams     int := 0;

  cat  text[] := ARRAY['wifi','wifi','streaming','streaming','streaming','email','website','app','card','pin','pin','membership','other'];
  lbl  text[] := ARRAY['Home Wi-Fi','Guest Wi-Fi','Netflix','Disney+','Spotify Family','Family Email','Amazon','School Parent Portal','Costco Membership','Garage Door Code','Home Alarm Code','Library Card','Router Admin'];
  usr  text[] := ARRAY['FamilyNet_5G','Guest_Network','family@bubaly.test','family@bubaly.test','family@bubaly.test','thefamily@bubaly.test','family@bubaly.test','parent1','1122 3344 5566','','','2198 4471 0093','admin'];
  sec  text[] := ARRAY['Sunshine!2024','Welcome123','N3tfl!x-Fam24','M!ckey+2024','Pl@yMusic24','Em@ilPass99','Sh0pSmart!24','Sch00lRun24','1234','4827','9153','',
                       'admin1234'];
  url  text[] := ARRAY['','','netflix.com','disneyplus.com','spotify.com','mail.google.com','amazon.com','','','','','','192.168.1.1'];
  fav  bool[] := ARRAY[true, false, true, false, false, true, false, false, false, true, true, false, false];
begin
  for f in select id, name from public.families loop
    fams := fams + 1;

    select user_id into v_uid from public.family_members where family_id = f.id and is_active and user_id is not null limit 1;
    select array_agg(id) into v_mems from public.family_members where family_id = f.id and is_active;
    n_mem := coalesce(array_length(v_mems,1), 0);

    -- Idempotent cleanup for THIS family's seeded rows.
    delete from public.family_credentials
     where family_id = f.id and coalesce(notes,'') like '%[seed:vault]%';

    for i in 1..array_length(cat,1) loop
      insert into public.family_credentials
        (family_id, category, label, username, secret, url, notes, member_id, is_favorite, created_by)
      values (
        f.id, cat[i], lbl[i],
        nullif(usr[i], ''), sec[i], nullif(url[i], ''),
        -- Every seeded row is tagged so it can be cleanly removed later.
        (case i when 3 then 'Shared family login. ' when 10 then 'Side door keypad. ' else '' end) || '[seed:vault]',
        -- ~1 in 4 belongs to a specific member; the rest are whole-family.
        (case when n_mem > 0 and i % 4 = 0 then v_mems[1 + (i % n_mem)] else null end),
        fav[i], v_uid
      );
      seeded := seeded + 1;
    end loop;
  end loop;

  raise notice 'Seeded % credentials across % families.', seeded, fams;
end $$;

-- 2) Verify -------------------------------------------------------------------
select
  count(*)                                            as total_seeded,
  count(distinct family_id)                           as families,
  count(*) filter (where category = 'wifi')           as wifi,
  count(*) filter (where category = 'streaming')      as streaming,
  count(*) filter (where is_favorite)                 as favorites,
  count(*) filter (where member_id is not null)       as member_owned
from public.family_credentials
where coalesce(notes,'') like '%[seed:vault]%';
