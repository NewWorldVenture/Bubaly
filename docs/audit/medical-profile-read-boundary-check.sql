-- Behavioural proof for 0316, run as real `authenticated` sessions under RLS.
--
-- `medical_profiles` is one row per member: blood type, allergies, conditions,
-- current medications, physician, pharmacy, emergency contacts. Its SELECT
-- policy was `is_family_member(family_id)`, so any member read every row —
-- while 0009's own header above that policy said "children view their own info
-- read-only", and three product surfaces read the table only `if (manager)`.
--
-- The half of this that is easy to get wrong is not the narrowing. It is that
-- two services read the family's ALLERGIES on behalf of whoever is planning
-- (lib/services/groceries, lib/services/meals foodProfile), both through the
-- CALLER's client, and both treat a short read as "no allergies". RLS does not
-- error — it returns fewer rows — so a narrowing alone would have made a
-- child's meal plan allergy-blind while every fail-closed guard stayed quiet.
-- `family_allergies()` is the door that keeps that path whole, and the positive
-- controls below are written first for exactly that reason.
--
-- No blanket `grant ... on all tables in schema public` here: the bootstrap's
-- `alter default privileges` already gives `authenticated` DML on every table a
-- migration creates, and restating it would undo the deliberate revokes that
-- later migrations make, for every probe that runs after this one.
grant usage on schema public to authenticated;

do $$
declare
  fam        uuid := 'ffff5555-0000-4000-8000-00000000000d';
  other_fam  uuid := 'ffff5555-0000-4000-8000-00000000000e';
  parent_uid uuid := 'f5000000-0000-4000-8000-000000000001';
  kid_uid    uuid := 'f5000000-0000-4000-8000-000000000002';
  sib_uid    uuid := 'f5000000-0000-4000-8000-000000000003';
  carer_uid  uuid := 'f5000000-0000-4000-8000-000000000004';
  out_uid    uuid := 'f5000000-0000-4000-8000-000000000005';
  parent_mid uuid;
  kid_mid    uuid;
  sib_mid    uuid;
  carer_mid  uuid;
  out_mid    uuid;
  n          int;
  v_text     text;
begin
  -- Re-runnable, with identifiers of its own so a sibling probe's teardown
  -- cannot reach in.
  delete from public.medical_profiles where family_id in (fam, other_fam);
  delete from public.family_members   where user_id in (parent_uid, kid_uid, sib_uid, carer_uid, out_uid);
  delete from public.families         where id in (fam, other_fam);

  insert into public.families (id, name) values (fam, 'Health'), (other_fam, 'Neighbours');
  insert into auth.users (id, email) values
    (parent_uid, 'hp@example.test'), (kid_uid, 'hk@example.test'), (sib_uid, 'hs@example.test'),
    (carer_uid, 'hc@example.test'), (out_uid, 'ho@example.test')
  on conflict do nothing;

  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, parent_uid, 'Parent', 'parent', true) returning id into parent_mid;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, kid_uid, 'Kid', 'child', true) returning id into kid_mid;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, sib_uid, 'Sibling', 'teen', true) returning id into sib_mid;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, carer_uid, 'Carer', 'caregiver', true) returning id into carer_mid;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (other_fam, out_uid, 'Neighbour', 'parent', true) returning id into out_mid;

  insert into public.medical_profiles
    (family_id, member_id, blood_type, allergies, conditions, current_medications, primary_physician, emergency_contact_phone)
  values
    (fam, parent_mid, 'O-', null,        'hypertension', 'lisinopril 10mg', 'Dr Alvarez', '555-0100'),
    (fam, kid_mid,    'A+', 'shellfish', 'eczema',       null,              'Dr Brooks',  '555-0101'),
    (fam, sib_mid,    'B+', 'Peanuts',   'asthma',       'albuterol',       'Dr Brooks',  '555-0102'),
    (fam, carer_mid,  'AB+', null,       'none',         null,              'Dr Chen',    '555-0103');

  -- ══ POSITIVE CONTROLS FIRST ════════════════════════════════════════════

  -- 1. A manager still reads the whole household. This is the surface
  --    family-health and family-emergency render, and it must not move.
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  select count(*) into n from public.medical_profiles where family_id = fam;
  if n <> 4 then
    raise exception 'a manager can no longer read the family''s medical profiles (% of 4)', n;
  end if;
  select current_medications into v_text from public.medical_profiles where member_id = sib_mid;
  if v_text is distinct from 'albuterol' then
    raise exception 'a manager can no longer read a member''s medications (%)', v_text;
  end if;
  reset role;

  -- 2. A child still reads their OWN record in full. 0009's stated rule —
  --    "children view their own info read-only" — is the thing being made true
  --    here, not removed.
  perform set_config('request.jwt.claim.sub', kid_uid::text, true);
  set local role authenticated;
  select count(*) into n from public.medical_profiles where family_id = fam;
  if n <> 1 then
    raise exception 'a child sees % profiles, expected exactly their own', n;
  end if;
  select conditions into v_text from public.medical_profiles where member_id = kid_mid;
  if v_text is distinct from 'eczema' then
    raise exception 'a child can no longer read their own conditions (%)', v_text;
  end if;

  -- 3. THE ALLERGY PATH. A child planning a meal still learns that someone in
  --    the house cannot eat peanuts. If this assertion ever goes red, the meal
  --    planner and the grocery substituter have gone allergy-blind while every
  --    fail-closed guard in front of them still reads `error === null`.
  select count(*) into n from public.family_allergies(fam);
  if n <> 4 then
    raise exception 'family_allergies returned % rows to a child, expected 4', n;
  end if;
  select allergies into v_text from public.family_allergies(fam) where member_id = sib_mid;
  if v_text is distinct from 'Peanuts' then
    raise exception 'a child cannot see a sibling''s peanut allergy: %', coalesce(v_text, '<null>');
  end if;

  -- ══ THE BOUNDARY ═══════════════════════════════════════════════════════

  -- 4. The sibling's row is not there at all — not redacted, absent.
  select count(*) into n from public.medical_profiles where member_id in (sib_mid, parent_mid);
  if n <> 0 then
    raise exception 'a child read % rows belonging to other members', n;
  end if;

  -- 5. Said as the module says it: `select * where family_id = ...`, the exact
  --    query components/modules/medical-records-module.tsx runs, must not
  --    return another member's medications or physician.
  select count(*) into n
  from public.medical_profiles
  where family_id = fam and (current_medications is not null or primary_physician is not null)
    and member_id <> kid_mid;
  if n <> 0 then
    raise exception 'a child read % other members'' medications/physicians', n;
  end if;

  -- 6. And the narrow door hands over ONLY the two columns it promises. A
  --    function that grew a `conditions` column would defeat the whole
  --    migration while every assertion above still passed, so the signature is
  --    asserted rather than assumed.
  v_text := pg_get_function_result('public.family_allergies(uuid)'::regprocedure);
  if v_text is distinct from 'TABLE(member_id uuid, allergies text)' then
    raise exception 'family_allergies no longer returns exactly (member_id, allergies): %', v_text;
  end if;
  reset role;

  -- 6b. THE CALLER THAT IS NOT A SESSION AT ALL. Every AI tool runs on the
  --     SERVICE client (lib/ai/runs/executor.ts builds its ServiceScope from
  --     createServiceClient()), so `auth.uid()` is null and there is no
  --     membership row to find. The first version of this function raised at
  --     that caller and `groceries.addFromMealPlan` inside the concierge loop
  --     started answering "You don't have permission to do that" — a failure
  --     this probe could not see, because it only ever tested `authenticated`.
  --     It tests both now.
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  set local role service_role;
  begin
    select count(*) into n from public.family_allergies(fam);
  exception when insufficient_privilege then
    raise exception
      'family_allergies refused the SERVICE role, which is the client every AI tool runs on — this is groceries.addFromMealPlan failing inside the concierge loop';
  end;
  if n <> 4 then
    raise exception 'the service role reads % allergy rows, expected 4 — every AI tool runs on this client', n;
  end if;
  reset role;
  perform set_config('request.jwt.claim.role', '', true);

  -- 7. A caregiver is a member and is NOT a manager, so this migration moves
  --    them too: their own row only, and the allergy list still reaches them.
  --    Recorded as an assertion rather than left to be discovered, because a
  --    babysitter who should see blood types is a household policy question and
  --    not something a security fix gets to decide quietly.
  perform set_config('request.jwt.claim.sub', carer_uid::text, true);
  set local role authenticated;
  select count(*) into n from public.medical_profiles where family_id = fam;
  if n <> 1 then
    raise exception 'a caregiver reads % medical profiles, expected exactly their own', n;
  end if;
  select count(*) into n from public.medical_profiles where member_id = sib_mid;
  if n <> 0 then
    raise exception 'a caregiver read a child''s medical record';
  end if;
  select count(*) into n from public.family_allergies(fam);
  if n <> 4 then
    raise exception 'a caregiver cannot read the household allergy list (% of 4)', n;
  end if;
  reset role;

  -- 8. A non-member gets an ERROR, not an empty list. Both callers treat a
  --    short read as "no allergies", so silence here would be the failure mode
  --    this function exists to remove.
  perform set_config('request.jwt.claim.sub', out_uid::text, true);
  set local role authenticated;
  begin
    perform count(*) from public.family_allergies(fam);
    raise exception 'a non-member read another household''s allergy list';
  exception when insufficient_privilege then
    null;
  end;
  select count(*) into n from public.medical_profiles where family_id = fam;
  if n <> 0 then
    raise exception 'a non-member read % rows of another household''s medical profiles', n;
  end if;
  reset role;

  -- 9. Writes are untouched by this migration. A child could not write before
  --    and must not now — a read fix that widened a write would be worse than
  --    the leak it closed.
  perform set_config('request.jwt.claim.sub', kid_uid::text, true);
  set local role authenticated;
  update public.medical_profiles set conditions = 'cured' where member_id = kid_mid;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child rewrote their own medical record (%)', n;
  end if;
  reset role;

  delete from public.medical_profiles where family_id in (fam, other_fam);
  delete from public.family_members   where user_id in (parent_uid, kid_uid, sib_uid, carer_uid, out_uid);
  delete from public.families         where id in (fam, other_fam);

  raise notice '0316 medical profile read boundary: all assertions held';
end $$;

-- 10. Reachability, checked against the fully replayed schema rather than at
--     the migration's own moment. Supabase's default privileges hand EXECUTE on
--     every new function to anon and authenticated; 0316 revokes anon's, and a
--     later migration re-creating the function would hand it straight back —
--     which is the exact way the privileged-RPC grants came undone before.
do $$
begin
  if has_function_privilege('anon', 'public.family_allergies(uuid)', 'EXECUTE') then
    raise exception 'anon can execute family_allergies — an unauthenticated caller reaches medical data';
  end if;
  if not has_function_privilege('authenticated', 'public.family_allergies(uuid)', 'EXECUTE') then
    raise exception 'authenticated cannot execute family_allergies — the meal planner is allergy-blind';
  end if;
  raise notice '0316 family_allergies grants: authenticated only, at the end of the chain';
end $$;
