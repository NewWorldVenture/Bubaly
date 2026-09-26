-- ── A head-out reminder goes with its departure plan (0360, SRV-001 m41) ─────
--
-- Smart Departure writes a "🚗 Head out for …" calendar event for a plan and
-- links it from the plan (departure_plans.reminder_event_id). The link runs
-- plan → event only. 00981 made departure_plans.event_id ON DELETE CASCADE, so
-- deleting the event a plan was FOR (the soccer game) deletes the plan and
-- leaves its head-out reminder on every member's calendar, with nothing in the
-- product left that can find it. 0360 adds an AFTER DELETE FOR EACH ROW trigger
-- on departure_plans that deletes the plan's reminder, fenced to the plan's own
-- family, as SECURITY INVOKER.
--
-- tests/a-head-out-reminder-never-outlives-its-departure-plan.test.ts can only
-- read 0360's text. This probe proves the OUTCOME on the replayed schema, as a
-- signed-in member where the product runs as one:
--
--   1. a member deletes the event a plan was for → the plan AND its reminder
--      are gone, and a hand-typed event with the same title is not touched
--      (the trigger follows the link, never the title);
--   2. the Remove button's own order (reminder first, then plan —
--      deleteDeparturePlanAction) still works, and the event the plan was FOR
--      stays: it is the family's own;
--   3. deleting the head-out event BY HAND still leaves the plan, its link
--      nulled (00981's SET NULL is untouched), so a refresh can re-create it;
--   4. deleting a plan directly — any writer, present or future — takes its
--      reminder with it;
--   5. the family fence holds where RLS does not (a superuser/service-role
--      delete): a plan whose reminder_event_id names ANOTHER household's event
--      (foreign keys do not consult RLS) does not delete that event;
--   6. the function is not SECURITY DEFINER;
--   7. NEGATIVE CONTROLS, inside this transaction: without the family term the
--      other household's event IS deleted; without the trigger the reminder IS
--      stranded. A probe never shown to fail is decoration.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/a-head-out-reminder-goes-with-its-departure-plan-check.sql

\set FH '00000000-0000-4000-8000-000000d0e001'
\set FO '00000000-0000-4000-8000-000000d0e002'
\set UP '00000000-0000-4000-8000-000000d0e003'
\set UO '00000000-0000-4000-8000-000000d0e004'

begin;

insert into auth.users (id, email) values (:'UP','headout-parent@example.com')    on conflict do nothing;
insert into auth.users (id, email) values (:'UO','headout-next-door@example.com') on conflict do nothing;
-- handle_new_family makes each creator the family's parent member.
insert into public.families (id, name, created_by) values (:'FH','Head-out House',:'UP') on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FO','Next Door',:'UO')      on conflict do nothing;

do $$
declare
  n         int;
  v         uuid;
  failures  text[] := '{}';
  fam       constant uuid := '00000000-0000-4000-8000-000000d0e001';
  other_fam constant uuid := '00000000-0000-4000-8000-000000d0e002';
  parent_u  constant uuid := '00000000-0000-4000-8000-000000d0e003';
  -- One (game, reminder, plan) triple per scenario.
  g1 constant uuid := '00000000-0000-4000-8000-000000d0e011';
  h1 constant uuid := '00000000-0000-4000-8000-000000d0e012';
  p1 constant uuid := '00000000-0000-4000-8000-000000d0e013';
  l1 constant uuid := '00000000-0000-4000-8000-000000d0e014';
  g2 constant uuid := '00000000-0000-4000-8000-000000d0e021';
  h2 constant uuid := '00000000-0000-4000-8000-000000d0e022';
  p2 constant uuid := '00000000-0000-4000-8000-000000d0e023';
  g3 constant uuid := '00000000-0000-4000-8000-000000d0e031';
  h3 constant uuid := '00000000-0000-4000-8000-000000d0e032';
  p3 constant uuid := '00000000-0000-4000-8000-000000d0e033';
  g4 constant uuid := '00000000-0000-4000-8000-000000d0e041';
  h4 constant uuid := '00000000-0000-4000-8000-000000d0e042';
  p4 constant uuid := '00000000-0000-4000-8000-000000d0e043';
  x5 constant uuid := '00000000-0000-4000-8000-000000d0e051';
  p5 constant uuid := '00000000-0000-4000-8000-000000d0e053';
  x6 constant uuid := '00000000-0000-4000-8000-000000d0e061';
  p6 constant uuid := '00000000-0000-4000-8000-000000d0e063';
  g7 constant uuid := '00000000-0000-4000-8000-000000d0e071';
  h7 constant uuid := '00000000-0000-4000-8000-000000d0e072';
  p7 constant uuid := '00000000-0000-4000-8000-000000d0e073';
begin
  -- Seeded as the table owner: a plan and its reminder exactly as
  -- saveDeparturePlanAction writes them, plus the other household's event.
  insert into public.calendar_events (id, family_id, title, starts_at) values
    (g1, fam, 'Soccer game',                  now() + interval '1 day'),
    (h1, fam, '🚗 Head out for Soccer game',  now() + interval '23 hours'),
    (l1, fam, '🚗 Head out for Soccer game',  now() + interval '23 hours'),  -- typed by a person; no plan links it
    (g2, fam, 'Dentist',                      now() + interval '2 days'),
    (h2, fam, '🚗 Head out for Dentist',      now() + interval '47 hours'),
    (g3, fam, 'Piano recital',                now() + interval '3 days'),
    (h3, fam, '🚗 Head out for Piano recital', now() + interval '71 hours'),
    (g4, fam, 'Swim meet',                    now() + interval '4 days'),
    (h4, fam, '🚗 Head out for Swim meet',    now() + interval '95 hours'),
    (g7, fam, 'Field trip',                   now() + interval '5 days'),
    (h7, fam, '🚗 Head out for Field trip',   now() + interval '119 hours'),
    (x5, other_fam, 'Next door''s own event', now() + interval '1 day'),
    (x6, other_fam, 'Next door''s other event', now() + interval '1 day');
  insert into public.departure_plans (id, family_id, event_id, reminder_event_id, title, event_start) values
    (p1, fam, g1, h1, 'Soccer game',   now() + interval '1 day'),
    (p2, fam, g2, h2, 'Dentist',       now() + interval '2 days'),
    (p3, fam, g3, h3, 'Piano recital', now() + interval '3 days'),
    (p4, fam, g4, h4, 'Swim meet',     now() + interval '4 days'),
    -- Hand-written, owner-level: the FK accepts another family's event id.
    (p5, fam, null, x5, 'Crossed link', now() + interval '1 day');

  -- ── As the family's parent, the way the calendar's Delete button runs ────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.role','authenticated', true);
  perform set_config('request.jwt.claim.sub', parent_u::text, true);

  -- 1. THE MEASURED DEFECT: the game is cancelled and deleted.
  delete from public.calendar_events where id = g1;
  -- 2. The Remove button: reminder first, then plan.
  delete from public.calendar_events where id = h2;
  delete from public.departure_plans where id = p2;
  -- 3. Someone deletes a head-out reminder by hand.
  delete from public.calendar_events where id = h3;
  -- 4. A plan deleted on its own, by any writer.
  delete from public.departure_plans where id = p4;

  -- Counted as the owner, so RLS cannot make a surviving row look gone.
  perform set_config('role','postgres', true);

  select count(*) into n from public.departure_plans where id = p1;
  if n <> 0 then
    failures := array_append(failures,
      'deleting the event a plan was for did not cascade the plan away — 00981''s event_id ON DELETE CASCADE is not what this probe was written against');
  end if;
  select count(*) into n from public.calendar_events where id = h1;
  if n <> 0 then
    failures := array_append(failures,
      'a member deleted the event a plan was for and its "Head out" reminder STAYED on the calendar — the orphan 0360 exists to prevent (is the trigger missing, or refused by calendar RLS?)');
  end if;
  select count(*) into n from public.calendar_events where id = l1;
  if n <> 1 then
    failures := array_append(failures,
      'a hand-typed event that merely shares the head-out title was deleted — the cleanup must follow reminder_event_id, never the title');
  end if;

  select count(*) into n from public.departure_plans where id = p2;
  if n <> 0 then
    failures := array_append(failures, 'the Remove button''s order (reminder, then plan) no longer removes the plan');
  end if;
  select count(*) into n from public.calendar_events where id = g2;
  if n <> 1 then
    failures := array_append(failures,
      'removing a departure plan deleted the event it was FOR — that is the family''s own event, not the reminder');
  end if;

  select reminder_event_id into v from public.departure_plans where id = p3;
  if not found then
    failures := array_append(failures,
      'deleting a head-out reminder by hand took its PLAN with it — reminder_event_id must stay ON DELETE SET NULL so a refresh can re-create the reminder');
  elsif v is not null then
    failures := array_append(failures, 'deleting a head-out reminder by hand left the plan pointing at a row that is gone');
  end if;

  select count(*) into n from public.calendar_events where id = h4;
  if n <> 0 then
    failures := array_append(failures, 'a plan deleted directly left its "Head out" reminder on the calendar');
  end if;
  select count(*) into n from public.calendar_events where id = g4;
  if n <> 1 then
    failures := array_append(failures, 'deleting a plan directly deleted the event it was FOR');
  end if;

  -- 5. The fence, where RLS does not apply: this block runs as the owner.
  delete from public.departure_plans where id = p5;
  select count(*) into n from public.calendar_events where id = x5;
  if n <> 1 then
    failures := array_append(failures,
      'deleting a plan whose reminder_event_id named ANOTHER household''s event deleted that household''s event — the family_id = old.family_id fence is missing');
  end if;

  -- 6. Invoker, so calendar_events RLS still decides for a signed-in caller.
  select count(*) into n from pg_proc
   where oid = to_regprocedure('public.departure_plan_takes_its_head_out_event()') and prosecdef;
  if n <> 0 then
    failures := array_append(failures,
      'departure_plan_takes_its_head_out_event is SECURITY DEFINER — any member who can delete a plan could then delete past calendar_events RLS');
  end if;

  -- ── 7. NEGATIVE CONTROLS ────────────────────────────────────────────────
  -- a) The fence removed: the other household's event must now be deleted.
  create or replace function public.departure_plan_takes_its_head_out_event()
  returns trigger language plpgsql security invoker set search_path = public, pg_temp as $fn$
  begin
    if old.reminder_event_id is not null then
      delete from public.calendar_events where id = old.reminder_event_id;
    end if;
    return old;
  end $fn$;
  insert into public.departure_plans (id, family_id, event_id, reminder_event_id, title, event_start)
    values (p6, fam, null, x6, 'Crossed link, unfenced', now() + interval '1 day');
  delete from public.departure_plans where id = p6;
  select count(*) into n from public.calendar_events where id = x6;
  if n <> 0 then
    failures := array_append(failures,
      'with the family term removed the other household''s event STILL survived — assertion 5 has never been shown to fail');
  end if;

  -- b) The trigger removed: deleting the game must strand the reminder again.
  drop trigger if exists departure_plans_take_their_head_out_event on public.departure_plans;
  insert into public.departure_plans (id, family_id, event_id, reminder_event_id, title, event_start)
    values (p7, fam, g7, h7, 'Field trip', now() + interval '5 days');
  perform set_config('role','authenticated', true);
  delete from public.calendar_events where id = g7;
  perform set_config('role','postgres', true);
  select count(*) into n from public.calendar_events where id = h7;
  if n <> 1 then
    failures := array_append(failures,
      'with 0360''s trigger dropped the reminder was STILL removed — assertion 1 has never been shown to fail, so it proves nothing about 0360');
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a head-out reminder outlives its departure plan:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-head-out-reminder-goes-with-its-departure-plan: OK (a member deleting the event a plan was for takes the plan and its reminder off the calendar and leaves a same-titled hand-typed event alone; the Remove button still works and keeps the family''s own event; a reminder deleted by hand still leaves its plan with a nulled link; a plan deleted directly takes its reminder; the family fence holds where RLS does not; the function is invoker; negative controls deleted the other household''s event without the fence and stranded the reminder without the trigger)';
end $$;

rollback;
