-- ============================================================================
-- seed_files_one_family.sql — 500+ documents/files for ONE family, so every
-- surface of the redesigned Files page (/dashboard/documents) renders with
-- realistic, world-class content.
-- ----------------------------------------------------------------------------
-- WHAT IT DOES
--   1. Re-asserts family-scoped RLS on public.documents (same drift safeguard
--      as migration 0109) so authenticated members can READ the seeded rows.
--   2. Ensures the documents.is_favorite column exists (folds in 0109 so this
--      seed runs standalone).
--   3. Seeds 500 documents across ~10 folders (School, Finances, Vacation 2025,
--      Health, Photos, Backups, Chores, Insurance, Legal, General) with a
--      realistic mix of file TYPES (pdf, docx, xlsx, pptx, jpg, png, mp4, mov,
--      zip, txt, csv), sizes (KB → GB), owners, shared-vs-private visibility,
--      favorites, expiries, and created/updated dates spread over ~18 months.
--
-- TABLES TOUCHED: public.documents (only).
--
-- TARGET FAMILY: 92298eb2-1a9e-4bdc-9361-677b6c01b499 (active fam of
--   newworldventurellc@gmail.com). Change v_fam / v_email below if needed.
--
-- IDEMPOTENT: every seeded row uses a storage_path under 'seed/files/…'. The
--   block deletes those (for THIS family) before re-inserting, so re-running
--   yields the same 500-row dataset — no duplicate-key or unbounded growth.
--
-- SAFETY: scoped to one family; never auto-runs. The storage_path values point
--   at synthetic objects (there are no real bytes in Storage), which is fine
--   for exercising the list/grid/filters/pagination UI — Download will simply
--   report the object is missing. Do NOT run against production unless you
--   intend to populate that family.
--
-- HOW TO RUN: paste into the Supabase SQL editor and Run, then hard-refresh
--   /dashboard/documents. Verify with the SELECT at the bottom.
-- ============================================================================

-- 0) Self-contained schema safeguard (folds in migration 0109) ----------------
alter table public.documents add column if not exists is_favorite boolean not null default false;

-- 1) RLS safeguard (so the page can READ the seeded rows) ----------------------
alter table public.documents enable row level security;
drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents for select using (public.is_family_member(family_id));
drop policy if exists documents_insert on public.documents;
create policy documents_insert on public.documents for insert with check (public.is_family_member(family_id));
drop policy if exists documents_update on public.documents;
create policy documents_update on public.documents for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));
drop policy if exists documents_delete on public.documents;
create policy documents_delete on public.documents for delete using (public.is_family_member(family_id));

-- 2) + 3) 500 documents -------------------------------------------------------
do $$
declare
  v_fam   uuid := '92298eb2-1a9e-4bdc-9361-677b6c01b499';
  v_email text := 'newworldventurellc@gmail.com';
  v_uid   uuid;
  v_uids  uuid[];   -- member auth user_ids (documents.created_by)
  v_mems  uuid[];   -- family_members ids (documents.member_id, for "private")
  n_uid int;  n_mem int;  i int;  seeded int := 0;

  v_cat text;  v_kind int;  v_ext text;  v_mime text;  v_title text;
  v_size bigint;  v_created timestamptz;  v_expires date;  v_member uuid;  v_fav boolean;

  -- Folders (documents.category is free text — these become the folder cards).
  cats text[] := ARRAY['School','Finances','Vacation 2025','Health','Photos','Backups','Chores','Insurance','Legal','General'];

  -- File-type table: extension, mime, min KB, max KB. Index chosen via a weight
  -- map so docs/images dominate and huge video/zip files are rarer (realistic).
  k_ext  text[] := ARRAY['pdf','docx','xlsx','pptx','jpg','png','mp4','mov','zip','txt','csv'];
  k_mime text[] := ARRAY['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.openxmlformats-officedocument.presentationml.presentation','image/jpeg','image/png','video/mp4','video/quicktime','application/zip','text/plain','text/csv'];
  k_min  int[]  := ARRAY[60,   40,   30,   500,  800,  200,  20000, 30000, 5000,  2,   5];
  k_max  int[]  := ARRAY[4000, 3000, 2000, 8000, 6000, 4000, 300000,250000,1400000,200, 500];
  -- 20-slot weight map → indexes into k_ext (pdf/img heavy, video/zip light).
  k_wt   int[]  := ARRAY[1,1,1,1,2,2,3,4,5,5,5,6,6,7,8,9,10,11,3,2];

  -- Per-folder realistic filename bases (title = base || ' ' || tag || .ext).
  n_school    text[] := ARRAY['Soccer Practice Schedule','Science Project Ideas','Report Card','Reading Log','Permission Slip','Field Trip Form','Spelling List','Book Report','Homework Packet','Class Roster'];
  n_finance   text[] := ARRAY['Monthly Budget','Bank Statement','Tax Return','Investment Summary','Receipts','Mortgage Statement','Credit Card Bill','Pay Stub','Expense Report','401k Summary'];
  n_vacation  text[] := ARRAY['Hawaii Beach','Flight Itinerary','Hotel Confirmation','Passport Info','Packing List','Rental Car','Travel Insurance','Trip Photos','Excursion Tickets','Beach Sunset'];
  n_health    text[] := ARRAY['Doctor Visit Notes','Prescription','Vaccination Record','Lab Results','Insurance Card','Dental X-Ray','Physical Exam','Medication List','Allergy Info','Wellness Plan'];
  n_photos    text[] := ARRAY['Family Reunion','Birthday Party','Camping Trip Video','Beach Day','Holiday Card','First Day of School','Graduation','Backyard BBQ','Snow Day','Sunset Hike'];
  n_backups   text[] := ARRAY['Backup','Photos Archive','Documents Backup','System Backup','Contacts Export','Full Backup','Weekly Backup','Cloud Sync','Device Backup','Restore Point'];
  n_chores    text[] := ARRAY['Chore Rewards Tracker','Chore Chart','Allowance Log','Weekly Checklist','House Rules','Chore Schedule','Points Tracker','Reward Menu','Task List','Cleaning Plan'];
  n_insurance text[] := ARRAY['Auto Insurance','Home Insurance','Life Insurance Policy','Health Plan','Dental Coverage','Renters Policy','Claim Form','Policy Renewal','Coverage Summary','ID Card'];
  n_legal     text[] := ARRAY['Lease Agreement','Will','Power of Attorney','Birth Certificate','Marriage License','Property Deed','Contract','Custody Agreement','Notarized Letter','Trust Document'];
  n_general   text[] := ARRAY['Family Meeting Notes','Wifi Password','Emergency Contacts','Recipe Collection','Household Manual','Warranty','Manual','Instructions','Scanned Document','Misc Notes'];
begin
  if not exists (select 1 from public.families where id = v_fam) then
    raise exception 'Family % not found', v_fam;
  end if;

  select id into v_uid from auth.users where lower(email) = lower(v_email) limit 1;
  select array_agg(user_id) into v_uids from public.family_members where family_id = v_fam and is_active and user_id is not null;
  select array_agg(id)      into v_mems from public.family_members where family_id = v_fam and is_active;
  if v_uids is null then v_uids := array[v_uid]; end if;
  n_uid := array_length(v_uids,1);
  n_mem := coalesce(array_length(v_mems,1), 0);

  -- Idempotent cleanup (this family's seeded files only).
  delete from public.documents where family_id = v_fam and storage_path like 'seed/files/%';

  for i in 1..500 loop
    v_cat  := cats[1 + (i % array_length(cats,1))];
    v_kind := k_wt[1 + (i % array_length(k_wt,1))];   -- 1..11 index into k_ext
    v_ext  := k_ext[v_kind];
    v_mime := k_mime[v_kind];
    v_size := ((k_min[v_kind] + floor(random() * (k_max[v_kind] - k_min[v_kind] + 1))) * 1024)::bigint;

    v_title := (case v_cat
      when 'School'        then n_school   [1 + (i % array_length(n_school,1))]
      when 'Finances'      then n_finance  [1 + (i % array_length(n_finance,1))]
      when 'Vacation 2025' then n_vacation [1 + (i % array_length(n_vacation,1))]
      when 'Health'        then n_health   [1 + (i % array_length(n_health,1))]
      when 'Photos'        then n_photos   [1 + (i % array_length(n_photos,1))]
      when 'Backups'       then n_backups  [1 + (i % array_length(n_backups,1))]
      when 'Chores'        then n_chores   [1 + (i % array_length(n_chores,1))]
      when 'Insurance'     then n_insurance[1 + (i % array_length(n_insurance,1))]
      when 'Legal'         then n_legal    [1 + (i % array_length(n_legal,1))]
      else                      n_general  [1 + (i % array_length(n_general,1))]
    end) || ' ' || to_char(i, 'FM000') || '.' || v_ext;

    -- Dates spread across ~18 months; updated_at a little after created_at.
    v_created := now() - (floor(random() * 540) || ' days')::interval - (floor(random() * 24) || ' hours')::interval;

    -- ~30% of records get an expiry (weighted to Insurance/Legal/Health/School).
    if v_cat in ('Insurance','Legal','Health','School') and random() < 0.5 then
      v_expires := (current_date + (floor(random() * 800) - 120)::int)::date;   -- some expired, some upcoming
    elsif random() < 0.08 then
      v_expires := (current_date + floor(random() * 400)::int)::date;
    else
      v_expires := null;
    end if;

    -- ~35% private to a member, else shared with the family (member_id null).
    if n_mem > 0 and random() < 0.35 then v_member := v_mems[1 + floor(random() * n_mem)::int];
    else v_member := null; end if;

    v_fav := random() < 0.15;

    insert into public.documents
      (family_id, title, category, storage_path, mime_type, size_bytes,
       expires_at, member_id, created_by, is_favorite, created_at, updated_at)
    values (
      v_fam, v_title, v_cat,
      'seed/files/' || i || '.' || v_ext, v_mime, v_size,
      v_expires, v_member, v_uids[1 + (i % n_uid)], v_fav,
      v_created, v_created + (floor(random() * 72) || ' hours')::interval
    );
    seeded := seeded + 1;
  end loop;

  raise notice 'Seeded % documents across % folders for family %.', seeded, array_length(cats,1), v_fam;
end $$;

-- 4) Verify the spread --------------------------------------------------------
select
  count(*)                                                              as total,
  count(distinct category)                                             as folders,
  count(*) filter (where is_favorite)                                  as favorites,
  count(*) filter (where member_id is not null)                        as private_files,
  count(*) filter (where member_id is null)                            as shared_files,
  count(*) filter (where expires_at is not null)                       as with_expiry,
  count(*) filter (where mime_type like 'image/%')                     as images,
  count(*) filter (where mime_type like 'video/%')                     as videos,
  pg_size_pretty(sum(size_bytes))                                      as total_size
from public.documents
where family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499' and storage_path like 'seed/files/%';
