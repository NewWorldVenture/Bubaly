-- ============================================================================
-- FamilyOS · SEED — Anchor family household (a 2nd parent + 3 kids).
--
-- ROOT CAUSE under LB-014: the anchor/demo family is created by the family
-- trigger with ONLY its parent member — no children. So every kid-dependent seed
-- block that filters `role in ('child','teen')` (chores, allowances, grades, kid
-- wallets, kid investing) produces 0 rows for the anchor, and the marketplace
-- hand-off/returns seeds ERROR ("requires two existing members for family …f1").
-- The whole kids experience demos empty in a fresh env.
--
-- This gives the anchor a realistic household so those seeds populate: one more
-- adult (co-parent) and three kids (a teen + two children) with plausible ages.
-- Member ids are DETERMINISTIC per family (md5 of the family id + a slot key), so
-- re-runs are a clean no-op via `on conflict (id) do nothing` — never delete +
-- recreate (which would cascade-orphan any data later seeds attach to a kid).
--
-- MUST run EARLY — right after the family exists, BEFORE the kid-dependent seed
-- blocks — when the LB-014 owner wires it into SEED_ALL. Resolves the family by
-- the anchored account email, so it works on the harness and in prod alike.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_today  date := current_date;
  -- (slot key, role, display name, color, age in years)
  kids     text[][] := array[
    array['coparent','adult','Jordan Rivera','blue','38'],
    array['teen','teen','Ava Rivera','violet','15'],
    array['child1','child','Liam Rivera','emerald','10'],
    array['child2','child','Mia Rivera','amber','7']
  ];
  i        int;
  v_id     uuid;
  seeded   int := 0;
begin
  if to_regclass('public.family_members') is null then
    raise notice 'family_members not present — skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then
    raise notice 'No family found for % — skipping.', v_email;
    return;
  end if;

  for i in 1 .. array_length(kids, 1) loop
    -- Deterministic per family + slot → idempotent, no delete/cascade.
    v_id := md5(v_family::text || ':household:' || kids[i][1])::uuid;
    insert into public.family_members
      (id, family_id, user_id, role, display_name, color, birthday, is_active)
    values (
      v_id, v_family, null,
      kids[i][2]::public.member_role,
      kids[i][3],
      kids[i][4],
      (v_today - ((kids[i][5]::int) * 365 + 60) * interval '1 day')::date,
      true)
    on conflict (id) do nothing;
    if found then seeded := seeded + 1; end if;
  end loop;

  raise notice 'seed_anchor_household: ensured co-parent + 3 kids for family % (% newly added)', v_family, seeded;
end $$;
