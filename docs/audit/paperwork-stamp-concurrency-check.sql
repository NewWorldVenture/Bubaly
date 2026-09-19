-- ── 0327: stamping one paperwork action must not rewrite the others ─────────
--
-- The application used to read the whole `actions` array, create the calendar
-- event or reminder, and write the whole array back with one element changed.
-- Two overlapping taps both read the same array and the second write erased the
-- first one's stamp — so the record existed, the item did not say so, and the
-- next tap created a second one.
--
-- This exercises `public.paperwork_stamp_action` against the real jsonb, in the
-- interleaving the application produces: A reads, B reads, A stamps, B stamps.
-- The old code's semantics are simulated alongside it so the two are compared
-- rather than asserted about.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/paperwork-stamp-concurrency-check.sql
--
-- Re-runnable: the fixture family's rows are cleared before each run.
-- Audit C1-S8-05.
do $$
declare
  fam uuid := 'f0327000-0000-4000-8000-00000000fa01';
  up  uuid := 'f0327000-0000-4000-8000-00000000c001';
  uk  uuid := 'f0327000-0000-4000-8000-00000000c002';
  item uuid := 'f0327000-0000-4000-8000-0000000000a1';
  seen_a jsonb; seen_b jsonb;   -- the copies two overlapping calls each read
  won boolean; n int; st text;
begin
  insert into public.families (id, name) values (fam, '0327 paperwork stamps') on conflict do nothing;
  insert into auth.users (id, email) values (up, 'p0327@example.test'), (uk, 'k0327@example.test')
    on conflict do nothing;
  delete from public.paperwork_items where family_id = fam;
  delete from public.family_members  where family_id = fam;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, up, 'Parent', 'parent', true), (fam, uk, 'Kid', 'child', true);

  insert into public.paperwork_items (id, family_id, title, kind, status, created_by, actions)
    values (item, fam, 'Field trip', 'permission_slip', 'needs_action', up, jsonb_build_array(
      jsonb_build_object('kind', 'rsvp', 'label', 'RSVP', 'materialized_as', null, 'materialized_id', null),
      jsonb_build_object('kind', 'sign', 'label', 'Sign',  'materialized_as', null, 'materialized_id', null)
    ));

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', up::text, true);
  if auth.uid() is distinct from up then
    raise exception '0327: impersonation failed — this probe is not testing what it claims';
  end if;

  -- ── The old semantics, for comparison ─────────────────────────────────────
  -- Both taps read first (this is what overlapping requests do), then both
  -- write the whole array back.
  select actions into seen_a from public.paperwork_items where id = item;
  select actions into seen_b from public.paperwork_items where id = item;
  update public.paperwork_items
     set actions = jsonb_set(seen_a, '{0,materialized_id}', '"event-1"') where id = item;
  update public.paperwork_items
     set actions = jsonb_set(seen_b, '{1,materialized_id}', '"reminder-1"') where id = item;
  select count(*) into n from jsonb_array_elements(
    (select actions from public.paperwork_items where id = item)) e
   where coalesce(e ->> 'materialized_id', '') <> '';
  if n <> 1 then
    raise exception '0327: the old read-modify-write kept % stamps — this probe no longer reproduces the defect it exists for', n;
  end if;
  raise notice 'old semantics: % of 2 stamps survived the overlap', n;

  -- ── 0327 ──────────────────────────────────────────────────────────────────
  update public.paperwork_items set actions = jsonb_build_array(
      jsonb_build_object('kind', 'rsvp', 'label', 'RSVP', 'materialized_as', null, 'materialized_id', null),
      jsonb_build_object('kind', 'sign', 'label', 'Sign',  'materialized_as', null, 'materialized_id', null)
    ), status = 'needs_action' where id = item;

  -- Same interleaving: both callers hold a stale copy; neither sends it.
  select actions into seen_a from public.paperwork_items where id = item;
  select actions into seen_b from public.paperwork_items where id = item;
  if public.paperwork_stamp_action(item, 0, 'calendar_event', 'event-1') is not true then
    raise exception '0327: the first stamp was refused';
  end if;
  if public.paperwork_stamp_action(item, 1, 'reminder', 'reminder-1') is not true then
    raise exception '0327: the second stamp was refused';
  end if;
  select count(*) into n from jsonb_array_elements(
    (select actions from public.paperwork_items where id = item)) e
   where coalesce(e ->> 'materialized_id', '') <> '';
  if n <> 2 then
    raise exception '0327: only % of 2 stamps survived', n;
  end if;

  -- Status is recomputed from the row, so the sibling that landed in between
  -- counts toward "done" instead of being pushed back to "in_progress".
  select status into st from public.paperwork_items where id = item;
  if st is distinct from 'done' then
    raise exception '0327: every action is materialized but the item reads %', st;
  end if;

  -- ── A second tap on the same action does not win ──────────────────────────
  won := public.paperwork_stamp_action(item, 0, 'calendar_event', 'event-2');
  if won is not false then
    raise exception '0327: an already-stamped action was stamped again';
  end if;
  if (select actions -> 0 ->> 'materialized_id' from public.paperwork_items where id = item) <> 'event-1' then
    raise exception '0327: the second tap overwrote the first record''s id';
  end if;

  -- ── Nonsense arguments are refused, not stamped ───────────────────────────
  if public.paperwork_stamp_action(item, 9, 'reminder', 'x') is not false then
    raise exception '0327: an index past the end of the array was accepted';
  end if;
  if public.paperwork_stamp_action(item, -1, 'reminder', 'x') is not false then
    raise exception '0327: a negative index was accepted';
  end if;

  -- ── An archived item keeps its status ─────────────────────────────────────
  update public.paperwork_items set status = 'archived',
    actions = jsonb_build_array(jsonb_build_object('kind','sign','label','Sign','materialized_as',null,'materialized_id',null))
    where id = item;
  perform public.paperwork_stamp_action(item, 0, 'reminder', 'reminder-9');
  select status into st from public.paperwork_items where id = item;
  if st is distinct from 'archived' then
    raise exception '0327: stamping an action un-archived the item (status is %)', st;
  end if;

  reset role;

  -- ── It is not a way around RLS ────────────────────────────────────────────
  -- SECURITY INVOKER, so a member of another family reaches nothing. A child of
  -- THIS family still may stamp, because paperwork is family-wide by design and
  -- this function must not quietly become an authorization change.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', uk::text, true);
  update public.paperwork_items set status = 'needs_action',
    actions = jsonb_build_array(jsonb_build_object('kind','sign','label','Sign','materialized_as',null,'materialized_id',null))
    where id = item;
  if public.paperwork_stamp_action(item, 0, 'reminder', 'reminder-10') is not true then
    raise exception '0327: a member of the family can no longer stamp — the function changed who may write';
  end if;
  reset role;

  -- An outsider: no membership at all, so RLS matches no row and the function
  -- reports that it stamped nothing rather than raising.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000ff', true);
  update public.paperwork_items set actions = jsonb_set(actions, '{0,materialized_id}', 'null') where id = item;
  if public.paperwork_stamp_action(item, 0, 'reminder', 'stranger') is not false then
    raise exception '0327: a stranger stamped a family''s paperwork';
  end if;
  reset role;

  raise notice '0327 OK — one stamp per call, siblings intact, status recomputed, RLS unchanged';
end $$;
