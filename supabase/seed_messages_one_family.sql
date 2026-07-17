-- ============================================================================
-- seed_messages_one_family.sql — 520 family_messages across ~15 conversations
-- for ONE family, so the redesigned /dashboard/messages page renders fully.
-- ----------------------------------------------------------------------------
-- WHAT IT DOES
--   1. Re-asserts family-scoped RLS on family_conversations + family_messages
--      (SELECT/INSERT/UPDATE/DELETE via public.is_family_member) — same drift
--      fix as migrations 0105/0106. Safe + idempotent.
--   2. Ensures a realistic set of conversations for the family, covering every
--      tab on the page:
--        • 1 main family group          (tab: Groups / All)
--        • 5 themed groups              (Soccer Team Parents, Neighborhood
--          Group, Vacation 2025, Play Dates, Book Club)
--        • 2 announcement channels      (tab: Announcements)
--        • 1 archived group             (View archived conversations)
--        • 1 direct message per other family member (tab: Direct)
--   3. Seeds 520 family_messages spread across those conversations with a
--      realistic mix of: text / image / file / announcement kinds, reactions,
--      read + UNREAD state (drives the purple unread badges), pinned messages,
--      and timestamps spanning the last ~12 days incl. a cluster "today" (so
--      the Today divider shows).
--
-- TABLES TOUCHED: public.family_conversations, public.family_messages
-- ROW COUNT: 520 messages (+ up to ~15 conversations, created once & reused).
--
-- TARGET FAMILY: resolved reproducibly at runtime.
--   newworldventurellc@gmail.com). Change v_fam / v_email below if needed.
--
-- IDEMPOTENT: every seeded message is tagged sender_avatar='seed:messages' and
--   deleted before re-insert. Seeded conversations are reused if they already
--   exist (matched by family_id + name + created_by), so re-running never
--   duplicates and never touches your real (non-seed) conversations.
--
-- HOW TO RUN (local):
--   npm run db:seed:messages
--     -- or --
--   psql "$SUPABASE_DB_URL" -f supabase/seed_messages_one_family.sql
--   (also runnable by pasting into the Supabase SQL editor and pressing Run)
--
-- VERIFY: open /dashboard/messages and hard-refresh. You should see the
--   conversation list with previews + unread badges, tabs (All/Direct/Groups/
--   Announcements), a full thread with reactions, and the About panel.
-- ============================================================================

-- 1) RLS repair so the page can READ/WRITE the seeded rows --------------------
do $$
declare t text;
begin
  foreach t in array array['family_conversations','family_messages'] loop
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

-- 2) + 3) Conversations and 520 messages -------------------------------------
do $$
declare
  v_fam uuid := coalesce((select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1),(select fm.family_id from public.family_members fm where fm.is_active and fm.role not in ('parent','adult') group by fm.family_id order by min(fm.created_at) limit 1),(select id from public.families order by created_at limit 1));  -- reproducible (was a hardcoded prod UUID)
  v_email       text := 'newworldventurellc@gmail.com';
  v_uid         uuid;
  v_self_name   text;
  v_family_name text;

  v_member_ids  uuid[];   -- family_members.id (roster / participant_ids)
  v_member_uids uuid[];   -- family_members.user_id aligned to names (nullable)
  v_member_names text[];  -- family_members.display_name aligned
  v_account_uids uuid[];  -- non-null user_ids (member_ids for access logic)
  n_members     int;

  v_conv_ids    uuid[] := '{}';
  v_conv_kinds  text[] := '{}';
  v_cid         uuid;
  n_convs       int;

  -- themed (non-DM) conversation specs
  c_names   text[];
  c_emojis  text[] := ARRAY['👨‍👩‍👧‍👦','⚽','🏠','🏖️','🧸','📚','📢','📣','🏷️'];
  c_kinds   text[] := ARRAY['group','group','group','group','group','group','announcement','announcement','group'];
  c_arch    bool[] := ARRAY[false,false,false,false,false,false,false,false,true];
  c_desc    text[] := ARRAY[
    'Our family hub for all the important updates, plans, and memories.',
    'Coordinating rides, snacks, and game schedules for the season.',
    'Neighbors sharing local news, alerts, and the occasional garage sale.',
    'Planning our summer trip — flights, hotels, and the itinerary.',
    'Setting up playdates and weekend meetups for the kids.',
    'What we are reading this month and next.',
    'Official school announcements and reminders.',
    'Community notices for events and services.',
    'Archived: last year''s neighborhood garage sale planning.'
  ];

  -- message content pools
  t_texts text[] := ARRAY[
    'Good morning, family! ☀️ Here''s what''s on the agenda today.',
    'Don''t forget soccer practice tonight! ⚽',
    'Can I have a sleepover this weekend?',
    'Here''s the homework assignment 📄',
    'See you at pickup!',
    'We can''t wait for Sunday dinner!',
    'Game is at 10am on Saturday',
    'Booked! Excited! 🎉',
    'Don''t forget your dentist appointment',
    'Thanks for the help!',
    'Dinner at Grandma''s at 7pm — who''s driving?',
    'I''ll grab groceries on the way home 🛒',
    'Can someone pick up Mia from practice?',
    'Great job on the test today, so proud of you! 🌟',
    'Movie night Friday? Kids get to pick 🍿',
    'Running 10 minutes late, start without me.',
    'The plumber is coming tomorrow between 9 and 11.',
    'Who left the lights on in the garage again 😅',
    'Reminder: permission slip is due Friday.',
    'Love you all, have a great day! ❤️',
    'Let''s plan something fun for the long weekend.',
    'Field trip money needs to go in by Wednesday.',
    'I made your favorite lasagna 🍝',
    'Practice moved to 6pm this week.',
    'Can we do tacos for dinner? 🌮',
    'Just landed, see you soon! ✈️',
    'The recital was amazing, she nailed it! 👏',
    'Please put your laundry away before dinner.',
    'Grandpa says hi and sends his love.',
    'Weather looks great for the picnic tomorrow.'
  ];
  ann_texts text[] := ARRAY[
    'School closed Monday for a teacher in-service day.',
    'Picture day is next Thursday — dress nicely!',
    'Book fair runs all week in the library.',
    'Early dismissal at 1pm this Friday.',
    'Parent-teacher conferences open for sign-up now.',
    'Spirit week starts Monday — see the themes below.',
    'Bus route 12 will be 15 minutes late this week.',
    'Report cards go home this Friday.'
  ];

  -- reaction users pool (emoji -> [user])
  react_emojis text[] := ARRAY['👍','❤️','😂','🔥','😮','🎉'];

  i         int;
  sidx      int;
  cidx      int;
  v_conv    uuid;
  v_kind    text;
  v_convkind text;
  v_sender  uuid;
  v_sname   text;
  v_content text;
  v_att_url text;
  v_att_name text;
  v_att_mime text;
  v_read    uuid[];
  v_react   jsonb;
  v_when    timestamptz;
  seeded    int := 0;
begin
  select id into v_uid from auth.users where lower(email) = lower(v_email) limit 1;
  if v_uid is null then
    raise notice 'Seed skipped: no auth user for %', v_email;
    return;
  end if;
  if not exists (select 1 from public.families where id = v_fam) then
    raise notice 'Seed skipped: family % not found', v_fam;
    return;
  end if;

  select name into v_family_name from public.families where id = v_fam;
  select display_name into v_self_name from public.family_members
    where family_id = v_fam and user_id = v_uid and is_active limit 1;
  v_self_name := coalesce(v_self_name, 'You');

  -- Roster aligned arrays (parents first, then by created_at)
  select array_agg(id order by ord), array_agg(user_id order by ord), array_agg(display_name order by ord)
    into v_member_ids, v_member_uids, v_member_names
  from (
    select id, user_id, display_name,
           row_number() over (order by case when role = 'parent' then 0 else 1 end, created_at) ord
    from public.family_members where family_id = v_fam and is_active
  ) s;
  n_members := coalesce(array_length(v_member_names, 1), 0);
  if n_members = 0 then
    raise notice 'Seed skipped: family has no active members';
    return;
  end if;

  select array_agg(user_id) into v_account_uids
    from public.family_members where family_id = v_fam and is_active and user_id is not null;

  -- Wipe previously seeded messages (tagged), keeping the user's real data.
  delete from public.family_messages where family_id = v_fam and sender_avatar = 'seed:messages';

  -- Build themed conversation names (main group uses the family's real name).
  c_names := ARRAY[
    coalesce(v_family_name, 'Our Family'),
    'Soccer Team Parents','Neighborhood Group','Vacation 2025','Play Dates',
    'Book Club','School Announcements','Community Notices','Garage Sale 2024'
  ];

  -- Ensure themed conversations exist (create once, reuse thereafter).
  for i in 1 .. array_length(c_names, 1) loop
    select id into v_cid from public.family_conversations
      where family_id = v_fam and name = c_names[i] and created_by = v_uid limit 1;
    if v_cid is null then
      insert into public.family_conversations
        (family_id, name, kind, avatar_emoji, description, is_archived, member_ids, participant_ids, created_by)
      values (v_fam, c_names[i], c_kinds[i], c_emojis[i], c_desc[i], c_arch[i],
              coalesce(v_account_uids, '{}'), v_member_ids, v_uid)
      returning id into v_cid;
    else
      update public.family_conversations
        set kind = c_kinds[i], avatar_emoji = c_emojis[i], description = c_desc[i],
            is_archived = c_arch[i], participant_ids = v_member_ids,
            member_ids = coalesce(v_account_uids, '{}')
        where id = v_cid;
    end if;
    v_conv_ids := array_append(v_conv_ids, v_cid);
    v_conv_kinds := array_append(v_conv_kinds, c_kinds[i]);
  end loop;

  -- Ensure a direct-message conversation per other member.
  for i in 1 .. n_members loop
    if v_member_uids[i] is distinct from v_uid then
      select id into v_cid from public.family_conversations
        where family_id = v_fam and name = v_member_names[i] and kind = 'direct' and created_by = v_uid limit 1;
      if v_cid is null then
        insert into public.family_conversations
          (family_id, name, kind, avatar_emoji, is_archived, member_ids, participant_ids, created_by)
        values (v_fam, v_member_names[i], 'direct', null, false,
                array_remove(ARRAY[v_uid, v_member_uids[i]], null), array[v_member_ids[i]], v_uid)
        returning id into v_cid;
      end if;
      v_conv_ids := array_append(v_conv_ids, v_cid);
      v_conv_kinds := array_append(v_conv_kinds, 'direct');
    end if;
  end loop;

  n_convs := array_length(v_conv_ids, 1);

  -- 520 messages across the conversations, oldest → newest.
  for i in 1 .. 520 loop
    cidx := 1 + (i % n_convs);
    v_conv := v_conv_ids[cidx];
    v_convkind := v_conv_kinds[cidx];

    -- sender: ~1/3 from the signed-in user (so "You" bubbles appear on the right)
    if (i % 3) = 0 then
      v_sender := v_uid; v_sname := v_self_name;
    else
      sidx := 1 + (i % n_members);
      v_sender := v_member_uids[sidx]; v_sname := v_member_names[sidx];
    end if;

    -- kind mix
    if v_convkind = 'announcement' and (i % 2) = 0 then
      v_kind := 'announcement';
    elsif (i % 23) = 0 then
      v_kind := 'file';
    elsif (i % 11) = 0 then
      v_kind := 'image';
    else
      v_kind := 'text';
    end if;

    v_content := null; v_att_url := null; v_att_name := null; v_att_mime := null;
    if v_kind = 'image' then
      v_att_url  := format('https://picsum.photos/seed/msg%s/500/400', i);
      v_att_name := format('photo_%s.jpg', i);
      v_att_mime := 'image/jpeg';
    elsif v_kind = 'file' then
      v_att_url  := 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf';
      v_att_name := format('Document_%s.pdf', i);
      v_att_mime := 'application/pdf';
      v_content  := v_att_name;
    elsif v_kind = 'announcement' then
      v_content := ann_texts[1 + (i % array_length(ann_texts, 1))];
    else
      v_content := t_texts[1 + (i % array_length(t_texts, 1))];
    end if;

    -- read state: own messages are read; others are ~60% read, ~40% unread
    if v_sender = v_uid or (i % 5) < 3 then
      v_read := ARRAY[v_uid];
    else
      v_read := '{}';
    end if;

    -- reactions on ~1 of 6 messages
    if (i % 6) = 0 then
      v_react := jsonb_build_object(
        react_emojis[1 + (i % array_length(react_emojis, 1))],
        to_jsonb(ARRAY[v_uid])
      );
    else
      v_react := '{}'::jsonb;
    end if;

    -- timestamps: newest = today, spanning back ~12.6 days
    v_when := now() - ((520 - i) * interval '35 minutes');

    insert into public.family_messages
      (conversation_id, family_id, sender_id, sender_name, sender_avatar, content, kind,
       attachment_url, attachment_name, attachment_mime, reactions, read_by, is_pinned, created_at)
    values
      (v_conv, v_fam, v_sender, v_sname, 'seed:messages', v_content, v_kind,
       v_att_url, v_att_name, v_att_mime, v_react, v_read, (i % 60) = 0, v_when);

    seeded := seeded + 1;
  end loop;

  raise notice 'Seeded % messages across % conversations for %', seeded, n_convs, coalesce(v_family_name, v_fam::text);
end $$;
