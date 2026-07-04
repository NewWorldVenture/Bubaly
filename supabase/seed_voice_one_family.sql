-- ============================================================================
-- seed_voice_one_family.sql — 500 rows in public.voice_commands (migration 0121)
-- for ONE family, so the Voice Control command center (/dashboard/voice) shows a
-- full "recent commands" history with one-tap re-run + delete.
-- ----------------------------------------------------------------------------
-- WHAT IT DOES
--   1. Re-asserts family-scoped RLS on voice_commands (drift-safe, idempotent).
--   2. Seeds 500 spoken-command log rows with a realistic spread of:
--        • transcript    — natural phrasings ("Remind me to…", "Add … to the
--                           shopping list", "Note that…", "Schedule … Saturday")
--        • resolved_kind — task / note / event / shopping (and null on failures)
--        • action_table  — the table each command wrote (todo_items, notes,
--                           calendar_events, grocery_items) + action_count
--        • status        — mostly routed, some failed / dismissed
--        • member        — attributed to a family member (round-robin)
--        • created_at    — spanning ~90 days incl. a cluster today.
--
-- TABLE: public.voice_commands.   ROW COUNT: 500.
--
-- TARGET FAMILY: 92298eb2-1a9e-4bdc-9361-677b6c01b499 (active family of
--   newworldventurellc@gmail.com). Change v_fam / v_email below if needed.
--   Requires migration 0121_voice_commands.sql applied first.
--
-- IDEMPOTENT: voice_commands has no tag column, so seeded rows use DETERMINISTIC
--   ids — (md5('voiceseed'||i))::uuid — which are deleted before re-insert. Real
--   commands have random uuids, so re-running only ever replaces the 500 seed
--   rows and never touches genuine history.
--
-- HOW TO RUN (local):
--   npm run db:seed:voice
--     -- or --
--   psql "$SUPABASE_DB_URL" -f supabase/seed_voice_one_family.sql
--   (also runnable by pasting into the Supabase SQL editor and pressing Run)
--
-- VERIFY: open /dashboard/voice and hard-refresh — the "recent commands" list
--   fills with 500 entries (mixed kinds + statuses); each row re-runs or deletes.
-- ============================================================================

-- 1) RLS repair so the app can READ the seeded rows ---------------------------
do $$
declare t text;
begin
  foreach t in array array['voice_commands'] loop
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

-- 2) Seed 500 voice_commands --------------------------------------------------
do $$
declare
  v_fam    uuid := '92298eb2-1a9e-4bdc-9361-677b6c01b499';
  v_email  text := 'newworldventurellc@gmail.com';
  v_uid    uuid;
  v_members uuid[];
  v_member uuid;
  i        int;
  nm       int;

  -- 5 templates: task / shopping / note / event / (failed) — index t = 1..5
  d_task  text[] := array['Remind me to take out the trash tonight','Remind me to sign Leo''s permission slip','Remind me to call the dentist tomorrow','Remind me to water the plants','Remind me to pay the electric bill Friday','Remind me to return the library books'];
  d_shop  text[] := array['Add milk and eggs to the shopping list','Add paper towels to the shopping list','Add bananas, apples and yogurt to the list','Put dish soap on the shopping list','Add coffee and oat milk to the list'];
  d_note  text[] := array['Note that Mia''s teacher is Mrs. Patel','Note the wifi password is on the fridge','Note that the plumber comes Thursday','Note Leo prefers the blue water bottle','Note the garage code is 4417'];
  d_event text[] := array['Schedule soccer practice Saturday at 9am','Schedule a dentist appointment next Tuesday at 3pm','Add movie night Friday at 7pm','Schedule the parent-teacher conference Monday morning','Put swim lessons on Sunday at 10am'];
  d_fail  text[] := array['Um, what was I going to say','Play something on the living room speaker','Turn on the porch light','Order more of that thing from last week'];

  v_transcript text;
  v_kind   text;
  v_table  text;
  v_count  int;
  v_status text;
  v_when   timestamptz;
  t        int;
begin
  select id into v_uid from auth.users where lower(email) = lower(v_email) limit 1;
  select array_agg(id order by id) into v_members
    from public.family_members where family_id = v_fam and is_active;
  if v_members is null or array_length(v_members, 1) is null then
    raise notice 'No members for family %, aborting.', v_fam;
    return;
  end if;
  nm := array_length(v_members, 1);

  -- clear prior seed rows only (deterministic ids), never real history
  delete from public.voice_commands
  where family_id = v_fam
    and id in (select (md5('voiceseed' || g))::uuid from generate_series(0, 499) g);

  for i in 0..499 loop
    t := 1 + (i % 5);
    v_member := v_members[1 + (i % nm)];

    if t = 1 then
      v_transcript := d_task[1 + (i % array_length(d_task, 1))];
      v_kind := 'task';     v_table := 'todo_items';       v_count := 1;
    elsif t = 2 then
      v_transcript := d_shop[1 + (i % array_length(d_shop, 1))];
      v_kind := 'shopping'; v_table := 'grocery_items';    v_count := 1 + (i % 3);
    elsif t = 3 then
      v_transcript := d_note[1 + (i % array_length(d_note, 1))];
      v_kind := 'note';     v_table := 'notes';            v_count := 1;
    elsif t = 4 then
      v_transcript := d_event[1 + (i % array_length(d_event, 1))];
      v_kind := 'event';    v_table := 'calendar_events';  v_count := 1;
    else
      -- unroutable / failed command: no kind, no rows created
      v_transcript := d_fail[1 + (i % array_length(d_fail, 1))];
      v_kind := null;       v_table := null;               v_count := 0;
    end if;

    -- status: failures fail; a few routed commands were later dismissed
    v_status := case
      when t = 5           then 'failed'
      when i % 19 = 0      then 'dismissed'
      else 'routed'
    end;
    if v_status <> 'routed' then v_count := 0; end if;

    v_when := now() - ((i % 90) || ' days')::interval - ((i % 24) || ' hours')::interval - ((i % 60) || ' minutes')::interval;

    insert into public.voice_commands
      (id, family_id, member_id, transcript, resolved_kind, action_table, action_count, status, created_by, created_at)
    values
      ((md5('voiceseed' || i))::uuid, v_fam, v_member, v_transcript, v_kind, v_table, v_count, v_status, v_uid, v_when);
  end loop;
end $$;

-- 3) VERIFY -------------------------------------------------------------------
select
  count(*)                                              as seeded_rows,
  count(*) filter (where status = 'routed')            as routed,
  count(*) filter (where status = 'failed')            as failed,
  count(*) filter (where status = 'dismissed')         as dismissed,
  count(distinct resolved_kind)                        as kinds,
  count(distinct member_id)                            as members,
  to_char(min(created_at), 'YYYY-MM-DD')               as oldest,
  to_char(max(created_at), 'YYYY-MM-DD')               as newest
from public.voice_commands
where family_id = '92298eb2-1a9e-4bdc-9361-677b6c01b499'
  and id in (select (md5('voiceseed' || g))::uuid from generate_series(0, 499) g);
