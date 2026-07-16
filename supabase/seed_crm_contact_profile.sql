-- ============================================================================
-- FamilyOS · SEED — Progressive-profiling answers (500 records).
-- Fills crm_contact_profile so the progressive-profiling flow + segmentation
-- can be tested at volume. Creates 500 seed crm_contacts leads (if needed) and
-- gives each a partial-to-complete profile: a spread of role / top_priority /
-- household_size / child_ages / interests, some with skipped questions, so the
-- "next question" logic and completeness bars show every state.
-- Idempotent: tags rows meta/lead_source and clears its own rows first.
-- (Needs migration 0171 applied.) Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  roles       text[] := array['parent','grandparent','caregiver','other'];
  priorities  text[] := array['calendar','meals','chores','money','paperwork','other'];
  ages        text[] := array['none','little','school','teen','mixed'];
  interests   text[] := array['calendar','meals','chores','money','paperwork','health','activities'];
  n           int := 500;
  i           int;
  cid         uuid;
  fill        int;       -- how many fields to fill (0..5) → varied completeness
  ints        text[];
  extra       jsonb;
  total       int := 0;
begin
  if to_regclass('public.crm_contact_profile') is null then
    raise notice 'crm_contact_profile not present — apply migration 0171 first. Skipping.';
    return;
  end if;

  -- Clear prior seed (profiles + their seed contacts).
  delete from public.crm_contact_profile p using public.crm_contacts c
   where p.contact_id = c.id and c.lead_source = 'seed_profile';
  delete from public.crm_contacts where lead_source = 'seed_profile';

  for i in 0..(n - 1) loop
    insert into public.crm_contacts (email, lead_source, lead_status, lifecycle_stage, first_name)
    values ('profile+' || i || '@seed.bubaly.app', 'seed_profile', 'new', 'lead', 'Lead ' || i)
    returning id into cid;

    fill := i % 6;  -- 0..5
    ints := case when fill >= 5 then (select array_agg(x) from unnest(interests) x where random() < 0.5) else null end;
    -- Every 4th partial profile has a skipped question recorded.
    extra := case when fill in (1,2) and i % 4 = 0
                  then jsonb_build_object('skipped', jsonb_build_array(priorities[1 + (i % 6)]))
                  else '{}'::jsonb end;

    insert into public.crm_contact_profile
      (contact_id, role, top_priority, household_size, child_ages, interests, extra)
    values (
      cid,
      case when fill >= 1 then roles[1 + (i % array_length(roles,1))] else null end,
      case when fill >= 2 then priorities[1 + (i % array_length(priorities,1))] else null end,
      case when fill >= 3 then 2 + (i % 5) else null end,
      case when fill >= 4 then ages[1 + (i % array_length(ages,1))] else null end,
      coalesce(ints, '{}'),
      extra
    );

    total := total + 1;
  end loop;

  raise notice 'Seeded % crm_contact_profile rows (with seed contacts).', total;
end $$;
