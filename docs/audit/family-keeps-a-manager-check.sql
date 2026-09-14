-- A-20: a family can never be left with nobody able to manage it.
--
-- can_manage_family() is the USING and WITH CHECK clause of fm_update, fm_insert
-- and fm_delete. If a family's last parent/adult is demoted, deactivated or
-- removed, all three evaluate false for everyone and the household is locked out
-- with no path back from inside the product. 0299 installs the trigger; this
-- proves it behaviourally, and proves it does not break the two things a naive
-- version of it would: removing an ordinary member, and deleting a family.
\set ON_ERROR_STOP on

begin;

insert into public.families (id, name)
values ('00000000-0000-4000-8000-00000000fa99', 'A-20 probe');

insert into public.family_members (id, family_id, display_name, role, is_active) values
  ('00000000-0000-4000-8000-00000000fb01', '00000000-0000-4000-8000-00000000fa99', 'Sole Parent', 'parent', true),
  ('00000000-0000-4000-8000-00000000fb02', '00000000-0000-4000-8000-00000000fa99', 'Child',       'child',  true);

do $$
declare v_locked_out int;
begin
  -- 1. The three ways the last manager can stop being one.
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

  -- The family still has someone who can manage it.
  select count(*) into v_locked_out from public.family_members
   where family_id = '00000000-0000-4000-8000-00000000fa99'
     and role in ('parent','adult') and is_active;
  if v_locked_out = 0 then
    raise exception 'A-20 FAIL: the family ended with no manager';
  end if;
  raise notice 'A-20 OK: the last manager cannot be demoted, deactivated or deleted';

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
