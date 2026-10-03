-- ============================================================================
-- 0483_a_mirrored_series_remembers_the_occurrences_its_source_gave_up.sql — a
-- series mirrored from a provider can name the occurrences that no longer
-- happen.
-- ----------------------------------------------------------------------------
-- `sync_calendar_events` (0018) mirrors a connected provider's calendar one row
-- per event, with `recurrence_rule` for a series and `recurrence_id` for a
-- single changed occurrence. Google's events list runs with
-- `singleEvents=false`: a series arrives as ONE master whose `recurrence` holds
-- the RRULE and any EXDATE lines, plus one event per occurrence the family
-- changed or cancelled, naming its master (`recurringEventId`) and the slot it
-- left (`originalStartTime`). The mapper kept only the RRULE, and the engine had
-- nowhere to put the rest. So the mirror — and the public feed at
-- /api/sync/feeds/[token] that every subscribed phone reads from it — expanded
-- the series over the piano lesson the family moved and over the one they
-- cancelled.
--
-- `exception_dates` holds those instants on the master row: its own EXDATE
-- lines, and the original slot of every exception the engine has seen, folded
-- in after each pull so an exception that arrives alone on an incremental pull
-- still reaches its master. The feed emits them as EXDATE; a changed occurrence
-- keeps its own row with `recurrence_id`, emitted as RECURRENCE-ID.
--
-- Written by the sync engines (lib/sync/engine/google.ts, generic.ts, through
-- lib/sync/engine/exceptions.ts) with the service role, as every column of this
-- table is. Read by the feed route. RLS on the table is unchanged.
--
-- DEPENDS ON: 0018 (the table). Nothing in 0475–0482 is referenced. Number
-- reserved on #699 (comment 5971963705); filename and dependencies announced
-- on #771 (comment 5972062091).
--
-- ADDITIVE + IDEMPOTENT: `add column if not exists` with a default, so no
-- existing row is rewritten and no policy changes. Safe to re-run.
-- ============================================================================

alter table public.sync_calendar_events
  add column if not exists exception_dates timestamptz[] not null default '{}';

comment on column public.sync_calendar_events.exception_dates is
  'Instants of occurrences this mirrored series has given up: the source''s EXDATE lines plus the original slot of every changed or cancelled occurrence the sync has seen. Emitted as EXDATE by the feed. Empty for a one-off.';
