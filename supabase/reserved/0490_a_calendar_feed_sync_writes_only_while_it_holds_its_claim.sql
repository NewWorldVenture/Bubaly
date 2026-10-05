-- Bubaly :: 0490 a calendar feed sync writes only while it holds its claim
-- ----------------------------------------------------------------------------
-- RESERVED, HELD. 0490 is this function's number, but it is not in
-- supabase/migrations/ yet: `supabase db push` applies in version order and
-- the migration audit (scripts/audit-migration-versions.mjs) refuses a skipped
-- number, so it is held here in supabase/reserved/ (see README.md beside it)
-- and moves into supabase/migrations/ under 0490 once every number below it,
-- 0475-0489, has landed. Its probe is held beside it in docs/audit/reserved/
-- (run-probes.sh globs docs/audit/*-check.sql only) and moves back with it.
-- The code does not need it: lib/server/calendar-feeds.ts answers PGRST202 /
-- 42883 by logging once and taking the check-then-write path.
-- ----------------------------------------------------------------------------
-- One sync of a calendar feed runs at a time: `calendar_feeds.last_status` is
-- the claim (`syncing`, taken by a compare-and-set on the one row), a claim
-- older than ten minutes is a sync that died and is taken over, and the claim's
-- own `updated_at` is the FENCE every later write of that sync compares against
-- (lib/server/calendar-feeds.ts, #908). The code checked the fence before every
-- write chunk and stamped its result by compare-and-set — but a check and a
-- write are two PostgREST statements, so a sync that paused between them could
-- still land one stale chunk after a takeover: upserts of an older snapshot
-- over the new holder's rows, or removals the new holder had just restored.
-- (Review of 2026-10-04 11:34 UTC on #908.)
--
-- This function puts the check and the write in ONE transaction. It locks the
-- feed row FOR UPDATE, requires the claim to be this sync's (`syncing`, stamped
-- at exactly p_fence), and only then upserts the chunk and deletes the
-- removals; otherwise it writes nothing and answers `lost`. The row lock is what
-- serializes it against `claimFeed`'s takeover: a takeover that arrives while a
-- chunk is being applied waits for the chunk to commit, then moves the stamp,
-- and the next chunk of the sync that lost finds its fence gone.
--
-- SECURITY INVOKER, deliberately. `syncFeed` runs with the member's own client
-- from the settings action and with the service client from the cron; the same
-- row-level security that governs those clients' direct writes to
-- `calendar_feeds` and `calendar_events` governs this function's. A member who
-- may not update a feed cannot hold its claim (the SELECT ... FOR UPDATE sees
-- no row) and so cannot write through here either. Nothing is widened.
--
-- The upsert carries whatever columns the rows carry — the planner's row shape
-- (lib/calendar/feeds.ts mapIcsEventToRow) and any column a later unit adds to
-- it — resolved against the table's own columns, so an unknown key fails loudly
-- (42703) rather than silently dropping a value. The conflict target is 0285's
-- unique index on (feed_id, external_uid). Removals are scoped to this feed's
-- rows and to the exact keys named, as the direct path was.
--
-- What it does not change, stated: an imported series is stepped on the
-- FAMILY's clock, not its publisher's. The rows this function upserts carry a
-- series' first instant (its DTSTART read in its TZID, lib/sync/ics.ts) and its
-- frequency; no column carries the source TZID, so every later occurrence is
-- expanded on the family's wall clock (lib/calendar/recurrence.ts,
-- lib/calendar/feeds.ts mapIcsEventToRow). A series published in another zone
-- is an hour off its publisher's between the two zones' DST changes. Carrying
-- the source zone is a column of its own, not part of this function.
--
-- A database without this function answers PGRST202 to the RPC; the code then
-- takes the check-then-write path it took before, with one warning naming this
-- file. A deploy may precede its migration; nothing breaks, the window simply
-- stays open until the function is there.
--
-- THE FAMILY IS THE FEED'S. The function runs as its caller, and the caller's
-- RLS admits a calendar_events row for any family the caller belongs to. That
-- is one check too few: an account in two households could sync feed A with a
-- row labelled family B, and B's other members would see an event from A's
-- feed (review 5981467749 on #908). So the family is read from the locked feed
-- row and written on every row of the chunk; a row that names another family
-- is refused with 42501 before anything is written, and a row that names none
-- takes the feed's.
--
-- Verified on a replayed database: a chunk under the live fence lands (upserts
-- and removals), the same chunk under a moved fence answers `lost` and changes
-- no row, an authenticated member of two families cannot label a row for the
-- other one, and the lock ordering above holds under two sessions
-- (docs/audit/a-calendar-feed-sync-writes-only-while-it-holds-its-claim-check.sql).

create or replace function public.calendar_feed_apply_sync(
  p_feed_id   uuid,
  p_fence     timestamptz,
  p_upserts   jsonb,
  p_removals  text[]
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_columns text;
  v_updates text;
  v_family  uuid;
begin
  -- The claim, locked: this sync's and nobody else's, or nothing is written.
  -- The feed's family comes out of the same locked row: it is the only family
  -- any row of this chunk may belong to.
  select family_id into v_family from public.calendar_feeds
    where id = p_feed_id and last_status = 'syncing' and updated_at = p_fence
    for update;
  if not found then
    return 'lost';
  end if;

  if p_upserts is not null and jsonb_typeof(p_upserts) = 'array' and jsonb_array_length(p_upserts) > 0 then
    -- A row's family is the feed's, full stop. The caller's own RLS admits a
    -- row for any family the caller belongs to, which is not the same thing:
    -- an account in two households could label feed A's rows for family B and
    -- show B's members an event from A's feed. A row that names another family
    -- is refused as a privilege error; a row that names none takes the feed's.
    if exists (select 1 from jsonb_array_elements(p_upserts) e
                where e ? 'family_id' and nullif(e->>'family_id', '')::uuid is distinct from v_family) then
      raise exception 'calendar_feed_apply_sync: a row names a family other than the feed''s' using errcode = '42501';
    end if;
    -- The columns the rows carry, as table columns (an unknown key raises 42703);
    -- the identity columns and the family are written from the locked feed.
    select string_agg(format('%I', k), ', ' order by k),
           string_agg(format('%I = excluded.%I', k, k), ', ' order by k)
      into v_columns, v_updates
      from (select distinct jsonb_object_keys(e) as k
              from jsonb_array_elements(p_upserts) e) keys
     where k not in ('id', 'feed_id', 'family_id', 'external_uid', 'created_at');
    if v_columns is null then
      raise exception 'calendar_feed_apply_sync: rows carry no columns to write' using errcode = '22023';
    end if;
    execute format(
      'insert into public.calendar_events (feed_id, family_id, external_uid, %1$s)
         select %2$L::uuid, %5$L::uuid, r.external_uid, %3$s
           from jsonb_populate_recordset(null::public.calendar_events, $1) r
       on conflict (feed_id, external_uid) do update set %4$s',
      v_columns, p_feed_id,
      (select string_agg(format('r.%I', k), ', ' order by k)
         from (select distinct jsonb_object_keys(e) as k from jsonb_array_elements(p_upserts) e) keys
        where k not in ('id', 'feed_id', 'family_id', 'external_uid', 'created_at')),
      v_updates, v_family)
    using p_upserts;
  end if;

  if p_removals is not null and cardinality(p_removals) > 0 then
    delete from public.calendar_events
     where feed_id = p_feed_id and external_uid = any(p_removals);
  end if;

  return 'applied';
end
$$;

comment on function public.calendar_feed_apply_sync(uuid, timestamptz, jsonb, text[]) is
  'One chunk of a calendar feed sync, written only while the caller holds the feed''s claim (last_status = syncing, updated_at = p_fence): locks the feed row, upserts the rows on (feed_id, external_uid) with the feed''s own family_id (a row naming another family is refused, 42501), deletes the named keys of this feed, answers applied; or writes nothing and answers lost. Security invoker: the caller''s own RLS governs it.';

do $$
begin
  if (select prosecdef from pg_proc where oid = 'public.calendar_feed_apply_sync(uuid, timestamptz, jsonb, text[])'::regprocedure) then
    raise exception '0490 FAILED: calendar_feed_apply_sync must be security invoker';
  end if;
  raise notice '0490 OK: calendar_feed_apply_sync writes a chunk only under the live claim.';
end $$;
