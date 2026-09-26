-- A-20: a family can never be left with nobody able to manage it.
--
-- can_manage_family() is the whole predicate of fm_insert (WITH CHECK),
-- fm_update (USING and WITH CHECK) and fm_delete (USING), and it is true only
-- for an active member whose role is parent or adult. If a family's last
-- parent/adult is demoted to any other role, deactivated or removed, all three
-- evaluate false for everyone and the household is locked out with no path
-- back from inside the product. 0299 installs the trigger; this proves it
-- behaviourally, and proves it does not break the two things a naive version
-- of it would: removing an ordinary member, and deleting a family.
--
-- ── NEGATIVE CONTROL, and it runs FIRST, before the refusals ────────────────
--
-- MECHANISM: a TRIGGER, not RLS, and here is how that was established.
-- `grep -rl 'family_keeps_a_manager' supabase/migrations` returns exactly ONE
-- file — 0299_family_keeps_a_manager.sql — so 0299 is not merely the first
-- migration to create this guard, it is the last: nothing after it mentions
-- either the function or the trigger name. 0299 `create or replace`s
-- public.family_keeps_a_manager(), then `drop trigger if exists` /
-- `create constraint trigger trg_family_keeps_a_manager ... deferrable
-- initially deferred` on public.family_members, and ends by asserting in
-- pg_trigger that it did. This probe repeats that assertion and adds that the
-- trigger is enabled and still executes public.family_keeps_a_manager(),
-- because the behavioural cases cannot see all of it: `SET CONSTRAINTS ...
-- IMMEDIATE` silently accepts a same-named trigger re-created NOT DEFERRABLE
-- (only the DEFERRED form refuses a non-deferrable one), so without the
-- catalog check that drift would surface only as an unlabelled error.
--
-- The OTHER triggers on family_members. A `create (constraint )?trigger` grep
-- is not enough in this corpus: migrations routinely attach triggers from a
-- loop through `execute format(...)`, which such a grep cannot see. Counting
-- those, family_members carries three triggers, and pg_trigger on a fresh
-- replay (latest migration when this was written: 0365) lists exactly these:
--   * trg_family_keeps_a_manager — 0299, the guard under test;
--   * trg_set_updated_at — attached by `execute format` loops over every table
--     with an updated_at column (first 0003_functions_triggers.sql:87-98);
--     BEFORE UPDATE, it only stamps updated_at and never refuses;
--   * trg_mark_model_dirty — attached by the `execute format` loop at
--     0134_model_dirty.sql:47-65, whose table array starts 'family_members';
--     AFTER INSERT/UPDATE/DELETE, it upserts family_model_dirty and swallows
--     its own foreign_key_violation, so it never refuses either.
-- The one dynamic guard-trigger loop lexically after 0299 that names
-- family_members (0311_family_scoped_references.sql:111-153) names it only as
-- the PARENT of chore_assignments.member_id; its trigger goes on
-- chore_assignments. family_members has no CHECK constraint (pg_constraint:
-- pkey, two foreign keys, unique (family_id, user_id), and 0299's constraint
-- trigger). None of that inventory is what the verdict rests on — the control
-- below is, because the next migration can change the inventory — but it is
-- why the control is expected to land.
--
-- The cases below catch `check_violation` because that is the errcode 0299's
-- function raises by hand (`using errcode = 'check_violation'`).
-- RLS is NOT the mechanism: fm_insert and fm_delete (last re-created in
-- 0118_rls_drift_repair.sql:69-71 and :75-77) and fm_update (last re-created,
-- on a changed predicate, in 0211_family_members_update_rls.sql:11-14) are
-- what this trigger PROTECTS. This probe's session writes family_members with
-- no auth.uid() at all, and it is the control's own legs that measure that
-- those writes land: a leg stopped by RLS or a missing grant shows up as a
-- caught 42501 or as zero rows changed, and the probe goes red on it.
--
-- Why the refusals need a control: `check_violation` (23514) is a SHARED
-- errcode, so "a check_violation arrived" is not the same sentence as
-- "trg_family_keeps_a_manager refused it". A CHECK constraint added to
-- family_members raises 23514, and so does any guard trigger that raises
-- `using errcode = 'check_violation'` by hand — as 0306 and 0308 do on their
-- own tables, the only two migrations besides 0299 that raise it. (This
-- repository's usual hand-raised refusal is 42501 instead — 0223, 0305, 0326
-- and 0331 all raise that — and a 42501 guard is the less dangerous kind
-- here: it escapes `exception when check_violation`, so the case dies red,
-- merely unattributed. A foreign 23514 is the one that would be swallowed and
-- credited to 0299.) Add a CHECK, or a 23514-raising "nobody rewrites a
-- member's role" trigger, to family_members for some unrelated rule, and the
-- refusals below that write `role` keep passing on IT — with 0299's manager
-- count broken or deleted underneath — and nobody would know.
--
-- What catches which loosening of 0299, so no assertion is credited with a
-- catch it cannot make:
--   * the manager count dropped, or replaced by the member count: case 1's
--     demote-to-child refusal fails;
--   * `and is_active` dropped from the manager count: case 1's deactivate
--     refusal fails;
--   * the manager list widened to count teen, caregiver or guest: case 1d,
--     which demotes the sole manager to each of those. The control CANNOT
--     catch this — a widened list still lands every control leg — and before
--     1d existed nothing in this file could: FA99 holds no teen, caregiver or
--     guest, so the three original refusals all kept firing;
--   * the trigger dropped, renamed or re-created as a plain trigger: the
--     control's first SET CONSTRAINTS raises "constraint does not exist";
--     re-created NOT DEFERRABLE, disabled, or pointed at another function:
--     the pg_trigger assertion;
--   * something OTHER than 0299 refusing these writes: the control.
--
-- So the control is the same session, the same trigger and the SAME
-- STATEMENTS — set role to each non-manager role (child, teen, caregiver,
-- guest), set is_active = false, delete the row — run in a family that KEEPS a
-- second active manager: the one question the trigger keys on ("would this
-- leave a family with members and no active parent or adult?") answered the
-- other way. All of them MUST LAND. If any does not, then something other than
-- 0299 is saying no to these statements, and this probe cannot attribute the
-- refusals below to the guard it names — so it reports the boundary UNPROVEN
-- rather than OK. Not held, not broken: unproven, and the build is red either
-- way.
--
-- Two details of the control are load-bearing, not decoration:
--   * its UPDATEs name the SAME COLUMNS and VALUES as the writes under test —
--     `role` to each non-manager role, `is_active` to false — each against its
--     own pristine active parent. A control that touched some other column
--     (display_name, say) sails straight past a guard or a column-level revoke
--     aimed at `role`, and then the case below dies as an unattributed refusal
--     exactly as it would have with no control at all;
--   * its family keeps an active manager and an active member through every
--     leg, and that is not left to a hand count of the seed: after the legs
--     the control re-reads its family and requires at least one of each. Every
--     leg only takes a manager away (demote, deactivate, delete), so both
--     counts only fall from leg to leg and the end state bounds every state
--     before it. The member count matters because 0299's function returns
--     early when a family has no active members at all: a leg that landed
--     through that bypass never reached the manager count, so it would say
--     nothing about the question the refusals turn on.
--
-- Case 3 below is not this control and does not replace it: it runs AFTER the
-- refusals it would have to explain, it covers only DELETE and none of the
-- UPDATEs, and its verdict is "the guard is not too broad" rather than "these
-- refusals are the guard".
\set ON_ERROR_STOP on

begin;

insert into public.families (id, name)
values ('00000000-0000-4000-8000-00000000fa99', 'A-20 probe');

insert into public.family_members (id, family_id, display_name, role, is_active) values
  ('00000000-0000-4000-8000-00000000fb01', '00000000-0000-4000-8000-00000000fa99', 'Sole Parent', 'parent', true),
  ('00000000-0000-4000-8000-00000000fb02', '00000000-0000-4000-8000-00000000fa99', 'Child',       'child',  true);

-- ── The negative control's own household ────────────────────────────────────
-- FA9A differs from FA99 in the one respect 0299 keys on: it keeps a second
-- active manager (fb24), so `v_managers = 0` is false after every write the
-- control makes. fb25 keeps an active non-manager in the house for the reason
-- given in the header — it holds v_members above zero so the control goes
-- THROUGH the manager count rather than past it on the empty-family early
-- return. Neither is taken on trust: the control re-reads FA9A after its legs.
-- Six separate targets, each an active parent, one per leg: the refusals
-- below get their pristine row back from their own subtransaction rollback,
-- whereas the control's writes land and stay landed, which is the point of it.
-- These ids appear nowhere else in docs/audit or supabase/migrations, checked
-- before they were used — run-probes.sh runs all probes against one database.
insert into public.families (id, name)
values ('00000000-0000-4000-8000-00000000fa9a', 'A-20 control');

insert into public.family_members (id, family_id, display_name, role, is_active) values
  ('00000000-0000-4000-8000-00000000fb21', '00000000-0000-4000-8000-00000000fa9a', 'Control Demote Target',     'parent', true),
  ('00000000-0000-4000-8000-00000000fb26', '00000000-0000-4000-8000-00000000fa9a', 'Control Teen Target',       'parent', true),
  ('00000000-0000-4000-8000-00000000fb27', '00000000-0000-4000-8000-00000000fa9a', 'Control Caregiver Target',  'parent', true),
  ('00000000-0000-4000-8000-00000000fb28', '00000000-0000-4000-8000-00000000fa9a', 'Control Guest Target',      'parent', true),
  ('00000000-0000-4000-8000-00000000fb22', '00000000-0000-4000-8000-00000000fa9a', 'Control Deactivate Target', 'parent', true),
  ('00000000-0000-4000-8000-00000000fb23', '00000000-0000-4000-8000-00000000fa9a', 'Control Delete Target',     'parent', true),
  ('00000000-0000-4000-8000-00000000fb24', '00000000-0000-4000-8000-00000000fa9a', 'Control Second Manager',    'adult',  true),
  ('00000000-0000-4000-8000-00000000fb25', '00000000-0000-4000-8000-00000000fa9a', 'Control Child',             'child',  true);

do $$
declare
  v_locked_out int;
  n            int;
  ctl_failures text[] := '{}';
  v_role       text;
  v_target     uuid;
  v_members    int;
  v_managers   int;
  v_uncovered  text[];
begin
  -- ── NEGATIVE CONTROL: the same trigger, the same statements, the other
  --    answer. It runs before the refusals it gives meaning to.
  --
  -- This SET CONSTRAINTS does two jobs. It fires the seed inserts' already
  -- queued events here, unguarded, so a bad seed is reported as a bad seed
  -- rather than swallowed inside a control leg; and it puts the control in the
  -- same IMMEDIATE mode the refusals use. It is at the top level of the DO
  -- block, not inside a BEGIN/EXCEPTION, so a leg's subtransaction rollback
  -- cannot silently revert it and leave a later leg checking nothing at COMMIT
  -- — a COMMIT this probe never reaches, because it ends in ROLLBACK.
  set constraints public.trg_family_keeps_a_manager immediate;

  -- Leg 1: the same column and value as case 1's first refusal — `role` to child.
  begin
    update public.family_members set role = 'child'
      where id = '00000000-0000-4000-8000-00000000fb21';
    get diagnostics n = row_count;
    if n <> 1 then
      ctl_failures := array_append(ctl_failures,
        'CONTROL FAILED: demoting a parent to child in a family that KEEPS another active manager changed 0 rows, so the identical refusal below would prove nothing — a row this session cannot write reports nothing changed either way');
    end if;
  exception when others then
    ctl_failures := array_append(ctl_failures, format(
      'CONTROL FAILED: demoting a parent to child in a family that KEEPS another active manager was refused (%s: %s), so the identical refusal below is not attributable to trg_family_keeps_a_manager — something else on family_members is saying no to a role change', sqlstate, sqlerrm));
  end;

  -- Leg 1b: the same column and values as case 1d's refusals — `role` to every
  -- other non-manager role, each against its own pristine active parent.
  for v_role, v_target in
    select * from (values
      ('teen',      '00000000-0000-4000-8000-00000000fb26'::uuid),
      ('caregiver', '00000000-0000-4000-8000-00000000fb27'::uuid),
      ('guest',     '00000000-0000-4000-8000-00000000fb28'::uuid)) as v(r, t)
  loop
    begin
      update public.family_members set role = v_role::public.member_role
        where id = v_target;
      get diagnostics n = row_count;
      if n <> 1 then
        ctl_failures := array_append(ctl_failures, format(
          'CONTROL FAILED: demoting a parent to %s in a family that KEEPS another active manager changed %s rows, so the identical refusal below would prove nothing', v_role, n));
      end if;
    exception when others then
      ctl_failures := array_append(ctl_failures, format(
        'CONTROL FAILED: demoting a parent to %s in a family that KEEPS another active manager was refused (%s: %s), so the identical refusal below is not attributable to trg_family_keeps_a_manager — something else on family_members is saying no to a role change', v_role, sqlstate, sqlerrm));
    end;
  end loop;

  -- Leg 2: the same column as case 1's second refusal — `is_active`.
  begin
    update public.family_members set is_active = false
      where id = '00000000-0000-4000-8000-00000000fb22';
    get diagnostics n = row_count;
    if n <> 1 then
      ctl_failures := array_append(ctl_failures,
        'CONTROL FAILED: deactivating a parent in a family that KEEPS another active manager changed 0 rows, so the identical refusal below would prove nothing');
    end if;
  exception when others then
    ctl_failures := array_append(ctl_failures, format(
      'CONTROL FAILED: deactivating a parent in a family that KEEPS another active manager was refused (%s: %s), so the identical refusal below is not attributable to trg_family_keeps_a_manager — something else on family_members is saying no to an is_active change', sqlstate, sqlerrm));
  end;

  -- Leg 3: the same statement as case 1's third refusal — DELETE.
  begin
    delete from public.family_members
      where id = '00000000-0000-4000-8000-00000000fb23';
    get diagnostics n = row_count;
    if n <> 1 then
      ctl_failures := array_append(ctl_failures,
        'CONTROL FAILED: deleting a parent from a family that KEEPS another active manager removed 0 rows, so the identical refusal below would prove nothing');
    end if;
  exception when others then
    ctl_failures := array_append(ctl_failures, format(
      'CONTROL FAILED: deleting a parent from a family that KEEPS another active manager was refused (%s: %s), so the identical refusal below is not attributable to trg_family_keeps_a_manager — something else on family_members is saying no to a member delete', sqlstate, sqlerrm));
  end;

  -- The legs answered "keeps a manager" the other way — measured, not
  -- hand-counted from the seed. Every leg only takes a manager away, so both
  -- counts only fell from leg to leg, and at least one of each at the END
  -- means at least one of each after every leg: no leg landed on the
  -- empty-family early return or on the manager-less side of the question.
  select count(*) filter (where is_active),
         count(*) filter (where is_active and role in ('parent', 'adult'))
    into v_members, v_managers
    from public.family_members
   where family_id = '00000000-0000-4000-8000-00000000fa9a';
  if v_members < 1 or v_managers < 1 then
    ctl_failures := array_append(ctl_failures, format(
      'CONTROL FAILED: after its legs the control family holds %s active member(s) and %s active manager(s); it must keep at least one of each, or its landed writes did not answer "keeps a manager" the other way', v_members, v_managers));
  end if;

  -- The assertion 0299 itself makes about what it installed, plus the two
  -- things the behavioural cases cannot see: that the trigger is enabled and
  -- still runs 0299's function. It must run before the DEFERRED below, which
  -- would otherwise be the first — and unlabelled — thing to trip over a
  -- trigger re-created NOT DEFERRABLE.
  if not exists (
    select 1 from pg_trigger
     where tgname = 'trg_family_keeps_a_manager'
       and tgrelid = 'public.family_members'::regclass
       and tgconstraint <> 0
       and tgdeferrable
       and tginitdeferred
       and tgenabled in ('O', 'A')
       and tgfoid = to_regprocedure('public.family_keeps_a_manager()')
  ) then
    ctl_failures := array_append(ctl_failures,
      'trg_family_keeps_a_manager is no longer what 0299 asserts it installs — an enabled DEFERRABLE INITIALLY DEFERRED constraint trigger on public.family_members executing public.family_keeps_a_manager() — so the refusals below cannot be attributed to it');
  end if;

  -- Leg 1b and case 1d list the non-manager roles by hand. If member_role has
  -- grown a value neither they nor 0299's manager set name, "demoted to any
  -- non-manager role" stops being something this probe tests.
  select array_agg(r::text order by r::text) into v_uncovered
    from unnest(enum_range(null::public.member_role)) as r
   where r::text not in ('parent', 'adult', 'child', 'teen', 'caregiver', 'guest');
  if v_uncovered is not null then
    ctl_failures := array_append(ctl_failures, format(
      'member_role has value(s) %s that neither 0299''s manager set (parent, adult) nor this probe''s demotions cover — decide whether can_manage_family() and 0299 count them, then add them to leg 1b and case 1d', v_uncovered));
  end if;

  -- A failed control makes every refusal below unreadable, and those refusals
  -- swallow check_violation by design — so say WHY the probe cannot speak here,
  -- while the reason is still in hand, instead of printing OK over it.
  if array_length(ctl_failures, 1) is not null then
    raise exception 'A-20 UNPROVEN (what the refusals below rest on did not hold): %',
      array_to_string(ctl_failures, ' | ');
  end if;

  -- Hand the cases below the exact constraint state they ran in before this
  -- control existed: DEFERRED, as 0299 declares it. Case 1 re-arms IMMEDIATE
  -- for itself, and case 2 leaves it armed for cases 2b, 3 and 4 — so the
  -- assertions that follow are untouched by the control that now precedes them.
  set constraints public.trg_family_keeps_a_manager deferred;

  raise notice 'A-20 OK (control): demote (to child, teen, caregiver and guest), deactivate and delete all LAND in a family that keeps a second active manager, and trg_family_keeps_a_manager is the enabled deferred constraint trigger 0299 installs, so the refusals below are the manager guard and not something else on family_members';

  -- 1. The ways the last manager can stop being one: demoted (to child here,
  -- and to every other non-manager role in 1d), deactivated, or deleted.
  -- The trigger is DEFERRABLE INITIALLY DEFERRED, so it fires when the
  -- enclosing block commits. Each case therefore needs its own sub-transaction:
  -- a plpgsql BEGIN/EXCEPTION block is one, and SET CONSTRAINTS IMMEDIATE forces
  -- the check at its end rather than at the outer COMMIT.
  begin
    set constraints public.trg_family_keeps_a_manager immediate;
    update public.family_members set role = 'child'
      where id = '00000000-0000-4000-8000-00000000fb01';
    raise exception 'A-20 FAIL: the sole manager demoted themselves to child';
  exception when check_violation then null; end;

  begin
    set constraints public.trg_family_keeps_a_manager immediate;
    update public.family_members set is_active = false
      where id = '00000000-0000-4000-8000-00000000fb01';
    raise exception 'A-20 FAIL: the sole manager deactivated themselves';
  exception when check_violation then null; end;

  begin
    set constraints public.trg_family_keeps_a_manager immediate;
    delete from public.family_members
      where id = '00000000-0000-4000-8000-00000000fb01';
    raise exception 'A-20 FAIL: the sole manager was deleted';
  exception when check_violation then null; end;

  -- 1d. Child is not the only way out of the manager set. 0299 counts exactly
  --     parent and adult — the roles can_manage_family() accepts — so a sole
  --     parent who becomes teen, caregiver or guest locks the family out just
  --     as surely. Without this, 0299 widened to count 'teen' as a manager
  --     passes every other assertion in this file.
  foreach v_role in array array['teen', 'caregiver', 'guest'] loop
    begin
      set constraints public.trg_family_keeps_a_manager immediate;
      update public.family_members set role = v_role::public.member_role
        where id = '00000000-0000-4000-8000-00000000fb01';
      raise exception 'A-20 FAIL: the sole manager demoted themselves to %', v_role;
    exception when check_violation then null; end;
  end loop;

  -- The family still has someone who can manage it.
  select count(*) into v_locked_out from public.family_members
   where family_id = '00000000-0000-4000-8000-00000000fa99'
     and role in ('parent','adult') and is_active;
  if v_locked_out = 0 then
    raise exception 'A-20 FAIL: the family ended with no manager';
  end if;
  raise notice 'A-20 OK: the last manager cannot be demoted (to child, teen, caregiver or guest), deactivated or deleted';

  -- 2. The guard must not be broader than the invariant. An ordinary member is
  --    not a manager, so removing them is none of the trigger's business.
  begin
    set constraints public.trg_family_keeps_a_manager immediate;
    delete from public.family_members where id = '00000000-0000-4000-8000-00000000fb02';
  end;
  raise notice 'A-20 OK: removing a non-manager is unaffected';

  -- 2b. Tearing a family down removes every member, which passes THROUGH a state
  --     with members and no manager. A per-row trigger refuses that and breaks
  --     ordinary teardown — two existing probes do exactly this, and the first
  --     version of 0299 broke both. Deferring to commit is what allows it.
  begin
    set constraints public.trg_family_keeps_a_manager immediate;
    insert into public.family_members (id, family_id, display_name, role, is_active) values
      ('00000000-0000-4000-8000-00000000fb08', '00000000-0000-4000-8000-00000000fa99', 'Teardown Kid', 'child', true);
    delete from public.family_members where family_id = '00000000-0000-4000-8000-00000000fa99';
  exception when check_violation then
    raise exception 'A-20 FAIL: deleting every member of a family was refused — teardown is broken';
  end;
  raise notice 'A-20 OK: removing every member at once is allowed';

  -- restore a manager for the cases below
  insert into public.family_members (id, family_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-00000000fb01', '00000000-0000-4000-8000-00000000fa99', 'Sole Parent', 'parent', true);

  -- 3. With a second manager present, the first is free to leave.
  insert into public.family_members (id, family_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-00000000fb03', '00000000-0000-4000-8000-00000000fa99', 'Other Parent', 'adult', true);
  delete from public.family_members where id = '00000000-0000-4000-8000-00000000fb01';
  raise notice 'A-20 OK: with a second manager the first can leave';

  -- 4. Deleting the FAMILY cascades to its members, last manager included.
  --    A trigger that blocked this would turn "close my account" into a
  --    permanent error — the single most likely way to get this fix wrong.
  delete from public.families where id = '00000000-0000-4000-8000-00000000fa99';
  if exists (select 1 from public.family_members
             where family_id = '00000000-0000-4000-8000-00000000fa99') then
    raise exception 'A-20 FAIL: family delete did not cascade to its members';
  end if;
  raise notice 'A-20 OK: deleting a family still cascades its last manager';
end $$;

rollback;
