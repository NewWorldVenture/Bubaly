-- ============================================================================
-- FamilyOS · SEED — Messages (family_messages, 500) across all kinds.
-- Get-or-creates a "Seed Chat" conversation, then 500 messages (text/image/
-- voice/file/announcement). Idempotent via a '[seed:msg]' marker in content.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_members uuid[];
  v_convo  uuid;
  n int := 500;
  kinds text[] := array['text','text','text','image','voice','file','announcement'];
  bodies text[] := array['On my way home','Can someone grab milk?','Practice is moved to 5pm',
                         'Great job today!','Dinner in 20','Who fed the dog?','Don''t forget the forms',
                         'Running 10 late','Movie night?','Homework done ✅'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;
  select array_agg(id) into v_members from public.family_members where family_id = v_family;

  select id into v_convo from public.family_conversations
    where family_id = v_family and name = 'Seed Chat' limit 1;
  if v_convo is null then
    insert into public.family_conversations (family_id, name, kind, avatar_emoji)
    values (v_family, 'Seed Chat', 'group', '💬') returning id into v_convo;
  end if;

  delete from public.family_messages where family_id = v_family and content like '%[seed:msg]%';

  -- sender_id references auth.users; seed rows use a null sender + a display name
  -- so no real auth user is required.
  insert into public.family_messages (conversation_id, family_id, sender_id, sender_name, content, kind, is_pinned, created_at)
  select
    v_convo, v_family,
    null,
    (array['Mom','Dad','Alex','Sam','Jordan'])[1 + (g.i % 5)],
    bodies[1 + (g.i % array_length(bodies,1))] || ' #' || g.i || ' [seed:msg]',
    kinds[1 + (g.i % array_length(kinds,1))],
    (g.i % 50 = 0),
    now() - ((g.i) || ' minutes')::interval
  from generate_series(1, n) as g(i);

  raise notice 'Messages seeded % rows for family %', n, v_family;
end $$;
