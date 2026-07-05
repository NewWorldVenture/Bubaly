-- ============================================================================
-- FamilyOS · SEED — Pillar #3: Family Intelligence / Playbook
-- 500 suggested playbook facts in the review inbox (/dashboard/playbook) so you
-- can fully test Save / Dismiss / realtime. Idempotent: unique(family_id,
-- signature) → ON CONFLICT DO NOTHING (re-run is a no-op; dismissed/accepted
-- rows never resurface).
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  n int := 500;
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  insert into public.family_playbook_suggestions (family_id, member_id, category, label, value, evidence, confidence, signature, status)
  select
    v_family, null,
    (array['preference','preference','preference','date','preference','other'])[1 + (g.i % 6)],
    (array['Go-to dinner','Grocery staple','Favorite activity','Family tradition','Travel style','Weekend ritual'])[1 + (g.i % 6)],
    (array['Taco night','Oat milk','Movie night','Summer camping','Beach getaways','Sunday pancakes',
           'Pizza Friday','Pasta night','Trail hikes','Game night','Farmers market','Bike rides'])[1 + floor(random()*12)::int] || ' #' || g.i,
    'Seen ' || (3 + floor(random()*9))::int || ' times in recent activity',
    45 + floor(random()*50)::int,
    'seed-p3:' || g.i,        -- unique, stable signature (idempotent)
    'suggested'
  from generate_series(1, n) as g(i)
  on conflict (family_id, signature) do nothing;

  raise notice 'Pillar #3 (playbook) seeded up to % suggestions for family %', n, v_family;
end $$;
