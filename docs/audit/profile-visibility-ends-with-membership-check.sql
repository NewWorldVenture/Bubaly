-- Removing a member ends their profile's visibility to the family. (PRIV-002, migration 0336)
--
-- `profiles_select_self` shows co-members' profiles to each other. It did not
-- check `is_active`, and a removed member's row is kept (inactive) and still
-- visible to the family, so the family kept reading the removed person's
-- profile — including the phone number they changed to after leaving.
--
--   the family reads a removed member's profile                  -> REFUSED
--   ... after the removed member changes their phone              -> REFUSED
--   a removed member reads the family's profiles                  -> REFUSED
--   active co-members read each other's profiles                  -> allowed (control)
--   a removed member still shares ANOTHER family with the reader  -> allowed (control)
--   everyone reads their own profile, in a family or not          -> allowed (control)
--
-- Rolled back: nothing here should outlive the assertion.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

do $probe$
declare
  parent   uuid := '00000000-0000-4000-8000-00000000e901';
  removed  uuid := '00000000-0000-4000-8000-00000000e902';
  cousin   uuid := '00000000-0000-4000-8000-00000000e903';
  loner    uuid := '00000000-0000-4000-8000-00000000e904';
  fam      uuid := '00000000-0000-4000-8000-00000000e911';
  other    uuid := '00000000-0000-4000-8000-00000000e912';
  n        int;
  failures int := 0;
begin
  insert into auth.users (id, email) values
    (parent, 'vis-parent@example.test'), (removed, 'vis-removed@example.test'),
    (cousin, 'vis-cousin@example.test'), (loner, 'vis-loner@example.test')
  on conflict (id) do nothing;
  insert into public.profiles (id, email, full_name, phone) values
    (parent, 'vis-parent@example.test', 'Parent', '+15550201'),
    (removed, 'vis-removed@example.test', 'Removed', '+15550202'),
    (cousin, 'vis-cousin@example.test', 'Cousin', '+15550203'),
    (loner, 'vis-loner@example.test', 'Loner', '+15550204')
  on conflict (id) do update set phone = excluded.phone;
  insert into public.families (id, name, created_by) values (fam, 'Family', parent), (other, 'Other', cousin)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, parent, 'Parent', 'parent', true),
    (fam, removed, 'Removed', 'adult', true),
    (fam, cousin, 'Cousin', 'adult', true),
    (other, cousin, 'Cousin', 'parent', true),
    (other, removed, 'Removed', 'adult', true)
  on conflict (family_id, user_id) do update set is_active = excluded.is_active, role = excluded.role;

  -- ── CONTROL: while everyone is active, co-members see each other ─────────
  perform set_config('request.jwt.claims', json_build_object('sub', parent::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.profiles where id = removed;
  reset role;
  if n <> 1 then raise exception 'CONTROL FAILED: an active co-member''s profile is not visible to the family (got %)', n; end if;

  -- Remove them from `fam` only, then they change their phone.
  update public.family_members set is_active = false where family_id = fam and user_id = removed;
  update public.profiles set phone = '+15550299' where id = removed;

  -- ── 1. the family reads the removed member's profile ─────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', parent::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.profiles where id = removed;
  reset role;
  if n <> 0 then
    raise warning 'BREACH: the family still reads a removed member''s profile, new phone included';
    failures := failures + 1;
  end if;

  -- ── 2. the removed member reads the family's profiles ────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', removed::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.profiles where id = parent;
  reset role;
  if n <> 0 then
    raise warning 'BREACH: a removed member still reads the family''s profiles';
    failures := failures + 1;
  end if;

  -- ── CONTROL: a family they still share keeps them visible ────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', cousin::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.profiles where id = removed;
  reset role;
  if n <> 1 then raise exception 'CONTROL FAILED: a member of another shared family lost sight of the removed member (got %)', n; end if;

  -- ── CONTROL: everyone reads their own profile ────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', loner::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.profiles where id = loner;
  reset role;
  if n <> 1 then raise exception 'CONTROL FAILED: a user with no family cannot read their own profile'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', removed::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.profiles where id = removed;
  reset role;
  if n <> 1 then raise exception 'CONTROL FAILED: a removed member cannot read their own profile'; end if;

  if failures > 0 then
    raise exception 'BREACH: % way(s) a profile stays visible after removal', failures;
  end if;
  raise notice 'OK: a profile is visible to active co-members only, and always to its owner.';
end
$probe$;

rollback;
