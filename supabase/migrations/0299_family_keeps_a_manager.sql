-- ── A family with members must always have someone who can administer it ─────
--
-- can_manage_family() is the USING *and* WITH CHECK clause of fm_update,
-- fm_insert and fm_delete (0004_rls.sql). It is true only for a member whose
-- role is parent/adult and who is_active. So the moment a family's last such
-- member stops being one, every one of those policies evaluates false for
-- everybody: nobody can promote anyone, add anyone, or reactivate anyone. There
-- is no unwind from inside the product.
--
-- Reaching that state took two clicks. The Family screen rendered its
-- Edit/Remove menu for every member including the signed-in one, its role
-- <Select> offers all six roles including 'child', and both actions are direct
-- browser PostgREST writes. A sole parent could set their own role to 'child',
-- or deactivate themselves, and lock the household out permanently.
--
-- The screen is fixed alongside this, but the screen cannot BE the guard:
-- these are direct PostgREST writes, so anything holding a JWT can issue them
-- whatever the UI renders. The invariant belongs in the database.
--
-- ── Why this is DEFERRABLE INITIALLY DEFERRED, and not a plain row trigger ──
--
-- The invariant is about a family's END state, not about each row on the way
-- there. A per-row BEFORE trigger fires on intermediate states and refuses
-- perfectly legitimate transactions:
--
--   * teardown — `delete from family_members where family_id = X;` removes the
--     sole parent while a child row is still present, even though the statement
--     removes everyone. Two existing boundary probes do exactly this, and the
--     first version of this migration broke both.
--   * swapping managers — promote the new one and demote the old one in one
--     transaction, in that order or the other.
--
-- Deferring to COMMIT checks what actually matters and allows both. The
-- condition is deliberately "members but no manager": a family with NO active
-- members has nobody to lock out, so it is not a violation.

create or replace function public.family_keeps_a_manager()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_family uuid := coalesce(old.family_id, new.family_id);
  v_members int;
  v_managers int;
begin
  -- The family itself is gone (its delete cascaded here). Nothing to protect.
  if not exists (select 1 from public.families where id = v_family) then
    return null;
  end if;

  select
    count(*) filter (where is_active),
    count(*) filter (where is_active and role in ('parent', 'adult'))
  into v_members, v_managers
  from public.family_members
  where family_id = v_family;

  -- No active members at all: an empty family locks nobody out.
  if v_members = 0 then
    return null;
  end if;

  if v_managers = 0 then
    raise exception
      'A family must keep at least one active parent or adult, otherwise nobody can manage it. Add or promote another member first.'
      using errcode = 'check_violation';
  end if;

  return null;
end;
$function$;

revoke all on function public.family_keeps_a_manager() from public, anon, authenticated, service_role;

drop trigger if exists trg_family_keeps_a_manager on public.family_members;
create constraint trigger trg_family_keeps_a_manager
  after insert or update or delete on public.family_members
  deferrable initially deferred
  for each row execute function public.family_keeps_a_manager();

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_family_keeps_a_manager'
      and tgrelid = 'public.family_members'::regclass
      and tgdeferrable
      and tginitdeferred
  ) then
    raise exception '0299 did not install trg_family_keeps_a_manager as a deferred constraint trigger';
  end if;
end $$;
