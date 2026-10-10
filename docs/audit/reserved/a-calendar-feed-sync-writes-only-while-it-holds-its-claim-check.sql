-- A calendar feed sync writes only while it holds its claim: 0490's function, measured. (#908)
--
-- RESERVED, HELD with its migration (supabase/reserved/0490_...): this probe is
-- in docs/audit/reserved/ so run-probes.sh (docs/audit/*-check.sql) does not run
-- it against a schema that lacks the function. It moves to docs/audit/ when the
-- migration moves into supabase/migrations/.
--
-- One sync of a feed runs at a time; `calendar_feeds.last_status = 'syncing'`
-- is the claim and the claim's `updated_at` is the fence every write of that
-- sync carries. 0490's `calendar_feed_apply_sync(feed, fence, upserts, removals)`
-- puts the fence check and the write in one transaction. Asserted here, on the
-- fully replayed schema:
--
--   1  the function exists, SECURITY INVOKER, with that signature          -> asserted
--   2  under the live fence a chunk lands: the upsert inserts a new row and
--      updates an existing one in place on (feed_id, external_uid), the
--      removals delete this feed's named rows and nothing else, `applied`   -> asserted
--   3  after a takeover (the claim re-stamped, as claimFeed's stale takeover
--      does) the same chunk under the OLD fence answers `lost` and changes
--      no row: no upsert, no removal                                        -> asserted
--   4  a fence under a released claim (`ok`) is `lost` too                  -> asserted
--   5  a row of another feed with the same external_uid is untouched by
--      the removals (scope is the feed, not the key)                        -> asserted
--   6  a chunk naming a column the table lacks is refused (42703), not
--      silently dropped                                                     -> asserted
--   7  AS AN AUTHENTICATED MEMBER OF TWO FAMILIES (set local role, the
--      member's claim): a chunk for family A's feed whose row is labelled
--      family B is refused (42501) and B gains no row — the caller's RLS
--      would have admitted it (review 5981467749 on #908)                 -> asserted
--   8  the same member's row that names no family lands under the feed's
--      family, which the function takes from the locked feed row          -> asserted
--
-- Not shown here: the row lock serializing an in-flight chunk against a
-- concurrent takeover. That needs two sessions; the unit test drives the same
-- function's semantics through the in-memory fake.
--
-- Synthetic household; rolled back, nothing outlives the assertion.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

do $probe$
declare
  fam      uuid := 'a4900000-0000-4000-8000-0000000000f1';
  mom      uuid := 'a4900000-0000-4000-8000-000000000001';
  feed     uuid := 'a4900000-0000-4000-8000-000000000011';
  other    uuid := 'a4900000-0000-4000-8000-000000000012';
  fence    timestamptz := '2026-10-04T12:00:00.123456+00:00';
  famb     uuid := 'a4900000-0000-4000-8000-0000000000f2';
  dad      uuid := 'a4900000-0000-4000-8000-000000000002';
  feedb    uuid := 'a4900000-0000-4000-8000-000000000013';
  answer   text;
  n        int;
  title_now text;
  state    text;
  rows     jsonb := jsonb_build_array(
    jsonb_build_object('family_id', fam, 'title', 'Practice', 'starts_at', '2026-10-10T17:00:00Z', 'all_day', false, 'recurrence', 'weekly', 'category', 'general', 'external_uid', 'series'),
    jsonb_build_object('family_id', fam, 'title', 'Autumn concert (moved)', 'starts_at', '2026-10-12T19:00:00Z', 'all_day', false, 'recurrence', 'none', 'category', 'general', 'external_uid', 'concert'));
begin
  -- 1. the function, as 0490 describes it.
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'calendar_feed_apply_sync'
                    and pg_get_function_identity_arguments(p.oid) = 'p_feed_id uuid, p_fence timestamp with time zone, p_upserts jsonb, p_removals text[]') then
    raise exception '0490 FAIL: calendar_feed_apply_sync(uuid, timestamptz, jsonb, text[]) does not exist';
  end if;
  if (select prosecdef from pg_proc where oid = 'public.calendar_feed_apply_sync(uuid, timestamptz, jsonb, text[])'::regprocedure) then
    raise exception '0490 FAIL: calendar_feed_apply_sync is security definer; it must run as the caller';
  end if;

  -- The household: a family, two feeds, a stored concert on each, a stored cancelled exception on ours.
  insert into auth.users (id, email) values (mom, 'fence-mom@example.test') on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Fence', mom) on conflict (id) do nothing;
  insert into public.calendar_feeds (id, family_id, name, url, last_status, updated_at) values
    (feed,  fam, 'Team',  'https://example.test/team.ics',  'syncing', fence),
    (other, fam, 'Other', 'https://example.test/other.ics', 'ok',      fence);
  insert into public.calendar_events (family_id, feed_id, external_uid, title, starts_at) values
    (fam, feed,  'concert', 'Autumn concert', '2026-10-12T18:00:00Z'),
    (fam, feed,  'gone',    'Cancelled exception', '2026-10-11T18:00:00Z'),
    (fam, other, 'gone',    'Same key, other feed', '2026-10-11T18:00:00Z');

  -- 2. the live fence: the chunk lands.
  select public.calendar_feed_apply_sync(feed, fence, rows, array['gone']) into answer;
  if answer <> 'applied' then
    raise exception '0490 FAIL: a chunk under the live fence answered %, expected applied', answer;
  end if;
  select count(*) into n from public.calendar_events where feed_id = feed;
  if n <> 2 then
    raise exception '0490 FAIL: expected 2 rows for the feed after the chunk (series upserted, concert updated, gone removed), found %', n;
  end if;
  select title into title_now from public.calendar_events where feed_id = feed and external_uid = 'concert';
  if title_now <> 'Autumn concert (moved)' then
    raise exception '0490 FAIL: the existing concert row was not updated in place (title is %)', title_now;
  end if;
  if not exists (select 1 from public.calendar_events where feed_id = feed and external_uid = 'series' and recurrence = 'weekly') then
    raise exception '0490 FAIL: the new series row did not land with its recurrence';
  end if;
  -- 5. the other feed's row under the same key is untouched.
  if not exists (select 1 from public.calendar_events where feed_id = other and external_uid = 'gone') then
    raise exception '0490 FAIL: a removal reached another feed''s row with the same key';
  end if;

  -- 3. a takeover: the claim is re-stamped (the table's updated_at trigger moves
  --    the stamp on any update, as claimFeed's takeover does); the old fence
  --    writes nothing.
  update public.calendar_feeds set last_status = 'syncing' where id = feed;
  if (select updated_at from public.calendar_feeds where id = feed) = fence then
    raise exception '0490 FAIL (fixture): the takeover did not move the stamp';
  end if;
  select public.calendar_feed_apply_sync(feed, fence,
    jsonb_build_array(jsonb_build_object('family_id', fam, 'title', 'STALE', 'starts_at', '2026-10-12T19:00:00Z', 'all_day', false, 'recurrence', 'none', 'category', 'general', 'external_uid', 'concert')),
    array['series']) into answer;
  if answer <> 'lost' then
    raise exception '0490 FAIL: a chunk under a taken-over fence answered %, expected lost', answer;
  end if;
  if exists (select 1 from public.calendar_events where feed_id = feed and title = 'STALE') then
    raise exception '0490 FAIL: a stale upsert landed after the takeover';
  end if;
  if not exists (select 1 from public.calendar_events where feed_id = feed and external_uid = 'series') then
    raise exception '0490 FAIL: a stale removal landed after the takeover';
  end if;

  -- 4. a released claim is nobody's.
  update public.calendar_feeds set last_status = 'ok', updated_at = fence where id = feed;
  select public.calendar_feed_apply_sync(feed, fence, rows, array[]::text[]) into answer;
  if answer <> 'lost' then
    raise exception '0490 FAIL: a chunk under a released claim answered %, expected lost', answer;
  end if;

  -- 6. an unknown column is refused, not dropped. (The table's trigger stamps
  --    updated_at on every update, as claimFeed relies on; the fence is what the
  --    row holds after the claim, exactly as the code reads it back.)
  update public.calendar_feeds set last_status = 'syncing' where id = feed returning updated_at into fence;
  begin
    perform public.calendar_feed_apply_sync(feed, fence,
      jsonb_build_array(jsonb_build_object('family_id', fam, 'title', 'X', 'starts_at', '2026-10-12T19:00:00Z', 'external_uid', 'x', 'no_such_column', 1)),
      array[]::text[]);
    raise exception '0490 FAIL: a row naming a column the table lacks was accepted';
  exception when undefined_column then
    null; -- 42703, as the header says
  end;

  -- 7. a member of two families cannot label feed A's rows for family B.
  --    Mom is in A (she created it) and, from here, in B too. Under her own
  --    role and claim the function runs with HER RLS: A's feed is hers to lock,
  --    B's events are hers to insert — and the function must still refuse.
  insert into auth.users (id, email) values (dad, 'fence-dad@example.test') on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (famb, 'Fence B', dad) on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (famb, mom, 'Mom (also here)', 'parent', true);
  insert into public.calendar_feeds (id, family_id, name, url, last_status, updated_at) values
    (feedb, famb, 'B team', 'https://example.test/b.ics', 'ok', fence);
  update public.calendar_feeds set last_status = 'syncing' where id = feed returning updated_at into fence;
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.sub', mom::text, true);
  begin
    perform public.calendar_feed_apply_sync(feed, fence,
      jsonb_build_array(jsonb_build_object('family_id', famb, 'title', 'Smuggled', 'starts_at', '2026-10-14T19:00:00Z', 'all_day', false, 'recurrence', 'none', 'category', 'general', 'external_uid', 'smuggled')),
      array[]::text[]);
    raise exception '0490 FAIL: a row labelled for family B was written through family A''s feed';
  exception when insufficient_privilege then
    null; -- 42501, as the header says
  end;
  -- 8. a row that names no family takes the feed's.
  select public.calendar_feed_apply_sync(feed, fence,
    jsonb_build_array(jsonb_build_object('title', 'Unlabelled', 'starts_at', '2026-10-15T19:00:00Z', 'all_day', false, 'recurrence', 'none', 'category', 'general', 'external_uid', 'unlabelled')),
    array[]::text[]) into answer;
  if answer <> 'applied' then
    raise exception '0490 FAIL: a member''s own chunk under the live fence answered %, expected applied', answer;
  end if;
  execute 'reset role';
  if exists (select 1 from public.calendar_events where family_id = famb) then
    raise exception '0490 FAIL: family B gained a row from family A''s feed';
  end if;
  if not exists (select 1 from public.calendar_events where feed_id = feed and external_uid = 'unlabelled' and family_id = fam) then
    raise exception '0490 FAIL: a row that named no family did not land under the feed''s family';
  end if;

  raise notice '0490 OK: a chunk is written under the live fence only; a taken-over or released claim writes nothing; removals stay in their feed; an unknown column is refused; every row is the feed''s family''s, whoever calls.';
end $probe$;

rollback;
