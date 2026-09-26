-- family-delete-cascade-check.sql
--
-- A family can actually be deleted, and deleting one note still tells the
-- sync clients about it.
--
-- 0287 exists because those two pull in opposite directions. `sync_log_change()`
-- fires AFTER DELETE on sync_calendar_events / sync_notes / sync_reminders and
-- writes a `sync_change_logs` row carrying the family_id — correct for one note
-- going away, fatal for a cascade, where Postgres has already removed the
-- parent and the log row's foreign key cannot be satisfied. The delete aborted
-- and the family survived.
--
-- Normal use never hit it: account closure is SOFT (families.closed_at), and
-- the admin console only deletes families it just created. A hard erasure, or
-- the teardown in tests/e2e/authenticated.spec.ts, did.
--
-- Run by docs/audit/run-probes.sh, which globs docs/audit/*-check.sql.

\set ON_ERROR_STOP on

begin;

-- ── NEGATIVE CONTROL, and it runs FIRST, before either check below ───────────
--
-- WHICH MIGRATION, AND WHICH MECHANISM
-- ---------------------------------------------------------------------------
-- The rule under test is `0291_sync_log_skips_deleted_family.sql`'s. (The
-- header above says "0287"; there is no 0287/0288/0289 in supabase/migrations
-- at all — 0286 is followed by 0290 — so that number is stale and the reader
-- should follow 0291. Left as written rather than rewritten, because this pass
-- may only add.) `grep -rl sync_log_change supabase/migrations` returns exactly
-- two files, 0018_sync_platform.sql and 0291, and 0291 is the LAST: it is a
-- `create or replace function public.sync_log_change()` that inserts, into the
-- DELETE branch and nowhere else,
--
--     if not exists (select 1 from public.families where id = v_family) then
--       return old;
--     end if;
--
-- Nothing after 0291 touches that function, `sync_change_logs`,
-- `sync_calendar_events` or `sync_calendars` (same grep, same answer for each).
--
-- A name grep cannot see a catalog-driven `execute format` loop, so the
-- migrated catalog was read as well (a fresh clone of the replayed template).
-- The only non-internal triggers on `sync_calendars`, `sync_calendar_events`,
-- `sync_change_logs` and `sync_notes` are 0018's own: `trg_set_updated_at`
-- (BEFORE UPDATE, attached by 0018's `execute format` loop over its sync_*
-- tables, not by name) and `trg_sync_log` on the three item tables. `families`
-- carries `trg_set_updated_at` and `on_family_created` — an AFTER INSERT (0003,
-- last replaced by 0257) that seeds `subscriptions` and `family_ai_settings`
-- for every new family, the control's included; those rows cascade away with
-- their family and neither table has a DELETE trigger.
-- `sync_change_logs_family_id_fkey` is NOT DEFERRABLE. No post-0291
-- `execute format` loop (0311, 0313, 0338, 0345, 0352, …) lists a sync_*
-- table, and 0118's catalog-driven loops only enable RLS and write policies —
-- neither binds this probe, which runs as `postgres` (CI's PGUSER), the owner
-- of every table here and a superuser.
--
-- The mechanism is a TRIGGER — a guard clause inside the AFTER INSERT OR UPDATE
-- OR DELETE row trigger `trg_sync_log`, which 0018 puts on `sync_notes`,
-- `sync_calendar_events` and `sync_reminders`, all three calling
-- `public.sync_log_change()` with the item type as `tg_argv[0]`. It is NOT RLS:
-- this probe switches no role, names no policy and catches no
-- `insufficient_privilege`; the collision it documents is between that trigger's
-- INSERT and the foreign key `sync_change_logs.family_id -> families.id`, and
-- 0291 resolves it in the function body. The predicate under test is therefore
-- that one line: **does the parent family row still exist when the AFTER DELETE
-- trigger fires?**
--
-- WHY CHECK (2) NEEDS A CONTROL
-- ---------------------------------------------------------------------------
-- Check (2)'s green is a NEGATIVE observation — "`delete from families` raised
-- nothing" — which is the same unattributed class as "the UPDATE matched zero
-- rows". A family delete raises no foreign-key error for at least four
-- different reasons, and only the first is the guard:
--
--   a. the `exists` test answered "gone", so the trigger returned early;
--   b. the trigger did not fire on — or chose not to log — the cascaded rows.
--      NOT through `pg_trigger_depth()`, which this block used to name and
--      which is inert here: Postgres runs a cascade's DELETE with its row
--      triggers queued onto the OUTER statement's after-trigger list (RI
--      actions execute with fire_triggers = false), so the cascaded rows'
--      AFTER triggers fire at pg_trigger_depth() = 1, exactly like check (1)'s
--      top-level delete. Measured on a clone of the migrated template: 1 for
--      sync_notes under `delete from families`, 1 for sync_calendar_events
--      under `delete from sync_calendars`, 1 for a direct `delete from
--      sync_notes`. A depth test therefore neither fixes 0291's bug (check (2)
--      goes red under it) nor silences a cascade (leg A stays green under it,
--      correctly). Inside the trigger, nothing tells a cascaded delete from a
--      direct one but the state of the rows around it, so the (b) that
--      remains is an early return keyed to "my PARENT is gone" rather than
--      "my FAMILY is gone" — a well-meant generalisation of 0291 to the
--      calendar a deleted event belonged to — or trg_sync_log dropped or
--      disabled on a table check (1) never touches;
--   c. the trigger fired, wrote its log row, and `sync_change_logs_family_id_
--      fkey` did not refuse it — dropped, or made DEFERRABLE INITIALLY
--      DEFERRED, in which case the check is deferred to a COMMIT this probe
--      never performs (it ends in `rollback`). Then the delete succeeds with
--      0291's guard deleted outright, and check (2) credits a guard that is no
--      longer load-bearing — the exact failure this audit already made once by
--      replaying a migration a later one had replaced;
--   d. nothing was there to cascade. 0291 says so in its own words: "Without
--      the sync row the same delete succeeds, which is why this has gone
--      unnoticed."
--
-- Check (1) covers only part of (b): it proves the trigger still logs a
-- top-level `delete from sync_notes`, and says nothing about the cascade path
-- check (2) actually travels, nor about `sync_calendar_events` /
-- `sync_reminders`, which carry the same trigger. It does not touch (c) at all.
--
-- THE CONTROL: the same predicate, the answer the other way, and it must land
-- ---------------------------------------------------------------------------
-- Leg A is the same session, the same trigger function, the same guard line and
-- the same `insert into sync_change_logs`, reached the same way — from inside an
-- ON DELETE CASCADE, at the same pg_trigger_depth() (1) as check (2)'s cascaded
-- note — with the one thing the mechanism keys on flipped: the family is
-- ALIVE. So `exists (select 1 from families …)` answers yes, the early return
-- is not taken, and the log row MUST LAND. Its green says the suppression
-- check (2) relies on is keyed to the family's absence, not to the delete
-- having arrived through a cascade or to the row's parent having gone.
--
-- It cascades through `sync_calendars -> sync_calendar_events` rather than
-- through `sync_notes` because `sync_notes` has no cascading parent except
-- `families` itself (`folder_id` is ON DELETE SET NULL, which fires this
-- trigger as an UPDATE, not a DELETE), so there is no way to cascade-delete a
-- note while its family survives. That much is forced. Calendars over
-- reminders is a CHOICE, not the only way: `sync_reminders.list_id references
-- sync_reminder_lists(id) on delete cascade` (0018) is the identical
-- construction, on a table carrying the same `trg_sync_log` (tg_argv
-- 'reminder'), and it is the path to take if this one is ever blocked. Same
-- function, same guard, same insert, same foreign key — only `tg_argv[0]`
-- differs ('event' for 'note'), and the guard does not read it.
--
-- Leg A proves its own premise instead of assuming it: the event row is seen
-- to exist before the delete and to be GONE after it, so the log-row count is
-- read only once a cascade is known to have reached `sync_calendar_events`.
-- ROW_COUNT on the parent delete cannot show that — it counts calendars, and
-- is 1 whether or not anything cascaded — so it is kept only for the one case
-- it can show: the parent delete suppressed outright (a BEFORE DELETE trigger
-- returning NULL), where it reads 0.
--
-- Leg B is the mirror, and it is the trigger's own INSERT statement copied
-- column for column: the same session inserting into `sync_change_logs` with
-- the one thing the mechanism keys on changed — a `family_id` that does not
-- exist — which must be REFUSED with `foreign_key_violation`. That is the error
-- 0291 quotes in its header. If it does not come, the guard is guarding nothing
-- and check (2) below would pass with the guard removed: case (c).
--
-- Together: leg A red means the refusal-shaped silence in check (2) came from
-- the trigger not firing (case b), and the probe says UNPROVEN instead of
-- reporting a boundary it cannot see; leg B red means the silence came from an
-- absent constraint (case c). Both leave check (1) and check (2) green, which
-- is precisely why neither is visible without this block.
--
-- Not covered, stated rather than implied:
--   * a silencing keyed to ROW CONTENT that happens to separate check (1)'s
--     note from check (2)'s (a `WHEN` clause or function test on title,
--     metadata, …). Contrived, but nothing here would see it;
--   * a guard NARROWED rather than removed, e.g. `… where id = v_family and
--     closed_at is null`, which stops logging deletes for a soft-closed but
--     still-present family. Every family this probe seeds is open, so leg A
--     and check (1) stay green under it — yet 0291 promises the log for any
--     family whose row "is still there", and a closed family's row is.
-- There is deliberately no catalog assertion on trg_sync_log's `WHEN` clause.
-- The form it would target, `when (pg_trigger_depth() = 1)`, is inert for the
-- reason given under (b) — a cascaded row fires at depth 1 too — and a
-- catalog-shape check would turn a benign future `WHEN` (say, skipping
-- remote-origin rows) into a false UNPROVEN.
--
-- Case (d) is no longer left to a note: check (2) now confirms, by the id its
-- insert returned, that the 'Second probe note' was actually stored before it
-- deletes the family — the precondition 0291 states in its own header
-- ("Without the sync row the same delete succeeds"). Today nothing could drop
-- it (`sync_notes`' only BEFORE trigger is `trg_set_updated_at`, on UPDATE),
-- which is exactly why it is asserted rather than assumed.
--
-- Anchors: ca5d/ca5e/ca5f/ca60 extend this probe's existing ca5c style, and
-- each was grepped across docs/audit and supabase/migrations (and the repo)
-- before use — no hit outside this file, so nothing another probe seeds
-- collides, and ca60 is safe to rely on as a family id that does not exist.
-- Leg 0 re-checks that last one at run time rather than trusting the grep,
-- because every probe run-probes.sh globs shares one database in sequence (no
-- count here on purpose: a hardcoded probe total is the number that goes stale
-- and gets quoted).

do $$
declare
  n int;
  failures text[] := '{}';
  control_ok boolean := true;
  -- The control's own household, so none of its rows land in the counts the
  -- two checks below take over ca5c.
  ctl_fam   constant uuid := '00000000-0000-4000-8000-00000000ca5d';
  ctl_cal   constant uuid := '00000000-0000-4000-8000-00000000ca5e';
  ctl_event constant uuid := '00000000-0000-4000-8000-00000000ca5f';
  -- Reserved as a family that does not exist. Never inserted into families by
  -- anything in this corpus.
  ctl_ghost constant uuid := '00000000-0000-4000-8000-00000000ca60';
begin
  -- Leg 0. If an earlier probe in the same run has seeded the ghost anchor as a
  -- real family, leg B's insert would land for a reason that is not the
  -- constraint being gone, and reading it as a verdict would be a false
  -- failure. Say the control cannot run instead of guessing.
  --
  -- This fails CLOSED (an exception, so run-probes.sh prints FAIL) rather than
  -- emitting the corpus's uppercase SKIP notice, deliberately: a SKIP exits 0,
  -- checks (1) and (2) below would still run and print their OKs, and with
  -- PROBES_ALLOW_SKIP=1 the whole probe would count as not-failed with its
  -- control never exercised. A control that cannot run is not a verdict either
  -- way, and a red line is the only one nobody reads as a pass.
  if exists (select 1 from public.families where id = ctl_ghost) then
    raise exception 'A-12 control CANNOT RUN: %, reserved here as a family id that does not exist, has been seeded as a real family — pick a fresh anchor for it rather than reading leg B''s insert as a verdict', ctl_ghost;
  end if;

  insert into public.families (id, name, created_by)
    values (ctl_fam, 'Cascade Probe Control', null);
  insert into public.sync_calendars (id, family_id, name)
    values (ctl_cal, ctl_fam, 'Control Calendar');
  insert into public.sync_calendar_events (id, calendar_id, family_id, title, starts_at)
    values (ctl_event, ctl_cal, ctl_fam, 'Control Event', now());

  -- ── Leg A: a cascaded delete whose family is ALIVE must still be logged ───
  -- Deleting the calendar cascades into sync_calendar_events, so trg_sync_log
  -- fires from inside a cascade exactly as it does under `delete from families`
  -- — but the family is still there, so the guard's early return must NOT be
  -- taken and the log row must be written.
  --
  -- Premise first, by id: the row the cascade has to reach was really stored.
  if not exists (select 1 from public.sync_calendar_events where id = ctl_event) then
    control_ok := false;
    failures := array_append(failures, format('CONTROL FAILED: the control event %s was not stored, so there was nothing for the cascade to reach and leg A could exercise no trigger', ctl_event));
  end if;

  if control_ok then
    begin
      delete from public.sync_calendars where id = ctl_cal;
      -- ROW_COUNT counts CALENDARS. It is 1 whenever the parent row went,
      -- cascade or no cascade, and reads 0 only when the parent delete itself
      -- was suppressed (a BEFORE DELETE trigger returning NULL). Whether the
      -- cascade actually reached sync_calendar_events is read directly, next.
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        failures := array_append(failures, format('CONTROL FAILED: the control calendar delete removed %s rows instead of 1 — the parent delete itself was suppressed, so no cascade ran and leg A exercised no trigger at all', n));
      elsif exists (select 1 from public.sync_calendar_events where id = ctl_event) then
        control_ok := false;
        failures := array_append(failures, 'CONTROL FAILED: the control calendar was deleted but its event survived — sync_calendar_events_calendar_id_fkey no longer cascades, so leg A never reached trg_sync_log from inside a cascade and cannot speak for the path check (2) travels');
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: deleting a calendar whose family is ALIVE raised %s: %s — the trigger cannot log a cascaded delete even when the foreign key is satisfiable, so the silence check (2) observes cannot be read as 0291''s exists() guard letting the cascade through', sqlstate, sqlerrm));
    end;
  end if;

  if control_ok then
    select count(*) into n
    from public.sync_change_logs
    where family_id = ctl_fam and local_id = ctl_event
      and item_type = 'event' and operation = 'delete';
    if n <> 1 then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: a cascaded delete in a family that STILL EXISTS logged %s sync_change_logs rows, expected 1 — sync_log_change() has stopped logging cascaded deletes outright (trg_sync_log dropped or disabled on sync_calendar_events, or an early return keyed to the cascade — e.g. the parent calendar being gone — instead of to the family), so check (2) below would report a held boundary while every cascade went unlogged', n));
    end if;
  end if;

  -- ── Leg B: the constraint the guard exists to dodge must still refuse ─────
  -- The trigger's own INSERT, column for column, with only the family_id
  -- changed to one that does not exist. This must raise the error 0291's
  -- header quotes. If it lands, the guard is dodging a constraint that no
  -- longer objects, and check (2) would pass with 0291 reverted.
  begin
    insert into public.sync_change_logs (family_id, item_type, local_id, operation, origin, before)
      values (ctl_ghost, 'event', ctl_event, 'delete', 'local', '{}'::jsonb);
    delete from public.sync_change_logs where family_id = ctl_ghost;
    control_ok := false;
    failures := array_append(failures, 'CONTROL FAILED: sync_change_logs accepted a row naming a family that does not exist, so sync_change_logs_family_id_fkey no longer refuses immediately — dropped, or DEFERRABLE INITIALLY DEFERRED and therefore never checked, because this probe ends in rollback and never commits. Check (2) below would then succeed with 0291''s guard removed entirely, crediting a guard that is no longer load-bearing');
  exception
    when foreign_key_violation then null;  -- expected: the error 0291 exists to avoid
    when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: the trigger''s own insert into sync_change_logs raised %s: %s instead of foreign_key_violation, so this session could not have written the log row check (2) assumes was suppressed by the guard', sqlstate, sqlerrm));
  end;

  -- The control's household does not outlive the control. Unconditional: a
  -- stray family with sync rows is exactly the quiet contamination that turns
  -- one unattributed check into one false failure in a later probe, and every
  -- probe in the run shares this database. What actually guarantees nothing
  -- survives is this file's closing `rollback`, not this block: the sub-block
  -- below is atomic, so an error on ANY of its deletes (the last included)
  -- rolls ALL of them back to its savepoint, and the household then lives
  -- until that rollback. It is here to keep the control's rows out of checks
  -- (1) and (2) in the same transaction, which filter on ca5c anyway.
  --
  -- Torn down item-rows-first and inside its own handler, both deliberately. If
  -- leg A above failed, the calendar and its event are still here, and
  -- `delete from families` would then cascade into sync_calendar_events and hit
  -- the very guard under test — so a broken guard would abort this block with a
  -- raw sync_change_logs_family_id_fkey error and bury the diagnosis leg A just
  -- assembled, which is the whole thing this control exists to stop happening.
  -- Cleanup is hygiene and never the verdict; the verdict is raised below.
  begin
    delete from public.sync_calendar_events where family_id = ctl_fam;
    delete from public.sync_calendars where family_id = ctl_fam;
    delete from public.sync_change_logs where family_id = ctl_fam;
    delete from public.families where id = ctl_fam;
  exception when others then null;
  end;

  if not control_ok then
    raise exception 'A-12 UNPROVEN (the control this probe rests on did not hold): %', array_to_string(failures, ' | ');
  end if;
  raise notice 'A-12 control OK: with the family ALIVE the same trigger reached the same way (from inside an ON DELETE CASCADE, the cascade seen to land) still writes its delete log row, and sync_change_logs still refuses a row naming an absent family — so the two checks below measure 0291''s exists() guard and not a trigger that stopped firing or a foreign key that stopped objecting';
end $$;

do $$
declare
  v_family uuid := '00000000-0000-4000-8000-00000000ca5c';
  v_deletes integer;
  v_note uuid;
begin
  insert into public.families (id, name, created_by) values (v_family, 'Cascade Probe', null);
  insert into public.sync_notes (family_id, title) values (v_family, 'Probe note');

  -- (1) An ordinary delete by a LIVE family must still be logged. 0287 must not
  --     have bought the cascade by silencing the feature.
  delete from public.sync_notes where family_id = v_family;
  select count(*) into v_deletes
  from public.sync_change_logs where family_id = v_family and operation = 'delete';
  if v_deletes <> 1 then
    raise exception 'A-12 FAIL: an ordinary sync delete was not logged (% rows, expected 1)', v_deletes;
  end if;
  raise notice 'A-12 OK: an ordinary sync delete is still logged';

  -- (2) Deleting the family, with a sync row present, must succeed. Before 0287
  --     this raised sync_change_logs_family_id_fkey and rolled the whole
  --     transaction back.
  insert into public.sync_notes (family_id, title) values (v_family, 'Second probe note')
    returning id into v_note;
  -- Case (d), asserted rather than assumed: 0291's own header says "Without
  -- the sync row the same delete succeeds", so a green below means nothing
  -- unless the row is really there, by the id the insert handed back.
  if v_note is null or not exists (select 1 from public.sync_notes where id = v_note) then
    raise exception 'A-12 UNPROVEN: the second probe note was not stored, so the family delete below has no sync row to cascade into and would succeed with 0291 reverted — case (d)';
  end if;
  begin
    delete from public.families where id = v_family;
  exception when foreign_key_violation then
    -- Same refusal as before, named: the raw error is re-raised as this
    -- probe's own verdict, not swallowed. Any other error propagates as is.
    raise exception 'A-12 FAIL: deleting a family that holds sync data raised % (%) — the cascaded sync_notes delete wrote a log row naming the vanished family, so 0291''s exists() guard in sync_log_change() is no longer doing its job', sqlerrm, sqlstate;
  end;

  if exists (select 1 from public.families where id = v_family) then
    raise exception 'A-12 FAIL: the family survived its own delete';
  end if;
  raise notice 'A-12 OK: a family holding sync data can be deleted';
end $$;

rollback;
