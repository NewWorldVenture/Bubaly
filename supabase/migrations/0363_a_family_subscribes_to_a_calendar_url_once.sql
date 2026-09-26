-- ============================================================
-- Migration 0363: a family subscribes to a calendar URL once
--
-- WHY. 0045 created public.calendar_feeds with `url text NOT NULL` and no
-- uniqueness on it — its only index is the non-unique idx_calendar_feeds_family.
-- addCalendarFeed (app/(app)/dashboard/sync/feeds/actions.ts) inserted the row,
-- committed it, and only then tried the first sync; when that sync failed (a
-- school calendar behind a login, a timeout, a file over 1 MiB) it returned the
-- error and left the row, and the panel kept the form open with the URL still
-- typed in. The next press of "Add & Sync Now" inserted a second row for the
-- same URL, the next a third. Once the URL answered, each of those rows
-- imported the same events under its own feed_id — uq_calendar_events_feed_uid
-- (0285) is keyed on (feed_id, external_uid), so nothing collapsed them and
-- every school event sat on the family calendar two or three times.
--
-- The action now looks for the family's existing row for the URL first and
-- re-syncs it, and removes a row it created whose first sync failed. A look is
-- only a look: two members adding the same calendar at the same moment both
-- look, both find nothing, both insert. Only the database closes that window.
-- With this index the loser of the race gets 23505, which addCalendarFeed
-- catches, re-reads, and syncs the winner's row. The sibling subscription
-- tables already carry exactly this: weekend_feeds UNIQUE (family_id, url)
-- (0072) and uq_library_feed_per_family (0284).
--
-- WHY NOT PARTIAL. family_id and url are both NOT NULL (0045), so a partial
-- predicate would exclude nothing, and 0285 made it the rule here that a
-- conflict target stays inferable.
--
-- URL LENGTH. A btree entry over ~2.7 KB is refused (54000), and url is
-- unbounded text. addCalendarFeed refuses a normalized URL over 2048
-- characters (ASCII, so 2048 bytes) with its own message before it reaches
-- this index. An existing row whose url is already over the btree limit would
-- stop the index build here with Postgres's own error; no real calendar link
-- is that long.
--
-- EXISTING DUPLICATES. A family that already carries two rows for one URL (the
-- defect above, before the code fix landed) would make `create unique index`
-- fail with Postgres's terse "could not create unique index" and no hint whose
-- calendar it is. Say which rows block it, with each row's status and how many
-- events hang off it, and stop. Collapsing them is a data decision and not this
-- migration's to make: every duplicate row owns its own copy of the imported
-- events (calendar_events.feed_id ... ON DELETE CASCADE, 0045), and a member
-- may have edited, or linked something to, the copy that would be deleted.
--
-- Replay-safe: `create unique index if not exists`, and the guard passes on a
-- replay because the index it precedes forbids the rows it looks for. Nothing
-- here grants, revokes, deletes rows, or touches a policy.
--
-- NOT APPLIED. Recorded for the owner to apply.
-- ============================================================

do $$
declare
  blockers text;
  n_groups int;
begin
  select count(*), string_agg(
           format('family_id=%s url=%L: %s rows: %s', family_id, url, n, rows_detail),
           E'\n    ' order by family_id, url)
    into n_groups, blockers
  from (
    select f.family_id,
           f.url,
           count(*) as n,
           string_agg(
             format('%s (last_status=%s, last_synced_at=%s, events=%s)',
                    f.id, f.last_status, coalesce(f.last_synced_at::text, 'never'),
                    (select count(*) from public.calendar_events e where e.feed_id = f.id)),
             '; ' order by f.created_at, f.id) as rows_detail
      from public.calendar_feeds f
     group by f.family_id, f.url
    having count(*) > 1
  ) d;

  if n_groups > 0 then
    raise exception
      'calendar_feeds already holds % duplicated calendar subscription(s); resolve them before applying 0363:%    %',
      n_groups, E'\n', blockers
      using hint = 'Keep one row per group (normally the one with last_status = ''ok'' and the most events) and delete the others; their imported events go with them and the kept row re-imports on its next sync. Rows that were never synced (last_synced_at = never, events = 0) are the abandoned first attempts this migration exists to stop. Then re-run this migration.';
  end if;
end $$;

create unique index if not exists uq_calendar_feeds_family_url
  on public.calendar_feeds (family_id, url);

comment on index public.uq_calendar_feeds_family_url is
  'One subscription per calendar URL per family. addCalendarFeed re-syncs the existing row instead of adding another, and treats a 23505 here as a concurrent add that already created it.';

-- ============================================================
-- Done! A second "Add & Sync Now" for a URL the family already subscribes to
-- re-syncs that subscription; a concurrent one loses with 23505 and does the same.
-- ============================================================
