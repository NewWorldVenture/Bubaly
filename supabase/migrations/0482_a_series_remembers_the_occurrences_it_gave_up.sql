-- ============================================================================
-- 0482_a_series_remembers_the_occurrences_it_gave_up.sql — a recurring event
-- can name the occurrences that no longer happen.
-- ----------------------------------------------------------------------------
-- `calendar_events` stores a series as one row: `recurrence` (daily, weekly,
-- monthly, yearly) and an optional `recurrence_until`. The expander
-- (lib/calendar/recurrence.ts) produces every occurrence between them. Nothing
-- could say "except this one".
--
-- Every calendar a family subscribes to has such exceptions. A practice moved
-- from Saturday to Sunday one week is, in iCalendar, a second VEVENT with the
-- master's UID and a RECURRENCE-ID naming the Saturday it replaces; a cancelled
-- week is an EXDATE on the master, or a RECURRENCE-ID VEVENT marked CANCELLED.
-- The feed import (lib/calendar/feeds.ts) now keeps the master and stores a
-- moved occurrence as its own event — but with nowhere to record what the
-- master gave up, the Saturday still rendered beside the Sunday, and a
-- cancelled week still rendered at all.
--
-- `exception_dates` holds those instants. The expander skips an occurrence
-- that falls on the same local day as one of them: a series has at most one
-- occurrence a day, and the day is stable where the instant can drift an hour
-- across a DST change when the series was published in another zone.
--
-- Written by the same code paths that write the row (the feed sync, under the
-- family's own RLS policies on calendar_events, which are unchanged). Read by
-- every expander caller through `select('*')` or an explicit column list.
--
-- DEPENDS ON: 0002 (the table), 0045 (the feed columns this sits beside).
-- Number reserved on #699 (comment 5971513705); filename and dependencies announced on #771.
--
-- ADDITIVE + IDEMPOTENT: `add column if not exists` with a default, so no
-- existing row is rewritten and no policy changes. Safe to re-run.
-- ============================================================================

alter table public.calendar_events
  add column if not exists exception_dates timestamptz[] not null default '{}';

comment on column public.calendar_events.exception_dates is
  'Instants of occurrences this series has given up (a moved or cancelled occurrence''s RECURRENCE-ID, or an EXDATE). The expander skips an occurrence on the same local day. Empty for a one-off.';
