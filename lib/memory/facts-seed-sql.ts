// Paste-ready SQL that seeds the Family Knowledge Base (family_facts) with a
// realistic starter set across EVERY family/profile — so every account has a
// populated knowledge base to explore. It is rendered on the admin "Seed test
// data" screen (with a Copy button) and kept here as the single source of truth.
//
// Safety: it only seeds families that currently have ZERO facts, so it never
// clobbers a family that has entered real data. Re-running is a no-op for
// already-populated families. Runs in the Supabase SQL editor (service role).

export const FAMILY_FACTS_SEED_SQL = String.raw`-- ============================================================================
-- Bubaly · Family Knowledge Base seed — across ALL profiles
-- Where: Supabase Dashboard → SQL Editor → New query → paste → Run.
-- Safe: seeds ONLY families that have no facts yet (never overwrites real data).
-- Re-running is a no-op for families already populated.
-- ============================================================================
do $$
declare
  f          record;
  m          record;
  seeded     int := 0;
  shoe_sizes text[] := array['US 8 (toddler)','US 12 (kid)','US 1','US 3','US 6','US 8','US 9','US 10','US 11'];
  shirts     text[] := array['2T','4T','XS','S','M','L','XL'];
  meals      text[] := array['Tacos','Spaghetti','Pizza night','Butter chicken','Stir-fry','Pancakes','Sushi','Grilled cheese'];
  allergies  text[] := array['Peanuts','Tree nuts','Dairy','Shellfish','Eggs','Pollen','Bee stings'];
begin
  for f in select id from public.families loop
    -- Skip any family that already has facts (protect real data).
    if (select count(*) from public.family_facts where family_id = f.id) > 0 then
      continue;
    end if;

    -- Family-level facts (member_id null = whole family).
    insert into public.family_facts (family_id, member_id, category, label, value, notes, is_pinned) values
      (f.id, null, 'contact',   'Pediatrician',      'Dr. Lee — (555) 010-2020',        'Sunrise Pediatrics, Mon–Fri',        true),
      (f.id, null, 'contact',   'Dentist',           'Bright Smiles — (555) 030-4040',  'Checkups every 6 months',            false),
      (f.id, null, 'contact',   'Emergency contact', 'Grandma Rose — (555) 070-8080',   'First call if parents unreachable',  true),
      (f.id, null, 'important', 'Home Wi-Fi',        'Network: Casa · pass: sunflower-42', 'Guest network: Casa-Guest',       true),
      (f.id, null, 'account',   'Streaming login',   'family@home (shared)',            'Ask a parent for the password',      false),
      (f.id, null, 'date',      'Trash day',         'Tuesday',                         'Recycling every other week',         false),
      (f.id, null, 'important', 'Garage code',       '1-4-7-9',                         null,                                 false),
      (f.id, null, 'medical',   'Insurance',         'BlueCross · member #ABC123456',   'Card in the kitchen binder',         false);

    -- Per-member facts.
    for m in select id from public.family_members where family_id = f.id loop
      insert into public.family_facts (family_id, member_id, category, label, value) values
        (f.id, m.id, 'sizes',      'Shoe size',     shoe_sizes[1 + floor(random() * array_length(shoe_sizes, 1))::int]),
        (f.id, m.id, 'sizes',      'Shirt size',    shirts[1 + floor(random() * array_length(shirts, 1))::int]),
        (f.id, m.id, 'preference', 'Favorite meal', meals[1 + floor(random() * array_length(meals, 1))::int]);
      -- ~35% of members get a noted allergy.
      if random() < 0.35 then
        insert into public.family_facts (family_id, member_id, category, label, value, is_pinned) values
          (f.id, m.id, 'medical', 'Allergy', allergies[1 + floor(random() * array_length(allergies, 1))::int], true);
      end if;
    end loop;

    seeded := seeded + 1;
  end loop;

  raise notice 'Family Knowledge Base seeded for % family/families', seeded;
end $$;

-- Verify:
--   select category, count(*) from public.family_facts group by category order by 2 desc;
--   select count(distinct family_id) as families_with_facts from public.family_facts;
`;
