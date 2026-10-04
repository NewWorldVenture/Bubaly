-- ============================================================================
-- Legacy filename retained: this is a local synthetic-fixture seed only.
-- It writes demo credentials for the exact Patel fixture declared in
-- supabase/seed.sql. It never iterates over live families.
--
-- DATA ONLY: this file must not create/alter tables, indexes, or RLS policies.
-- Migrations 0296 and 0391 remain the authority for the credentials boundary.
-- The guard below refuses to run unless the exact synthetic id AND name exist.
-- Do not run this against a hosted Supabase project or production SQL Editor.
-- ============================================================================

begin;

do $$
declare
  fixture_family_id   constant uuid := '11111111-1111-1111-1111-111111111111';
  fixture_family_name constant text := 'The Patel Family';
  v_uid    uuid;
  v_mems   uuid[];
  n_mem    int;
  i        int;
  seeded   int := 0;

  cat  text[] := ARRAY['wifi','wifi','streaming','streaming','streaming','email','website','app','card','pin','pin','membership','other'];
  lbl  text[] := ARRAY['Home Wi-Fi','Guest Wi-Fi','Netflix','Disney+','Spotify Family','Family Email','Amazon','School Parent Portal','Costco Membership','Garage Door Code','Home Alarm Code','Library Card','Router Admin'];
  usr  text[] := ARRAY['FamilyNet_5G','Guest_Network','family@bubaly.test','family@bubaly.test','family@bubaly.test','thefamily@bubaly.test','family@bubaly.test','parent1','1122 3344 5566','','','2198 4471 0093','admin'];
  sec  text[] := ARRAY['Sunshine!2024','Welcome123','N3tfl!x-Fam24','M!ckey+2024','Pl@yMusic24','Em@ilPass99','Sh0pSmart!24','Sch00lRun24','1234','4827','9153','','admin1234'];
  url  text[] := ARRAY['','','netflix.com','disneyplus.com','spotify.com','mail.google.com','amazon.com','','','','','','192.168.1.1'];
  fav  bool[] := ARRAY[true,false,true,false,false,true,false,false,false,true,true,false,false];
begin
  if not exists (
    select 1
      from public.families
     where id = fixture_family_id
       and name = fixture_family_name
  ) then
    raise exception 'Refusing credentials seed: expected local synthetic family % (%); see supabase/seed.sql.',
      fixture_family_name, fixture_family_id;
  end if;

  select user_id into v_uid
    from public.family_members
   where family_id = fixture_family_id
     and is_active
     and user_id is not null
   limit 1;

  select array_agg(id) into v_mems
    from public.family_members
   where family_id = fixture_family_id
     and is_active;
  n_mem := coalesce(array_length(v_mems, 1), 0);

  -- Clean up only this fixture's prior demo rows. User-created rows are untouched.
  delete from public.family_credentials
   where family_id = fixture_family_id
     and coalesce(notes, '') like '%[seed:vault-fixture]%';

  for i in 1..array_length(cat, 1) loop
    insert into public.family_credentials
      (family_id, category, label, username, secret, url, notes, member_id, is_favorite, created_by)
    values (
      fixture_family_id, cat[i], lbl[i],
      nullif(usr[i], ''), sec[i], nullif(url[i], ''),
      (case i when 3 then 'Synthetic shared family login. ' when 10 then 'Synthetic side door keypad. ' else '' end) || '[seed:vault-fixture]',
      (case when n_mem > 0 and i % 4 = 0 then v_mems[1 + (i % n_mem)] else null end),
      fav[i], v_uid
    );
    seeded := seeded + 1;
  end loop;

  raise notice 'Seeded % demo credentials in synthetic fixture %.', seeded, fixture_family_name;
end $$;

commit;

select
  count(*)                                  as total_seeded,
  count(*) filter (where category = 'wifi') as wifi,
  count(*) filter (where category = 'streaming') as streaming,
  count(*) filter (where is_favorite)       as favorites,
  count(*) filter (where member_id is not null) as member_owned
from public.family_credentials
where family_id = '11111111-1111-1111-1111-111111111111'::uuid
  and coalesce(notes, '') like '%[seed:vault-fixture]%';
