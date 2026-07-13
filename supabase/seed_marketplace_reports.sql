-- ============================================================================
-- FamilyOS · SEED — Marketplace safety reports (~500 rows).
-- Fills the super-admin moderation queue (/admin/marketplace/reports): up to
-- 500 reports across all seven reasons and all four statuses, one per distinct
-- listing (so the "one open report per listing+member" index is never
-- contended). Reporter is a throwaway "Safety Reporters" family. Resolved rows
-- carry a resolution + reviewer stamp. Idempotent: clears its own rows first
-- (tagged in details). Requires the anchored family account by email.
-- (Needs migrations 0120 + 0193.)  Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email   text := 'newworldventurellc@gmail.com';
  v_family  uuid;
  v_user    uuid;
  v_rfam    uuid;
  v_rmem    uuid[];
  reasons   text[] := array['prohibited','scam','miscategorized','offensive','spam','duplicate','other'];
  statuses  text[] := array['open','reviewing','actioned','dismissed'];
  details_by text[] := array[
    'Looks like a scam — asked to pay off-platform.','Not allowed for families.',
    'Posted in the wrong category.','Inappropriate photo.','Reposted five times.',
    'Same item as another listing.','Just doesn''t seem right.'];
  ids       uuid[];
  lot       uuid;
  st        text;
  rs        text;
  n         int;
begin
  if to_regclass('public.marketplace_reports') is null then
    raise notice 'marketplace_reports not present — apply migration 0193 first. Skipping.'; return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then
    raise exception 'Marketplace reports seed requires the anchored account %.', v_email;
  end if;
  select fm.user_id into v_user from public.family_members fm
    where fm.family_id = v_family order by fm.created_at limit 1;

  -- Throwaway reporter family + two members (stable ids).
  insert into public.families (id, name) values ('a0000000-0000-4000-8000-00000000fc01', 'Safety Reporters')
    on conflict (id) do nothing;
  v_rfam := 'a0000000-0000-4000-8000-00000000fc01';
  insert into public.family_members (id, family_id, role, display_name, is_active) values
    ('a0000000-0000-4000-8000-00000000fc11', v_rfam, 'parent', 'Reporter Rita', true),
    ('a0000000-0000-4000-8000-00000000fc12', v_rfam, 'parent', 'Reporter Rob',  true)
    on conflict (id) do nothing;
  v_rmem := array['a0000000-0000-4000-8000-00000000fc11'::uuid, 'a0000000-0000-4000-8000-00000000fc12'::uuid];

  -- Clean prior seed.
  delete from public.marketplace_reports where details like '%[seed:report]%';

  -- Up to 500 distinct listings from the anchored family → one report each.
  select array_agg(id) into ids from (
    select id from public.marketplace_listings where family_id = v_family order by created_at limit 500
  ) s;
  if ids is null then raise notice 'No listings to report — seed the marketplace first. Skipping.'; return; end if;

  for i in 1..array_length(ids, 1) loop
    lot := ids[i];
    st  := statuses[1 + ((i - 1) % 4)];
    rs  := reasons[1 + ((i - 1) % 7)];
    insert into public.marketplace_reports
      (family_id, listing_id, reporter_member, reason, details, status, resolution, reviewed_by, reviewed_at, created_at)
    values (
      v_rfam, lot, v_rmem[1 + ((i - 1) % 2)], rs,
      details_by[1 + ((i - 1) % 7)] || ' [seed:report]', st,
      case when st in ('actioned','dismissed')
        then (case when st = 'actioned' then 'Confirmed — listing withdrawn.' else 'Reviewed — no violation found.' end)
        else null end,
      case when st in ('actioned','dismissed') then v_user else null end,
      case when st in ('actioned','dismissed') then now() - interval '2 hours' else null end,
      now() - ((i % 20) || ' hours')::interval);
  end loop;

  get diagnostics n = row_count;
  raise notice 'Seeded reports across % listings for family %', array_length(ids, 1), v_family;
end $$;

-- Verify:
--   select count(*) from marketplace_reports where details like '%[seed:report]%';                 -- up to 500
--   select status, count(*) from marketplace_reports where details like '%[seed:report]%' group by 1 order by 1;
--   select reason, count(*) from marketplace_reports where details like '%[seed:report]%' group by 1 order by 1;
