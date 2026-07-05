-- ============================================================================
-- FamilyOS · SEED — Family Vault (family_credentials, 500) across all categories.
-- Wi-Fi, website logins, app PINs, streaming, memberships, etc. Idempotent via a
-- '[seed:vault]' notes marker. Secrets are obviously-fake placeholders.
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migration 0119 applied.)
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_members uuid[];
  n int := 500;
  cats  text[] := array['wifi','website','app','streaming','email','card','pin','membership','other'];
  labels text[] := array['Home Wi-Fi','Netflix','Amazon','School Portal','Bank App','Disney+','Gym Membership',
                        'Spotify','Costco Card','Library Card','Doctor Portal','Utility Account','Xbox','Email'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  delete from public.family_credentials where family_id = v_family and notes = '[seed:vault]';

  insert into public.family_credentials (family_id, category, label, username, secret, url, notes, member_id, is_favorite)
  select v_family,
    cats[1 + (g.i % array_length(cats,1))],
    labels[1 + (g.i % array_length(labels,1))] || ' #' || g.i,
    'user' || g.i || '@example.com',
    'placeholder-secret-' || g.i,
    'https://example.com/' || g.i,
    '[seed:vault]',
    case when v_members is null or g.i % 3 = 0 then null else v_members[1 + (g.i % array_length(v_members,1))] end,
    (g.i % 15 = 0)
  from generate_series(1, n) as g(i);

  raise notice 'Vault seeded % credentials for family %', n, v_family;
end $$;
