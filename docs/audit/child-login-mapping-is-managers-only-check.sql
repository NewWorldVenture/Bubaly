-- ── S-03 A child cannot repoint, plant or delete a login mapping ─────────────
--
-- `child_logins` maps a child's public login handle to their synthetic auth
-- user. Before 0299 its only write policy was named "Managers manage
-- child_logins" and predicated on `is_family_member(family_id)` — so every
-- member of the household, a child included, could INSERT, UPDATE and DELETE
-- any row in it.
--
-- Two consequences. A child could DELETE a sibling's row, which leaves the
-- sibling's auth user with no username resolving to it: a permanent lockout with
-- no recovery in the UI. And a child could UPDATE `user_id`, which
-- `resetChildPinAction` reads and hands to `auth.admin.updateUserById` under the
-- service role — so a child points their row at a PARENT, asks that parent to
-- reset their PIN, and the parent's password becomes a value the child chose.
--
-- Proves the write half behaviourally, in both directions:
--
--   1. a child cannot UPDATE, DELETE or INSERT a login mapping;
--   2. a parent still can (a guard that refuses everyone is not a boundary);
--   3. a child CAN still read — recorded, not asserted as a defect: a username
--      is a handle the family shares and the kid surface displays it. If that
--      ever changes, this line fails and the decision gets revisited on purpose;
--   4. the write policy pins `family_id` on BOTH sides. S-01 was a policy whose
--      USING was a disjunction and whose WITH CHECK was missing, which let a
--      caller move a row into a scope they did not hold; a missing WITH CHECK
--      here would let a manager of family A repoint a row into family B.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/child-login-mapping-is-managers-only-check.sql

\set FC '00000000-0000-4000-8000-0000000000c1'
\set UP '00000000-0000-4000-8000-0000000000c2'
\set UK '00000000-0000-4000-8000-0000000000c3'
\set US '00000000-0000-4000-8000-0000000000c4'
\set UT '00000000-0000-4000-8000-0000000000c8'

begin;

insert into auth.users (id, email) values (:'UP','c-parent@example.com')  on conflict do nothing;
insert into auth.users (id, email) values (:'UK','c-kid@example.com')     on conflict do nothing;
insert into auth.users (id, email) values (:'US','c-sibling@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UT','c-third@example.com')   on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FC','Login House',:'UP') on conflict do nothing;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-0000000000c5',:'FC',:'UK','Kid','child',true) on conflict do nothing;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-0000000000c6',:'FC',:'US','Sibling','child',true) on conflict do nothing;
-- A third member with no login yet, so the PARENT's positive-control INSERT has
-- a member of its own. It used to reuse the child's, which collided with the
-- row the child plants in the permissive case — see the note on unique_violation
-- below.
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-0000000000c9',:'FC',:'UT','Third','child',true) on conflict do nothing;
-- The creator is provisioned as a manager by on_family_created; make sure of it
-- rather than assuming, because a seed whose roles are wrong proves nothing.
update public.family_members set role = 'parent' where family_id = :'FC' and user_id = :'UP';

insert into public.child_logins (id, family_id, member_id, user_id, username, created_by)
  values ('00000000-0000-4000-8000-0000000000c7', :'FC','00000000-0000-4000-8000-0000000000c6',:'US','sibling',:'UP');

grant select, insert, update, delete on public.child_logins to authenticated;

do $$
declare
  n int;
  failures text[] := '{}';
  fam       constant uuid := '00000000-0000-4000-8000-0000000000c1';
  parent_u  constant uuid := '00000000-0000-4000-8000-0000000000c2';
  kid_u     constant uuid := '00000000-0000-4000-8000-0000000000c3';
  kid_m     constant uuid := '00000000-0000-4000-8000-0000000000c5';
  third_m   constant uuid := '00000000-0000-4000-8000-0000000000c9';
  third_u   constant uuid := '00000000-0000-4000-8000-0000000000c8';
  row_id    constant uuid := '00000000-0000-4000-8000-0000000000c7';
begin
  -- ── As the child ────────────────────────────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- The takeover move: repoint a sibling's mapping at the parent's auth user.
  update public.child_logins set user_id = parent_u where id = row_id;
  get diagnostics n = row_count;
  if n <> 0 then
    failures := array_append(failures, format('a child REPOINTED %s login mapping(s) at another auth user — this is the reset-PIN takeover', n));
  end if;

  -- The lockout move.
  delete from public.child_logins where id = row_id;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child DELETED %s sibling login(s)', n)); end if;

  -- And planting a fresh mapping for themselves.
  -- `unique_violation` is caught alongside the success case on purpose. RLS is
  -- checked BEFORE a unique index, so an insert that reaches the constraint is an
  -- insert RLS let through — it must be reported as a breach, not swallowed. The
  -- first draft of this probe caught only insufficient_privilege, so when the
  -- negative control restored the permissive policy the block died on
  -- "duplicate key value violates unique constraint" instead of naming the
  -- boundary. Second time in this audit that a failure path nobody had run was
  -- itself wrong (Pass O's array_append was the first).
  begin
    insert into public.child_logins (family_id, member_id, user_id, username, created_by)
      values (fam, kid_m, kid_u, 'planted-by-the-child', kid_u);
    failures := array_append(failures, 'a child INSERTED a login mapping');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a child''s INSERT reached the unique index, so RLS did not refuse it');
  end;

  -- Reads stay open, deliberately. Recorded so the decision is visible.
  select count(*) into n from public.child_logins where id = row_id;
  if n = 0 then
    failures := array_append(failures, 'a child can no longer READ a login mapping — that is a change of decision; update finalaudit.md and this probe');
  end if;

  -- ── As the parent: the positive control ─────────────────────────────────
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  update public.child_logins set username = 'sibling2' where id = row_id;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, 'a PARENT could not update a login mapping — the guard refuses everyone'); end if;

  begin
    insert into public.child_logins (family_id, member_id, user_id, username, created_by)
      values (fam, third_m, third_u, 'third-login', parent_u);
  exception when insufficient_privilege then
    failures := array_append(failures, 'a PARENT could not create a login mapping');
  end;

  perform set_config('role','postgres', true);

  -- ── The write policy must pin family_id on BOTH sides ───────────────────
  select count(*) into n
  from pg_policy p join pg_class c on c.oid = p.polrelid
  join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public' and c.relname = 'child_logins'
    and p.polcmd = '*' and p.polwithcheck is null;
  if n <> 0 then
    failures := array_append(failures, format('%s FOR ALL policy on child_logins has no WITH CHECK — USING is reused as the write check, which is how S-01 let a row be moved into a scope the caller did not hold', n));
  end if;

  -- In the BREACH case two further lines follow from the delete above rather than
  -- from a second defect — the row is gone, so the read finds nothing and the
  -- parent's update matches nothing. Noted so a future reader does not chase them.
  if array_length(failures, 1) is not null then
    raise exception 'child login mapping boundary failed: %', array_to_string(failures, ' | ');
  end if;
  raise notice 'OK child_logins: a child cannot repoint, delete or plant a login mapping, a parent can, and reads stay open';
end $$;

rollback;
