-- ============================================================================
-- seed_memories_one_family.sql — 500+ photos/videos, albums, memories & events
-- for ONE family, so every surface of the redesigned Memories page renders with
-- realistic, world-class content.
-- ----------------------------------------------------------------------------
-- WHAT IT DOES
--   1. Re-asserts the family-scoped RLS policies on family_albums / family_photos
--      (same drift safeguard as migration 0108). Idempotent.
--   2. Seeds ~28 albums: ~10 curated "highlight" albums (kind='highlight', power
--      Recent Highlights + the Timeline) and ~18 themed collections (vacation,
--      school, sports, birthday, holiday, milestones, general → power the Albums
--      row and the Albums tab).
--   3. Seeds 500 family_photos rows (mix of images and videos, ~1 in 7 video)
--      spread across those albums and time, with real thumbnail URLs, captions,
--      and uploaders. The album photo_count is maintained automatically by the
--      existing trg_sync_album_photo_count trigger — we never set it by hand.
--   4. Seeds ~40 family_memories (this year) → the "Memories Added" stat, and a
--      handful of FUTURE calendar_events → the "Upcoming Events" rail.
--   The recent uploads are attributed to OTHER family members so the
--   "Shared With You" rail populates.
--
-- REQUIRES: migration 0108_album_highlight_kind.sql applied first (it widens the
--   family_albums.kind CHECK to allow 'highlight').
--
-- TARGET FAMILY: 92298eb2-1a9e-4bdc-9361-677b6c01b499 (active fam of
--   newworldventurellc@gmail.com). Change v_fam / v_email below if needed.
--
-- IDEMPOTENT: photos/memories are tagged 'seed:memories'; albums/events carry a
--   '[seed:memories]' marker in their description — all seeded rows for THIS
--   family are deleted before re-insert. Re-running yields the same dataset.
--
-- SAFETY: scoped to one family; never auto-runs. Do NOT run against production
--   unless you intend to populate that family. Paste into the Supabase SQL
--   editor and Run, then hard-refresh /dashboard/memories.
-- ============================================================================

-- 0) Self-contained schema safeguard --------------------------------------
-- Normally migration 0108 does this, but fold it in here so the seed runs
-- standalone: widen the album kind CHECK to allow 'highlight' (the original
-- 0014 constraint rejected it → error 23514). Idempotent.
alter table public.family_albums drop constraint if exists family_albums_kind_check;
alter table public.family_albums
  add constraint family_albums_kind_check
  check (kind in (
    'general', 'vacation', 'school', 'sports', 'milestones',
    'holiday', 'birthday', 'highlight', 'other'
  ));

-- 1) RLS safeguard (so the page can READ the seeded rows) ---------------------
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

-- 2) + 3) + 4) Albums, 500 photos, memories, events --------------------------
do $$
declare
  v_fam    uuid := '92298eb2-1a9e-4bdc-9361-677b6c01b499';
  v_email  text := 'newworldventurellc@gmail.com';
  v_uid    uuid;
  v_uids   uuid[];   -- all member auth user_ids
  v_others uuid[];   -- member auth user_ids that are NOT the signed-in user
  v_mems   uuid[];   -- family_members ids (for family_memories.member_id)
  v_albums uuid[] := '{}';
  v_hl     uuid[] := '{}';  -- highlight album ids
  tmp uuid;  i int;  n_alb int;  n_uid int;  n_oth int;
  v_album uuid;  v_uploader uuid;  v_media text;  v_created timestamptz;  v_dur int;
  seeded_p int := 0;  seeded_a int := 0;  seeded_m int := 0;  seeded_e int := 0;

  -- Highlight albums: name, cover seed, days-ago (drives the timeline labels).
  hl_names   text[] := ARRAY['Summer at the Lake','Ella''s First Steps','Family Reunion 2026','Snow Day Adventures','Beach Getaway','Backyard Campout','Grandma''s 80th','Morning Hikes','Birthday Bash','Holiday Lights'];
  hl_days    int[]  := ARRAY[0, 1, 3, 5, 9, 16, 30, 62, 120, 210];

  -- Themed collections: name, kind, cover seed.
  col_names  text[] := ARRAY['Yellowstone Trip','First Day of School','Soccer Season','Ava''s Birthday','Thanksgiving','Piano Recital','Spring Garden','Weekend in the City','New Puppy','Science Fair','Halloween','Cousins Visit','Fishing Trip','Dance Recital','Road Trip West','Baking Sundays','Fall Colors','Little League'];
  col_kinds  text[] := ARRAY['vacation','school','sports','birthday','holiday','milestones','general','vacation','general','school','holiday','general','vacation','milestones','vacation','general','general','sports'];

  caps       text[] := ARRAY['Best day ever','Golden hour','Caught mid-laugh','So proud of you','Making memories','Little explorer','Family time','Sunshine and smiles','A moment to keep','Together again','First of many','Pure joy','Look at that grin','Adventure awaits','Home is where we are'];
  mem_titles text[] := ARRAY['Ella said her first word','We planted a maple tree','Family movie marathon','Learned to ride a bike','Baked grandma''s recipe','First soccer goal','Camping under the stars','Sunday pancake tradition','Read our 100th bedtime book','Beach sandcastle champions'];
  ev_titles  text[] := ARRAY['Grandpa''s Birthday','School Winter Concert','Championship Game','Family Photo Session','Cousin''s Wedding','Thanksgiving Dinner'];
  ev_cats    text[] := ARRAY['birthday','school','sports','general','holiday','holiday'];
  ev_days    int[]  := ARRAY[3, 9, 14, 21, 34, 51];
begin
  if not exists (select 1 from public.families where id = v_fam) then
    raise exception 'Family % not found', v_fam;
  end if;

  select id into v_uid from auth.users where lower(email) = lower(v_email) limit 1;
  select array_agg(user_id) into v_uids   from public.family_members where family_id = v_fam and is_active and user_id is not null;
  select array_agg(user_id) into v_others from public.family_members where family_id = v_fam and is_active and user_id is not null and user_id <> v_uid;
  select array_agg(id)      into v_mems   from public.family_members where family_id = v_fam and is_active;
  if v_uids   is null then v_uids   := array[v_uid]; end if;
  if v_others is null or array_length(v_others,1) is null then v_others := v_uids; end if;
  n_uid := array_length(v_uids,1);
  n_oth := array_length(v_others,1);

  -- Idempotent cleanup (this family only) ------------------------------------
  delete from public.family_photos   where family_id = v_fam and 'seed:memories' = any(tags);
  delete from public.family_albums   where family_id = v_fam and coalesce(description,'') like '%[seed:memories]%';
  delete from public.family_memories where family_id = v_fam and 'seed:memories' = any(tags);
  delete from public.calendar_events where family_id = v_fam and coalesce(description,'') like '%[seed:memories]%';

  -- Highlight albums (kind='highlight') --------------------------------------
  for i in 1..array_length(hl_names,1) loop
    insert into public.family_albums (family_id, name, description, cover_url, kind, is_shared, created_by, created_at, updated_at)
    values (
      v_fam, hl_names[i], 'A favorite family highlight. [seed:memories]',
      format('https://picsum.photos/seed/fos-hl-%s/900/600', i),
      'highlight', true, v_uid,
      now() - (hl_days[i] || ' days')::interval, now() - (hl_days[i] || ' days')::interval
    ) returning id into tmp;
    v_hl     := array_append(v_hl, tmp);
    v_albums := array_append(v_albums, tmp);
    seeded_a := seeded_a + 1;
  end loop;

  -- Themed collection albums --------------------------------------------------
  for i in 1..array_length(col_names,1) loop
    insert into public.family_albums (family_id, name, description, cover_url, kind, is_shared, created_by, created_at, updated_at)
    values (
      v_fam, col_names[i], 'Family album. [seed:memories]',
      format('https://picsum.photos/seed/fos-col-%s/900/600', i),
      col_kinds[i], true, coalesce(v_uid, v_uids[1 + (i % n_uid)]),
      now() - ((i * 19) || ' days')::interval, now() - ((i * 19) || ' days')::interval
    ) returning id into tmp;
    v_albums := array_append(v_albums, tmp);
    seeded_a := seeded_a + 1;
  end loop;

  n_alb := array_length(v_albums,1);

  -- 500 photos/videos ---------------------------------------------------------
  for i in 1..500 loop
    -- ~1 in 10 loose (no album); rest linked so album strips + counts fill in.
    if i % 10 = 0 then v_album := null; else v_album := v_albums[1 + (i % n_alb)]; end if;

    -- First 60 are recent + uploaded by OTHER members → Shared With You rail.
    if i <= 60 then
      v_created  := now() - ((i % 21) || ' days')::interval - ((i % 24) || ' hours')::interval;
      v_uploader := v_others[1 + (i % n_oth)];
    else
      v_created  := now() - (((i * 37) % 520) || ' days')::interval;
      v_uploader := v_uids[1 + (i % n_uid)];
    end if;

    if i % 7 = 0 then v_media := 'video'; v_dur := 12 + (i % 180); else v_media := 'image'; v_dur := null; end if;

    insert into public.family_photos
      (family_id, album_id, uploaded_by, storage_path, url, thumbnail_url, caption, taken_at,
       media_type, duration_seconds, is_favorite, tags, created_at)
    values (
      v_fam, v_album, v_uploader,
      format('seed/memories/%s.%s', i, case when v_media = 'video' then 'mp4' else 'jpg' end),
      format('https://picsum.photos/seed/fos-photo-%s/1200/900', i),
      format('https://picsum.photos/seed/fos-photo-%s/400/400', i),
      caps[1 + (i % array_length(caps,1))], v_created,
      v_media, v_dur, (i % 6 = 0), array['seed:memories'], v_created
    );
    seeded_p := seeded_p + 1;
  end loop;

  -- ~40 family_memories (this year) → "Memories Added" stat --------------------
  for i in 1..40 loop
    insert into public.family_memories
      (family_id, member_id, title, body, kind, memory_date, tags, is_favorite, created_by, created_at, updated_at)
    values (
      v_fam,
      case when v_mems is not null then v_mems[1 + (i % array_length(v_mems,1))] else null end,
      mem_titles[1 + (i % array_length(mem_titles,1))],
      'A little moment worth remembering. [seed:memories]',
      (array['milestone','journal','achievement','trip','photo'])[1 + (i % 5)],
      (current_date - ((i * 8) % 340))::date,
      array['seed:memories'], (i % 4 = 0), v_uid,
      now() - ((i * 8) % 340 || ' days')::interval, now() - ((i * 8) % 340 || ' days')::interval
    );
    seeded_m := seeded_m + 1;
  end loop;

  -- Upcoming calendar_events → "Upcoming Events" rail --------------------------
  for i in 1..array_length(ev_titles,1) loop
    insert into public.calendar_events
      (family_id, title, description, category, starts_at, ends_at, all_day, created_by, created_at, updated_at)
    values (
      v_fam, ev_titles[i], 'Family event. [seed:memories]', ev_cats[i]::public.event_category,
      (current_date + ev_days[i] + time '18:00')::timestamptz,
      (current_date + ev_days[i] + time '20:00')::timestamptz,
      false, v_uid, now(), now()
    );
    seeded_e := seeded_e + 1;
  end loop;

  raise notice 'Seeded % albums, % photos/videos, % memories, % events for family %.',
    seeded_a, seeded_p, seeded_m, seeded_e, v_fam;
end $$;

-- 5) Verify the spread --------------------------------------------------------
select
  (select count(*) from public.family_albums where family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499' and coalesce(description,'') like '%[seed:memories]%')                              as albums,
  (select count(*) from public.family_albums where family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499' and kind = 'highlight' and coalesce(description,'') like '%[seed:memories]%')      as highlights,
  (select count(*) from public.family_photos where family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499' and 'seed:memories' = any(tags))                                                    as media_total,
  (select count(*) from public.family_photos where family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499' and media_type = 'video' and 'seed:memories' = any(tags))                           as videos,
  (select count(*) from public.family_photos where family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499' and created_at >= date_trunc('year', now()) and 'seed:memories' = any(tags))        as media_this_year,
  (select count(*) from public.family_memories where family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499' and 'seed:memories' = any(tags))                                                  as memories,
  (select count(*) from public.calendar_events where family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499' and starts_at >= now() and coalesce(description,'') like '%[seed:memories]%')     as upcoming_events;
