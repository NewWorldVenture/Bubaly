-- ============================================================================
-- seed_playbook_all_families.sql — seeds the Family Playbook suggestions inbox
-- (public.family_playbook_suggestions, migration 0126) for EVERY family/profile.
-- ----------------------------------------------------------------------------
-- WHAT IT DOES
--   1. Re-asserts family-scoped RLS on family_playbook_suggestions (drift-safe).
--   2. For EVERY family in public.families, inserts ~10 realistic learned
--      suggestions — the kind Bubaly infers from real usage — in status
--      'suggested', so every profile's /dashboard/playbook has things to review:
--        • Go-to dinner / Grocery staple / Favorite … (category 'preference')
--        • Family tradition (category 'date')
--      each with evidence + a confidence, attributed to a member where sensible.
--
-- TABLE: public.family_playbook_suggestions.   SCOPE: ALL families (all profiles).
--
-- IDEMPOTENT: rows key on the table's own unique (family_id, signature). This
--   seed uses a distinctive '[seed]' suffix inside each signature and deletes
--   exactly those rows before re-inserting, so re-running yields the same set
--   and never touches genuine learned/accepted/dismissed suggestions.
--
-- HOW TO RUN:
--   psql "$SUPABASE_DB_URL" -f supabase/seed_playbook_all_families.sql
--   (or paste into the Supabase SQL editor and press Run). Requires migration
--   0126_family_playbook.sql applied first.
--
-- VERIFY: open /dashboard/playbook on any profile and hard-refresh — the
--   "To review" list fills; Save writes a real family_facts row.
-- ============================================================================

-- 1) RLS repair so the app can READ the seeded rows ---------------------------
do $$
declare t text;
begin
  foreach t in array array['family_playbook_suggestions'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;

-- 2) Seed ~10 suggestions for every family ------------------------------------
do $$
declare
  f         record;
  v_uid     uuid;
  v_members uuid[];
  nm        int;
  i         int;
  seeded    int := 0;
  fams      int := 0;

  cat  text[] := ARRAY['preference','preference','preference','preference','preference','preference','preference','date','date','preference'];
  lbl  text[] := ARRAY['Go-to dinner','Go-to dinner','Grocery staple','Grocery staple','Grocery staple','Favorite show','Favorite restaurant','Family tradition','Family tradition','Movie night pick'];
  val  text[] := ARRAY['Taco night','Sheet-pan salmon','Oat milk','Bananas','Coffee','Bluey','Luigi''s Pizzeria','Sunday pancakes','Fourth of July beach day','Friday pizza + a movie'];
  evd  text[] := ARRAY['Planned 5 times recently','Planned 4 times recently','Added to the list 12 times','Added to the list 9 times','Added to the list 15 times','Marked a family favorite','Rated 5/5','Happened 3 years running around January','Happened 2 years running around July','Added 6 Fridays in a row'];
  conf int[]  := ARRAY[90, 82, 100, 90, 100, 65, 95, 85, 75, 88];
  -- signatures carry a '[seed]' marker so re-runs replace exactly these rows
  sig  text[] := ARRAY['meal:taco-night[seed]','meal:sheet-pan-salmon[seed]','grocery:oat-milk[seed]','grocery:bananas[seed]','grocery:coffee[seed]','fav:show:bluey[seed]','fav:restaurant:luigis-pizzeria[seed]','tradition:sunday-pancakes[seed]','tradition:fourth-of-july-beach-day[seed]','routine:friday-movie[seed]'];
  -- which rows are about a specific member (1-based index into v_members via i%nm); 0 = whole family
  mem  int[]  := ARRAY[0, 0, 0, 0, 0, 1, 0, 0, 0, 1];
begin
  for f in select id from public.families loop
    fams := fams + 1;

    select array_agg(id order by id) into v_members
      from public.family_members where family_id = f.id and is_active;
    if v_members is null or array_length(v_members, 1) is null then
      continue;
    end if;
    nm := array_length(v_members, 1);
    select user_id into v_uid from public.family_members
      where family_id = f.id and is_active and user_id is not null limit 1;

    -- Idempotent cleanup for THIS family's seeded rows (marked signatures only).
    delete from public.family_playbook_suggestions
     where family_id = f.id and signature like '%[seed]';

    for i in 1..array_length(sig,1) loop
      insert into public.family_playbook_suggestions
        (family_id, member_id, category, label, value, evidence, confidence, signature, status, created_by)
      values (
        f.id,
        (case when mem[i] = 1 then v_members[1 + (i % nm)] else null end),
        cat[i], lbl[i], val[i], evd[i], conf[i], sig[i], 'suggested', v_uid
      )
      on conflict (family_id, signature) do update
        set label = excluded.label, value = excluded.value, evidence = excluded.evidence,
            confidence = excluded.confidence, category = excluded.category, status = 'suggested';
      seeded := seeded + 1;
    end loop;
  end loop;

  raise notice 'Seeded % playbook suggestions across % families.', seeded, fams;
end $$;

-- 3) VERIFY -------------------------------------------------------------------
select
  count(*)                                          as seeded_rows,
  count(distinct family_id)                         as families,
  count(*) filter (where status = 'suggested')      as suggested,
  count(*) filter (where category = 'preference')   as preferences,
  count(*) filter (where category = 'date')         as traditions,
  count(*) filter (where member_id is not null)     as member_scoped,
  round(avg(confidence))                            as avg_confidence
from public.family_playbook_suggestions
where signature like '%[seed]';
