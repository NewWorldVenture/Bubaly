-- Bubaly :: 0360 - a head-out reminder goes with its departure plan
--            (deleting the event a plan was for no longer strands its
--             "🚗 Head out for …" reminder on the family calendar)
--
-- ── The defect ──────────────────────────────────────────────────────────────
--
-- 00981_trip_intelligence.sql gave departure_plans two links into
-- calendar_events, with opposite referential actions:
--
--   event_id           UUID REFERENCES calendar_events(id) ON DELETE CASCADE
--   reminder_event_id  UUID REFERENCES calendar_events(id) ON DELETE SET NULL
--
-- event_id is the family's own event (the soccer game). reminder_event_id is
-- the "🚗 Head out for Soccer game" event Trip Intelligence writes at the
-- computed leave-by (app/(app)/dashboard/trip-intel/actions.ts,
-- upsertHeadOutEvent). Both links run plan → event; nothing runs back.
--
-- So when the game is cancelled and someone deletes it — the calendar's Delete
-- button, the bulk delete, the assistant's calendar.deleteEvent tool, all of
-- them a bare DELETE through lib/services/calendar — Postgres cascades the
-- PLAN away and leaves the head-out event exactly where it was: on every
-- member's calendar, and read by the daily notifications run
-- (lib/server/notifications.ts takes every calendar_events row starting in the
-- next 48 hours) into a push and an email for a trip that no longer exists.
-- The Trip Intel card went with the plan, so no refresh can move the reminder
-- and no Remove button can take it off. The one place that deletes a head-out
-- event, deleteDeparturePlanAction, reads reminder_event_id off the plan row —
-- the row the cascade has already destroyed — and is not on this path at all.
--
-- ── The rule ────────────────────────────────────────────────────────────────
--
-- When a departure_plans row is deleted, by ANY path, its head-out event is
-- deleted with it:
--
--   after delete on public.departure_plans, for each row:
--     delete from public.calendar_events
--      where id = old.reminder_event_id and family_id = old.family_id
--
-- It is the cleanup deleteDeparturePlanAction already performs, moved to the
-- one place every path passes through: the cascade from the source event, the
-- plan's own Remove button (where the action has deleted the event first, so
-- this finds nothing and deletes nothing), and any writer added later.
--
-- A plan that is deleted this way is gone with its event; nothing else about
-- either table changes. Deleting the HEAD-OUT event by hand still leaves the
-- plan (reminder_event_id's SET NULL is untouched), and the next refresh writes
-- a fresh one, as before.
--
-- ── Why it cannot delete anything it should not ─────────────────────────────
--
--   * SECURITY INVOKER (the default, written out so no one flips it by habit).
--     For an authenticated caller the delete stays subject to calendar_events'
--     own RLS — 01050's calendar_events_delete, is_family_member(family_id) —
--     so it removes nothing the deleting member could not remove by hand.
--     That holds on the cascade path too. The cascade's own DELETE of the plan
--     runs as the table owner, but the AFTER trigger it queues fires once that
--     query has returned, as the member whose statement started it — measured
--     on the replayed schema: `current_user = authenticated`, row_security on.
--     A member who may delete the game passes the same is_family_member test
--     for the game's reminder, so RLS does not stand in the cleanup's way.
--   * `family_id = old.family_id`. Foreign-key checks do not consult RLS, so a
--     hand-written plan could put another household's event id in
--     reminder_event_id. This term keeps the delete inside the plan's own
--     family where RLS does not apply at all (the service role, the owner).
--   * Every foreign key that points AT calendar_events is ON DELETE CASCADE or
--     ON DELETE SET NULL (rides, event_rsvps, family wallet, relationship
--     dates, trip_plans, departure_plans, marketplace handoffs), so this delete
--     cannot be refused by a RESTRICT and make deleting the source event fail.
--
-- Existing orphans are NOT swept. Telling a stranded head-out event from one a
-- person typed with the same title would mean deleting family data on a guess;
-- a family removes those by hand, as today.
--
-- The outcome, not just this file's shape, is proved against the replayed
-- schema by docs/audit/a-head-out-reminder-goes-with-its-departure-plan-check.sql
-- (CI's Database job), including negative controls with the trigger and with
-- the family term removed.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).
--
-- Additive and replay-safe: `create or replace function`, `drop trigger if
-- exists` before `create trigger`, nothing else dropped.

create or replace function public.departure_plan_takes_its_head_out_event()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
begin
  if old.reminder_event_id is not null then
    delete from public.calendar_events
     where id = old.reminder_event_id
       and family_id = old.family_id;
  end if;
  return old;
end
$fn$;

comment on function public.departure_plan_takes_its_head_out_event() is
  '0360: a departure plan''s "Head out" calendar event is deleted with the plan, by any path — including the ON DELETE CASCADE from departure_plans.event_id when the event the plan was for is deleted. Security invoker, and fenced to the plan''s own family.';

do $$
begin
  if to_regclass('public.departure_plans') is null or to_regclass('public.calendar_events') is null then
    raise exception '0360: departure_plans / calendar_events are missing — 00981 has not been applied, so there is nothing to attach the head-out cleanup to';
  end if;

  drop trigger if exists departure_plans_take_their_head_out_event on public.departure_plans;
  create trigger departure_plans_take_their_head_out_event
    after delete on public.departure_plans
    for each row execute function public.departure_plan_takes_its_head_out_event();
end
$$;

-- ── Verify ──────────────────────────────────────────────────────────────────
do $$
declare
  definer boolean;
begin
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.departure_plans'::regclass
       and tgname = 'departure_plans_take_their_head_out_event'
       and not tgisinternal
  ) then
    raise exception '0360: the head-out cleanup trigger is missing from departure_plans';
  end if;

  select p.prosecdef into definer
    from pg_proc p
   where p.oid = 'public.departure_plan_takes_its_head_out_event()'::regprocedure;
  if definer then
    raise exception '0360: departure_plan_takes_its_head_out_event must be SECURITY INVOKER, so calendar_events RLS still decides what it may delete';
  end if;

  raise notice '0360 OK: deleting a departure plan — including by deleting the event it was for — takes its head-out reminder off the calendar with it.';
end
$$;
