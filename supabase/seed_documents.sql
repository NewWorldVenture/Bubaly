-- ============================================================================
-- FamilyOS · SEED — Documents (documents, 500) with placeholder storage paths.
-- Mix of categories + some expiring soon + some secure. Idempotent via a
-- '[seed:doc]' title marker. Files aren't uploaded (storage_path is a stub) —
-- rows are for exercising list/filter/expiry UI at volume.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_members uuid[];
  n int := 500;
  cats  text[] := array['insurance','medical','school','legal','finance','vehicle','home','travel'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  delete from public.documents where family_id = v_family and title like '%[seed:doc]%';

  insert into public.documents (family_id, title, category, storage_path, mime_type, size_bytes, expires_at, member_id, is_secure)
  select v_family,
    initcap(cats[1 + (g.i % array_length(cats,1))]) || ' Doc #' || g.i || ' [seed:doc]',
    cats[1 + (g.i % array_length(cats,1))],
    v_family || '/seed/docs/doc-' || g.i || '.pdf',
    'application/pdf',
    (50000 + (g.i * 137) % 2000000),
    case when g.i % 3 = 0 then (current_date + ((g.i % 90) - 15)) else null end,  -- some expiring soon/expired
    case when v_members is null or g.i % 2 = 0 then null else v_members[1 + (g.i % array_length(v_members,1))] end,
    (g.i % 7 = 0)
  from generate_series(1, n) as g(i);

  raise notice 'Documents seeded % rows for family %', n, v_family;
end $$;
