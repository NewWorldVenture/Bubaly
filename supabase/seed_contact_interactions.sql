-- ============================================================================
-- Bubaly · SEED — Contact interactions (500 records).
-- Fills contact_interactions so the per-contact Relationship Timeline can be
-- tested at volume: spreads 500 touches across up to 25 of the family's
-- contacts (creating 8 seed contacts if the family has none), all 6 kinds
-- (visit/call/message/gift/favor/note), dates from ~2 years back to today,
-- gift amounts on gifts. Cadences vary per contact so relationship health
-- shows all states (fresh / due / overdue).
-- Idempotent: tags rows meta->>'seed' = 'contact_interactions' and clears its
-- own rows first. Resolves family by email. (Needs migration 0170 applied.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email    text := 'newworldventurellc@gmail.com';
  v_family   uuid;
  v_user     uuid;
  v_contacts uuid[];
  c_count    int;
  kinds      text[] := array['visit','call','message','gift','favor','note'];
  titles     text[] := array[
    'Sunday dinner','Quick phone catch-up','Checked in by text','Birthday gift',
    'Helped with school pickup','Coffee together','Playdate at the park',
    'Dropped off a meal','Watched the kids','Holiday visit','Thank-you card'];
  n          int := 500;
  i          int;
  k          text;
  ttl        text;
  cid        uuid;
  occurred   date;
  amt        numeric(12,2);
  cadence    int;
  total      int := 0;
begin
  if to_regclass('public.contact_interactions') is null then
    raise notice 'contact_interactions not present — apply migration 0170 first. Skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select user_id into v_user from public.family_members
  where family_id = v_family and user_id is not null order by created_at limit 1;

  -- Ensure there are contacts to hang interactions on.
  select array_agg(id) into v_contacts from (
    select id from public.family_contacts where family_id = v_family order by created_at limit 25
  ) s;
  if coalesce(array_length(v_contacts, 1), 0) = 0 then
    insert into public.family_contacts (family_id, name, relationship, category, created_by)
    select v_family, x.n, x.r, x.c, v_user
    from (values
      ('Grandma June','Grandmother','family'), ('Grandpa Lou','Grandfather','family'),
      ('Aunt Meg','Aunt','family'), ('Coach Dana','Soccer coach','sports'),
      ('Dr. Patel','Pediatrician','medical'), ('Ms. Rivera','Teacher','school'),
      ('The Nguyens','Neighbors','friends'), ('Sitter Chloe','Babysitter','caregivers')
    ) as x(n, r, c);
    select array_agg(id) into v_contacts from (
      select id from public.family_contacts where family_id = v_family order by created_at limit 25
    ) s;
  end if;
  c_count := array_length(v_contacts, 1);

  delete from public.contact_interactions
   where family_id = v_family and meta->>'seed' = 'contact_interactions';

  for i in 0..(n - 1) loop
    cid      := v_contacts[1 + (i % c_count)];
    k        := kinds[1 + (i % array_length(kinds, 1))];
    ttl      := titles[1 + (i % array_length(titles, 1))];
    -- Per-contact cadence (3–45 days) so health states vary across contacts.
    cadence  := 3 + ((1 + (i % c_count)) * 7) % 43;
    occurred := current_date - ((i / c_count) * cadence) - (i % 3);
    amt      := case when k = 'gift' then round((10 + random() * 140)::numeric, 2) else null end;

    insert into public.contact_interactions
      (family_id, contact_id, kind, occurred_on, title, note, amount, meta, created_by, created_at)
    values
      (v_family, cid, k, occurred, ttl,
       case when i % 4 = 0 then 'Seeded relationship touch.' else null end,
       amt, jsonb_build_object('seed', 'contact_interactions'), v_user,
       occurred::timestamptz);

    total := total + 1;
  end loop;

  raise notice 'Seeded % contact_interactions across % contacts for family %.', total, c_count, v_family;
end $$;
