-- ── A-03 Tenant-isolation RLS probe ─────────────────────────────────────────
-- Reusable cross-family isolation proof. Run against the verify-pg.sh harness
-- (which seeds family A = the anchor). This script provisions a second tenant
-- (family B / user B) and asserts, under the `authenticated` role acting AS user
-- B, that B can neither read nor write family A's rows, and that every
-- family-scoped table has RLS enabled.
--
--   bash docs/audit/verify-pg.sh up
--   PGHOST=/tmp/pgaudit_db PGPORT=54399 PGUSER=postgres PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/rls-isolation-check.sql
--
-- Exit is non-zero (via RAISE EXCEPTION) if any invariant fails.

\set FA '00000000-0000-4000-8000-0000000000f1'
\set FB '00000000-0000-4000-8000-0000000000fb'
\set UB '00000000-0000-4000-8000-0000000000b2'
-- ONE definition of who user B is and which family is B's. The negative control
-- reads it, and every invariant that acts as B asserts the session it switched
-- into IS this one. Each block still types its own set_config lines, so without
-- this the control would be vouching for a COPY of the invariants' session: a
-- typo in one invariant's GUC name or UUID would leave the control green and
-- still printing that the refusals below are attributable. Session-level, and
-- gone when psql exits.
set a03.user_b   = :'UB';
set a03.family_b = :'FB';

-- Provision tenant B (idempotent). The family trigger creates B's parent member.
insert into auth.users (id, email) values (:'UB','userb@example.com') on conflict do nothing;
do $$ begin if to_regclass('public.profiles') is not null then
  insert into public.profiles (id, full_name) values ('00000000-0000-4000-8000-0000000000b2','B Family') on conflict do nothing;
end if; end $$;
insert into public.families (id, name, created_by) values (:'FB','The B Family',:'UB') on conflict do nothing;
-- Not `on conflict do nothing`: no unique index covers these columns, so that
-- clause never fired and every run added another copy of this row.
insert into public.calendar_events (family_id, title, starts_at)
select :'FB', 'B private event', now()
where not exists (
  select 1 from public.calendar_events
  where family_id = :'FB' and title = 'B private event');

-- No blanket `grant ... on all tables in schema public` here. The bootstrap's
-- `alter default privileges` already gives `authenticated` full DML on every
-- table a migration creates, so the restatement was redundant — and once
-- migrations began revoking DML deliberately (0300 takes the paywall columns
-- away from the client), it stopped being redundant and started undoing them
-- for every probe that runs after this one against the shared database.

-- ── NEGATIVE CONTROL: the same actor, the same statements, the other family ──
-- IT RUNS FIRST, before invariants 1-5, because it is what makes their green
-- readable. Nothing below is weakened, deleted or skipped: this is added to
-- those five assertions, not substituted for any of them.
--
-- THE PREDICATE UNDER TEST. Everything invariants 2 and 3 assert about user B
-- and family A is one question: `public.is_family_member(family_id)` — created
-- once, by 0003_functions_triggers.sql:5-11 and replaced by no later migration,
-- as "an is_active family_members row for auth.uid() in that family". Below are
-- the policies that ask it on the two tables invariant 3 writes, with EVERY
-- migration that creates them. That means the ones that build policy names
-- with `execute format('create policy %1$s_select …')` as well as the ones
-- that spell them out. A grep for the policy NAME cannot see the first kind,
-- and the first kind is how most of these were made. (Taking the LAST creator
-- matters: `grep -l "Managers manage child_logins" supabase/migrations` returns
-- 01051 and 0297, and 0297 re-created that policy on a different predicate, so
-- replaying the earlier one from memory is how this audit once credited a guard
-- a later migration had already replaced.)
--
--   * calendar_events_{select,insert,update,delete}. First created by the
--     fam_tables loop in 0004_rls.sql:18-40, whose `%1$s_…` names never appear
--     as literals. Then dropped and re-created under literal names by
--     01050_calendar_events_rls_repair.sql, `USING / WITH CHECK
--     (public.is_family_member(family_id))` for every verb. `grep -l
--     calendar_events_insert` returns only 01050 and 0339, because it cannot
--     see 0004 or 0118.
--     0118_rls_drift_repair.sql section C (lines 142-179) can create the same
--     four names through format(), and it runs AFTER 01050 (pg-bootstrap.sh:102
--     globs lexicographically, and '01050' < '0118'). But it only acts on a
--     family_id table with NO SELECT/ALL policy, and calendar_events has
--     01050's, so 0118 skips it.
--     0339_a_calendar_event_names_who_actually_made_it.sql is the last migration
--     to change this table's policies, triggers or grants. 0360 and 0363 come
--     later but only reach its ROWS: 0360 puts an AFTER DELETE trigger on
--     departure_plans whose SECURITY INVOKER function deletes calendar_events
--     rows under this table's own RLS, and 0363 counts them. 0339 does NOT
--     re-create the four. It READS three back (lines 376-404: it raises unless
--     calendar_events_{select,insert,update} still carry 01050's
--     `is_family_member(family_id)`; it does not re-check _delete). It ADDS a
--     separate policy, `calendar_events_author_guard`, `as restrictive for
--     insert to authenticated`, which ANDs with the permissive one rather than
--     replacing it. And it ADDS a BEFORE UPDATE trigger,
--     calendar_events_attribution_immutable, that copies old.created_by into
--     new and never raises. The table's only other trigger is
--     trg_set_updated_at, from 0003:87-98's loop over every table with an
--     updated_at column; it only stamps updated_at.
--   * notes_{select,insert,update,delete}. Created by that same 0004 loop and by
--     nothing else. `grep -l notes_delete supabase/migrations` has NO hits at
--     all, because 0004 builds every one of these names from `%1$s`. 0118
--     section C would build them the same way but skips notes, which already
--     has 0004's notes_select. `notes` carries no restrictive policy, and its
--     only trigger is trg_set_updated_at.
--
-- None of that inventory is taken on trust from these paragraphs. The block
-- "Invariants 2 and 3, attributed", after invariant 3, reads pg_policies and
-- goes red unless the eight policies still carry is_family_member(family_id)
-- and no other policy governs `authenticated` on either table except 0339's
-- author guard, verbatim. 0339 makes that check for three of the eight; this
-- probe makes it for all eight.
--
-- MECHANISM: RLS policies, on both tables, for all four verbs. Not a trigger,
-- not a CHECK, not a unique index, not a GRANT. pg-bootstrap.sh:54 hands
-- `authenticated` all table privileges by default privilege before any
-- migration runs. The only REVOKE in supabase/migrations that names either
-- table is 0339:297, which is `from anon`, and this probe acts as
-- `authenticated`. The REVOKEs that are built by format() (0338:154,
-- 0352:123) are on other tables. And the legs below are the live proof
-- that the grants are there, because each one is a write that `authenticated`
-- needs the privilege for.
--
-- WHICH POLICY, VERB BY VERB (measured, not assumed). Invariant 3's UPDATE and
-- DELETE have a WHERE clause, and Postgres applies a table's SELECT policy to
-- every row an UPDATE or DELETE reads, on top of that verb's own policy. So
-- the UPDATE's zero is calendar_events_select AND calendar_events_update, and
-- the DELETE's zero is notes_select AND notes_delete. All four ask the same
-- predicate. Loosen notes_delete alone to `using (true)` and invariant 3's
-- DELETE still reports zero rows, because notes_select still hides family A.
-- On a template copy with that mutation, the red came from the attributed
-- block, not from invariant 3. Only the INSERT's refusal belongs to a single
-- permissive policy (calendar_events_insert, ANDed with the author guard), so
-- the INSERT is the refusal to loosen when proving this probe bites.
--
-- THE CONTROL. So the control is user B, the session a03.user_b names, running
-- invariant 3's own statements against family B, the family B IS a member of
-- (on_family_created files the creator as a 'parent', 0003:67-84, and the
-- control re-asserts it rather than assuming). Exactly ONE thing changes in
-- each statement: the family_id literal that is_family_member() is asked about.
-- Those writes MUST LAND. If the refusals below come from the policy, this one
-- lands. If they come from a missing GRANT, a column denial, a dead auth.uid()
-- or a guard trigger, this one is refused too and the probe goes red — which is
-- what you want, because the probe's attribution was wrong.
--
-- WHAT IT WOULD CATCH. Without it, invariants 2 and 3 are refusals with nothing
-- attributing them to the policy:
--
--   * invariant 3's INSERT catches `insufficient_privilege or others`, and that
--     is not merely "42501 has several causes" — `others` is EVERY error. A
--     revoked table GRANT, a column-level denial, a dead `auth.uid()` (one typo
--     in `request.jwt.claim.sub` and B is nobody, refused by every policy for
--     the wrong reason), a NOT NULL violation and a guard TRIGGER all land in
--     that handler — and guard triggers are how this repository refuses writes
--     in 0223, 0305, 0326 and 0331. Add one to calendar_events for an unrelated
--     rule, and invariant 3 keeps printing OK with `calendar_events_insert`'s
--     WITH CHECK loosened all the way to `true`.
--   * invariant 3's UPDATE and DELETE assert ZERO ROWS, and a row this session
--     cannot SEE reports zero just as readily as a USING clause does. That is
--     the same confusion the baseline loop in invariant 2 was added to close one
--     level up — an empty table also reads zero — except that loop runs as the
--     OWNER and so says nothing about B's session. This closes it from the
--     session's side.
--   * invariant 2's ten zero-counts share one failure mode with all of the
--     above: a session that can read NOTHING reads zero rows of family A. Leg 2
--     rules that out. It does NOT claim to cover the other nine tables' SELECT
--     policies one by one — it covers the session, which is what the ten counts
--     have in common, and several of those tables carry manager-gated
--     restrictive write policies whose read side is not this probe's subject.
--
-- EVERY LEG IS THE STATEMENT UNDER TEST WITH ONE LITERAL CHANGED. The legs use
-- the same column list, the same SET column and the same WHERE column. That
-- matters because Postgres checks column privileges against the columns a
-- statement NAMES, never against its values:
--
--   leg 1  insert into calendar_events (family_id, title, starts_at)  = invariant 3's INSERT
--   leg 2  select count(*) from calendar_events where family_id = …   = invariant 2's count, same format()
--   leg 3  update calendar_events set title = … where family_id = …   = invariant 3's UPDATE
--   leg 5  delete from notes where family_id = …                      = invariant 3's DELETE
--
-- A control that names MORE columns than the statement under test does (an `id`
-- in the INSERT) goes red on a column-level grant the invariant never trips
-- over. One that names DIFFERENT columns (renaming or deleting `where id =`
-- rather than `where family_id =`) sails past a denial the invariant then dies
-- on, as a bare `permission denied for table …`, with the attribution thrown
-- away exactly as it was before this control existed. Both of those happened to
-- this control's previous version on template copies. With table INSERT on
-- calendar_events replaced by INSERT on every column but `id`, it went
-- UNPROVEN on a healthy boundary. With table SELECT on notes replaced by
-- SELECT on every column but `family_id`, its `where id =` DELETE passed and
-- invariant 2 then died on `permission denied for table notes`. This version
-- passes the first and reports the second as UNPROVEN.
--
-- Leg 1 leaves `created_by` NULL, as the hostile INSERT does, so 0339's
-- restrictive author guard (`created_by is null or created_by = auth.uid() or
-- can_manage_family(family_id)`) is satisfied identically on both sides and
-- cannot be what differs. Leg 4, the note leg 5 deletes, has no counterpart
-- in invariant 3. It exists so that the row leg 5 must remove is one the ACTOR
-- wrote, not one seeded as the owner. (The
-- document-vault probe passed for a release while the teen could not INSERT a
-- document at all, because every row it tested was inserted before the session
-- switched.)
--
-- THE COUNTS ARE EXACT, not "at least one". Before switching, the OWNER counts
-- family B's events and notes. The session must then read every one of those
-- events plus the one leg 1 stored (leg 2), rename exactly that many (leg 3),
-- and delete every family-B note plus the one leg 4 stored (leg 5). "At least
-- one" is satisfied by the owner-seeded 'B private event' alone, which proves
-- nothing about a row the session wrote. And a session that reaches FEWER of
-- its own family's rows than the owner can is being filtered by something other
-- than is_family_member(). That is exactly what would make a zero in family A
-- unattributable.
--
-- WHO. A positive control reads its evidence out of successes, and the table
-- OWNER succeeds at everything: postgres owns both tables and bypasses RLS. So
-- a role switch that did not take would pass every leg, as the owner, and print
-- green. The refusal-based invariants fail loudly on that; this block is the
-- only place it could pass silently, so leg 0 asserts the identity before any
-- other leg runs.
--
-- NOTHING THE CONTROL WRITES SURVIVES IT. Using invariant 3's WHERE clause
-- means leg 3 renames every family-B event and leg 5 deletes every family-B
-- note. So the whole control, including the membership re-assertion, runs in
-- ONE subtransaction that the block always rolls back by raising its own
-- sentinel, once the results are in PL/pgSQL variables (a rollback does not
-- touch those). The role switch is undone along with the writes. The block
-- then re-counts as the owner, and goes red if family B's rows are not exactly
-- as it found them — so nothing here can leak into a probe that runs later
-- against the same database.
--
-- NO `grant ... to authenticated` HERE, deliberately — for the reason the block
-- above gives, and for a second one: a missing GRANT is one of the things this
-- control exists to detect, so granting it first would delete the finding,
-- rolled back or not. child-login-mapping-is-managers-only-check.sql can
-- afford its grant because it runs inside `begin; … rollback;`. This file's
-- top level has no transaction wrapper, and run-probes.sh runs every
-- docs/audit/*-check.sql in sequence against ONE database, so every probe
-- after this one sees whatever it leaves behind.

do $$
declare
  n              int;
  visible        int;
  events_before  int;
  notes_before   int;
  renamed_before int;
  events_after   int;
  notes_after    int;
  renamed_after  int;
  failures       text[] := '{}';
  fam_b          constant uuid := current_setting('a03.family_b')::uuid;
  user_b         constant uuid := current_setting('a03.user_b')::uuid;
  renamed        constant text := 'A-03 control event (renamed)';
  sentinel       constant text := 'A-03 control: rolling back everything the control wrote';
  control_ok     boolean := true;
begin
  -- As the OWNER, before anything is written: what family B already holds.
  select count(*) into events_before  from public.calendar_events where family_id = fam_b;
  select count(*) into notes_before   from public.notes           where family_id = fam_b;
  select count(*) into renamed_before from public.calendar_events where family_id = fam_b and title = renamed;

  begin
    -- B's membership of B's own family. The families insert above fired
    -- on_family_created, which files the creator as a 'parent'. Upsert rather
    -- than assume, because a seed whose membership is wrong fails the control
    -- for a reason that is not the control's, and a control that flags a
    -- healthy schema is worse than no control. It is written as the owner,
    -- inside the rolled-back subtransaction, so it does not outlive the control
    -- either.
    insert into public.family_members (family_id, user_id, display_name, role, is_active)
      values (fam_b, user_b, 'B Parent', 'parent', true)
      on conflict (family_id, user_id) do update set role = 'parent', is_active = true;

    -- The session the invariants below use: role, sub and claim role.
    perform set_config('role','authenticated', true);
    perform set_config('request.jwt.claim.sub', user_b::text, true);
    perform set_config('request.jwt.claim.role','authenticated', true);

    -- ── Leg 0: WHO — the switch took, and it is user B, not the owner ────────
    if current_user <> 'authenticated'
       or auth.uid() is distinct from user_b
       or (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: the control is running as %s with auth.uid() = %s, not as `authenticated` with user B''s uid %s — every leg below would succeed for the wrong actor (the table owner bypasses RLS), so none of them could vouch for the invariants', current_user, coalesce(auth.uid()::text, 'NULL'), user_b));
    end if;

    -- ── Leg 1: INSERT — invariant 3's INSERT, family B for family A ─────────
    if control_ok then
      begin
        insert into public.calendar_events (family_id, title, starts_at)
          values (fam_b, 'A-03 control event', now());
        get diagnostics n = row_count;
        if n <> 1 then
          control_ok := false;
          failures := array_append(failures, 'CONTROL FAILED: user B''s INSERT into calendar_events of the family B IS a member of stored 0 rows, so invariant 3''s refused INSERT would prove nothing about calendar_events_insert''s WITH CHECK');
        end if;
      exception when others then
        control_ok := false;
        failures := array_append(failures, format('CONTROL FAILED: user B was refused an INSERT into calendar_events of the family B IS a member of (%s: %s) — invariant 3 catches `others`, so this very cause would have been credited to calendar_events_insert''s WITH CHECK', sqlstate, sqlerrm));
      end;
    end if;

    -- ── Leg 2: SELECT — invariant 2's count, family B for family A ──────────
    if control_ok then
      begin
        execute format('select count(*) from public.%I where family_id = %L', 'calendar_events', fam_b) into visible;
        if visible <> events_before + 1 then
          control_ok := false;
          failures := array_append(failures, format('CONTROL FAILED: user B reads %s calendar_events rows of the family B IS a member of, where the owner counts %s plus the one leg 1 just stored — %s', visible, events_before,
            case when visible = 0 then 'a blind session, so invariant 2''s ten zero-counts measure nothing'
                 else 'something besides is_family_member() filters this session''s reads, so a zero in family A is not attributable to it' end));
        end if;
      exception when others then
        control_ok := false;
        failures := array_append(failures, format('CONTROL FAILED: user B''s SELECT of the family B IS a member of raised %s: %s, so invariant 2''s zero-counts measure a broken session rather than a boundary', sqlstate, sqlerrm));
      end;
    end if;

    -- ── Leg 3: UPDATE — invariant 3's UPDATE (SET title, WHERE family_id) ───
    if control_ok then
      begin
        update public.calendar_events set title = renamed where family_id = fam_b;
        get diagnostics n = row_count;
        if n <> events_before + 1 then
          control_ok := false;
          failures := array_append(failures, format('CONTROL FAILED: user B''s UPDATE of calendar_events.title where family_id = the family B IS a member of changed %s rows, not the %s the owner counts plus the one leg 1 stored, so invariant 3''s zero-row UPDATE would prove nothing — a row a session cannot write reports zero either way', n, events_before));
        end if;
      exception when others then
        control_ok := false;
        failures := array_append(failures, format('CONTROL FAILED: user B''s UPDATE of calendar_events.title where family_id = the family B IS a member of raised %s: %s — a column-level revoke on `title` or on `family_id` reads exactly like this, and invariant 3 would have died on it with the attribution thrown away', sqlstate, sqlerrm));
      end;
    end if;

    -- ── Leg 4: a note written by the ACTOR, for leg 5 to delete ─────────────
    if control_ok then
      begin
        insert into public.notes (family_id, title, body)
          values (fam_b, 'A-03 control note', 'control');
        get diagnostics n = row_count;
        if n <> 1 then
          control_ok := false;
          failures := array_append(failures, 'CONTROL FAILED: user B''s INSERT into notes of the family B IS a member of stored 0 rows, so the DELETE leg has nothing of the actor''s to remove');
        end if;
      exception when others then
        control_ok := false;
        failures := array_append(failures, format('CONTROL FAILED: user B was refused an INSERT into notes of the family B IS a member of (%s: %s), so nothing here can say whether notes'' policies are what refuse the family-A delete below', sqlstate, sqlerrm));
      end;
    end if;

    -- ── Leg 5: DELETE — invariant 3's DELETE (WHERE family_id) ──────────────
    if control_ok then
      begin
        delete from public.notes where family_id = fam_b;
        get diagnostics n = row_count;
        if n <> notes_before + 1 then
          control_ok := false;
          failures := array_append(failures, format('CONTROL FAILED: user B''s DELETE from notes where family_id = the family B IS a member of removed %s rows, not the %s the owner counts plus the one leg 4 stored, so invariant 3''s zero-row DELETE against family A''s notes would prove nothing', n, notes_before));
        end if;
      exception when others then
        control_ok := false;
        failures := array_append(failures, format('CONTROL FAILED: user B''s DELETE from notes where family_id = the family B IS a member of raised %s: %s — a column-level revoke on `family_id` reads exactly like this, and invariant 3 would have died on it with the attribution thrown away', sqlstate, sqlerrm));
      end;
    end if;

    raise exception '%', sentinel;
  exception when others then
    if sqlerrm is distinct from sentinel then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED outside any leg (%s: %s)', sqlstate, sqlerrm));
    end if;
  end;

  -- Back as the owner: the rollback undid the role switch with the writes.
  -- Family B must be exactly as the control found it.
  select count(*) into events_after  from public.calendar_events where family_id = fam_b;
  select count(*) into notes_after   from public.notes           where family_id = fam_b;
  select count(*) into renamed_after from public.calendar_events where family_id = fam_b and title = renamed;
  if current_user is distinct from session_user
     or events_after <> events_before or notes_after <> notes_before or renamed_after <> renamed_before then
    raise exception 'A-03 FAIL: the negative control did not roll back (running as %, session user %; family B events % -> %, notes % -> %, renamed events % -> %) — its writes would leak into every probe that runs after this one',
      current_user, session_user, events_before, events_after, notes_before, notes_after, renamed_before, renamed_after;
  end if;

  -- A failed control makes every zero row and every caught exception below
  -- unreadable. The boundary is not reported as holding and it is not reported
  -- as broken: it is reported as UNPROVEN, and the run is red either way.
  if not control_ok then
    raise exception 'A-03 UNPROVEN (the negative control the invariants below rest on did not hold): %', array_to_string(failures, ' | ');
  end if;

  raise notice 'A-03 OK (control): as `authenticated` with auth.uid() = user B, invariant 3''s own INSERT, invariant 2''s own count, and invariant 3''s own UPDATE (SET title) and DELETE (WHERE family_id) all land in the family B IS a member of, on every row the owner sees there plus the ones B wrote, and all of it was rolled back — so the refusals below are attributable to is_family_member(family_id) and not to a grant, a column denial, a dead auth.uid(), a guard trigger or the wrong actor';
end $$;

-- ── Invariant 1: every family-scoped table has RLS enabled ──────────────────
do $$
declare n int;
begin
  select count(*) into n
  from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
  join information_schema.columns col
    on col.table_schema='public' and col.table_name=c.relname and col.column_name='family_id'
  where ns.nspname='public' and c.relkind='r' and c.relrowsecurity = false;
  if n <> 0 then raise exception 'A-03 FAIL: % family-scoped table(s) have RLS DISABLED', n; end if;
  raise notice 'A-03 OK: all family-scoped tables have RLS enabled';
end $$;

-- ── Invariant 2: user B cannot READ family A ────────────────────────────────
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000f1';  -- placeholder, reset below
reset role;

-- A read probe over an EMPTY table returns 0 for the wrong reason. SEED_ALL
-- leaves `wallet_transactions` with no rows for the anchor family, so for the
-- highest-risk money table on the list this probe proved nothing at all — it
-- reported isolation it had never tested. One fixture row, written as the owner,
-- gives it something to fail on.
insert into public.wallet_transactions (family_id, type, direction, amount_cents, description)
select :'FA', 'adjustment'::wallet_txn_type, 'credit'::wallet_txn_direction, 4200, 'A-03 isolation fixture'
where not exists (
  select 1 from public.wallet_transactions
  where family_id = :'FA' and description = 'A-03 isolation fixture');

do $$
declare
  tbls text[] := array['family_members','calendar_events','wallet_transactions','notes',
                       'documents','grocery_items','family_recipes','chore_assignments',
                       'family_photos','family_messages'];
  t text; leaked int; baseline int;
begin
  -- FIRST, as the owner: every table on the list must actually hold family-A
  -- rows. Without this the loop below is satisfied by an empty table, and the
  -- probe passes hardest exactly where the data is missing — a green light that
  -- means "nothing to read", not "reading is blocked".
  foreach t in array tbls loop
    execute format('select count(*) from public.%I where family_id = %L', t, '00000000-0000-4000-8000-0000000000f1') into baseline;
    if baseline = 0 then
      raise exception 'A-03 FAIL: family A has no rows in %, so this probe cannot prove B is blocked from reading it', t;
    end if;
  end loop;

  -- THEN, as user B: none of those rows may be visible.
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2', true);
  perform set_config('request.jwt.claim.role','authenticated', true);
  -- The session the negative control proved, not a copy of it.
  if current_user <> 'authenticated' or auth.uid() is distinct from current_setting('a03.user_b')::uuid then
    raise exception 'A-03 FAIL: invariant 2 is not running as the session the negative control proved (role %, auth.uid() %)', current_user, coalesce(auth.uid()::text, 'NULL');
  end if;
  foreach t in array tbls loop
    execute format('select count(*) from public.%I where family_id = %L', t, '00000000-0000-4000-8000-0000000000f1') into leaked;
    if leaked <> 0 then raise exception 'A-03 FAIL: user B read % rows from family A table %', leaked, t; end if;
  end loop;
  raise notice 'A-03 OK: user B read 0 rows across % NON-EMPTY family-A tables', array_length(tbls,1);
  perform set_config('role','postgres', true);
end $$;

-- ── Invariant 3: user B cannot WRITE family A (WITH CHECK / USING) ───────────
do $$
declare blocked boolean := false; affected int;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2', true);
  perform set_config('request.jwt.claim.role','authenticated', true);
  -- The session the negative control proved, not a copy of it.
  if current_user <> 'authenticated' or auth.uid() is distinct from current_setting('a03.user_b')::uuid then
    raise exception 'A-03 FAIL: invariant 3 is not running as the session the negative control proved (role %, auth.uid() %)', current_user, coalesce(auth.uid()::text, 'NULL');
  end if;
  begin
    insert into public.calendar_events (family_id, title, starts_at)
    values ('00000000-0000-4000-8000-0000000000f1','HACK by B', now());
  exception when insufficient_privilege or others then blocked := true; end;
  if not blocked then raise exception 'A-03 FAIL: user B INSERTed into family A'; end if;

  update public.calendar_events set title='PWNED' where family_id='00000000-0000-4000-8000-0000000000f1';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'A-03 FAIL: user B UPDATEd % family-A rows', affected; end if;

  delete from public.notes where family_id='00000000-0000-4000-8000-0000000000f1';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'A-03 FAIL: user B DELETEd % family-A rows', affected; end if;

  raise notice 'A-03 OK: user B write attempts on family A all blocked (insert/update/delete)';
  perform set_config('role','postgres', true);
end $$;

-- ── Invariants 2 and 3, attributed: the rule that said no ───────────────────
-- The control proves the session COULD have written. This proves WHICH rule then
-- said no. It is 0339's own read-back (0339:376-404, three calendar_events
-- policies, `like '%is_family_member(family_id)%'`) extended to all eight
-- policies the header credits, plus the header's other schema claim: no other
-- policy on either table governs `authenticated` except 0339's restrictive
-- author guard, and that guard is still the text that lets a NULL created_by
-- through on both sides. It runs AFTER invariants 2 and 3, so a policy that has
-- been loosened is reported by the refusal it loosened. What it adds is the case
-- those invariants cannot see: a policy re-created on a DIFFERENT predicate that
-- still refuses user B (0297 did exactly that to "Managers manage
-- child_logins"). That keeps invariants 2 and 3 green while the attribution the
-- header and the control's notice print becomes false.
do $$
declare
  expected constant text[] := array[
    'calendar_events_select','calendar_events_insert','calendar_events_update','calendar_events_delete',
    'notes_select','notes_insert','notes_update','notes_delete'];
  guard_check constant text := '((created_by IS NULL) OR (created_by = auth.uid()) OR can_manage_family(family_id))';
  p text; tbl text; verb text; pol record; problems text[] := '{}';
begin
  foreach p in array expected loop
    tbl  := regexp_replace(p, '_(select|insert|update|delete)$', '');
    verb := upper(substring(p from '_(select|insert|update|delete)$'));
    select * into pol from pg_policies
     where schemaname = 'public' and tablename = tbl and policyname = p;
    if not found then
      problems := array_append(problems, format('%s is missing', p));
    elsif pol.permissive <> 'PERMISSIVE' or pol.cmd <> verb
       or not (pol.roles && array['public','authenticated']::name[]) then
      problems := array_append(problems, format('%s is %s %s to %s, not a PERMISSIVE %s policy that governs authenticated', p, pol.permissive, pol.cmd, pol.roles, verb));
    elsif (verb in ('SELECT','UPDATE','DELETE') and coalesce(pol.qual, '') not like '%is_family_member(family_id)%')
       or (verb in ('INSERT','UPDATE') and coalesce(pol.with_check, pol.qual, '') not like '%is_family_member(family_id)%') then
      problems := array_append(problems, format('%s no longer asks is_family_member(family_id): USING %s, WITH CHECK %s', p, coalesce(pol.qual, '<none>'), coalesce(pol.with_check, '<none>')));
    end if;
  end loop;

  for pol in
    select * from pg_policies
     where schemaname = 'public' and tablename in ('calendar_events','notes')
       and roles && array['public','authenticated']::name[]
       and policyname <> all (expected)
  loop
    if pol.tablename = 'calendar_events' and pol.policyname = 'calendar_events_author_guard'
       and pol.permissive = 'RESTRICTIVE' and pol.cmd = 'INSERT'
       and coalesce(pol.with_check, '') = guard_check then
      continue;
    end if;
    problems := array_append(problems, format('%s.%s (%s %s, USING %s, WITH CHECK %s) also governs authenticated', pol.tablename, pol.policyname, pol.permissive, pol.cmd, coalesce(pol.qual, '<none>'), coalesce(pol.with_check, '<none>')));
  end loop;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'calendar_events'
                  and policyname = 'calendar_events_author_guard') then
    problems := array_append(problems, 'calendar_events_author_guard (0339) is missing, so the header''s account of this table is stale');
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'A-03 FAIL: the refusals above are no longer attributable to is_family_member(family_id) alone — re-read the header before trusting invariants 2 and 3: %', array_to_string(problems, ' | ');
  end if;
  raise notice 'A-03 OK: calendar_events_{select,insert,update,delete} and notes_{select,insert,update,delete} all ask is_family_member(family_id), and the only other policy governing authenticated on either table is 0339''s author guard, unchanged';
end $$;

-- ── Invariant 4: SECURITY DEFINER RPCs reject cross-family callers ───────────
-- SECURITY DEFINER runs as owner and bypasses RLS, so each family-taking RPC must
-- gate on public.is_family_member(p_family). Prove a representative mutation RPC
-- rejects user B acting on family A.
-- NO blanket `grant execute on all functions ... to authenticated` here.
--
-- One used to stand on this line so the call below could run as `authenticated`.
-- It was never needed — CREATE FUNCTION grants EXECUTE to PUBLIC, so
-- `authenticated` can already call this RPC. First verified on a pristine
-- 305-migration replay (has_function_privilege('authenticated', …) = true with
-- no probe run). Re-verified 2026-09-26 on a clone of the audit template, where
-- the same call on 'public.marketplace_create_circle(uuid,text,text)' is true
-- and the function's proacl is NULL. That NULL means no GRANT or REVOKE,
-- whether from a migration or from a probe, has ever touched it: the EXECUTE
-- is PUBLIC's default. No migration names it in a grant or a revoke either;
-- only 0176 and 0314 `create or replace` it.
--
-- What it DID do was undo the deliberate revokes in 0204 and 0253, and in 0292
-- (numbered 0288 when this was written), handing `authenticated` EXECUTE on
-- claim_ai_runs, claim_marketing_generation_jobs and the three loyalty RPCs —
-- the exact cross-tenant hole F-006 closed. Probes glob alphabetically, so
-- privileged-rpc-grants-check (p) ran BEFORE this file (r) and passed, and every
-- run after that saw a poisoned database. A probe suite whose answer depends on
-- what ran before it is not evidence, so the grant is gone.
do $$
declare rejected boolean := false;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2', true);
  perform set_config('request.jwt.claim.role','authenticated', true);
  -- A dead auth.uid() is "not a member" of every family, so without this the
  -- rejection below could be read out of a session that is nobody.
  if current_user <> 'authenticated' or auth.uid() is distinct from current_setting('a03.user_b')::uuid then
    raise exception 'A-03 FAIL: invariant 4 is not running as user B (role %, auth.uid() %)', current_user, coalesce(auth.uid()::text, 'NULL');
  end if;
  begin
    perform public.marketplace_create_circle('00000000-0000-4000-8000-0000000000f1','Hostile Circle');
  exception when others then
    rejected := (sqlerrm ilike '%not a member%');
  end;
  if not rejected then raise exception 'A-03 FAIL: marketplace_create_circle accepted a cross-family caller'; end if;
  raise notice 'A-03 OK: SECURITY DEFINER RPC rejected a cross-family caller';
  perform set_config('role','postgres', true);
end $$;

-- ── Invariant 5: provisioning RPCs reject cross-USER callers ────────────────
-- ensure_family_for_user / onboarding_claim_family provision or claim a family
-- for p_user_id; they must reject any caller whose auth.uid() != p_user_id
-- (except service_role), or one user could seize another's family.
-- A caller can be turned away two ways, and BOTH are a pass:
--   * the function runs and raises its own 'not authorized', or
--   * Postgres refuses the call outright — 42501, because EXECUTE is revoked
--     from `authenticated` and from PUBLIC, which is the stronger boundary.
-- Matching only the first is what let this invariant look meaningful while the
-- blanket grant that used to sit above was quietly restoring EXECUTE: remove the
-- grant and the real answer is 42501. What must never happen is the call
-- SUCCEEDING, so that is what this now distinguishes.
do $$
declare a boolean := false; b boolean := false;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2', true);
  perform set_config('request.jwt.claim.role','authenticated', true);
  -- A dead auth.uid() differs from every p_user_id, so without this 'not
  -- authorized' could be read out of a session that is nobody.
  if current_user <> 'authenticated' or auth.uid() is distinct from current_setting('a03.user_b')::uuid then
    raise exception 'A-03 FAIL: invariant 5 is not running as user B (role %, auth.uid() %)', current_user, coalesce(auth.uid()::text, 'NULL');
  end if;
  begin perform public.ensure_family_for_user('00000000-0000-4000-8000-000000000001','Stolen');
  exception when others then a := (sqlerrm ilike '%not authorized%' or sqlstate = '42501'); end;
  begin perform public.onboarding_claim_family('00000000-0000-4000-8000-000000000001','Stolen','UTC');
  exception when others then b := (sqlerrm ilike '%not authorized%' or sqlstate = '42501'); end;
  if not (a and b) then raise exception 'A-03 FAIL: a provisioning RPC accepted a cross-user caller (ensure=%, claim=%)', a, b; end if;
  raise notice 'A-03 OK: provisioning RPCs reject cross-user callers (in-function check or 42501)';
  perform set_config('role','postgres', true);
end $$;

select 'A-03 tenant-isolation probe: ALL INVARIANTS PASSED' as result;
