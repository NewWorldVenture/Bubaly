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
-- NEGATIVE CONTROL, and it runs FIRST, before any of the four
-- ---------------------------------------------------------------------------
-- The rule under test today is 0297's, not 0105's: `0297_sensitive_tables_
-- respect_role.sql` dropped the FOR ALL policy that was named "Managers manage
-- child_logins" and gated on `is_family_member`, and re-created it under the
-- same name on `can_manage_family(family_id)` — USING and WITH CHECK, one
-- question on both sides. Nothing after 0297 touches this table's policies.
--
-- One question is all the boundary is, so the control is the same child, the
-- same policy and the same three verbs in a SECOND family where that child IS
-- a manager: the same actor through the same predicate with the answer the
-- other way, which must land. Without it the four checks above are refusals
-- with no attribution:
--
--   * 1's INSERT catches `insufficient_privilege` and credits the WITH CHECK,
--     but a missing or revoked table GRANT, a column denial and a dead
--     `auth.uid()` all raise 42501 too — and so does a guard trigger, which is
--     how this repository refuses writes in 0223, 0305, 0326 and 0331. Add one
--     of those to child_logins for an unrelated rule and this check would keep
--     passing with the WITH CHECK loosened back to `is_family_member`, which
--     is the exact S-01 regression note 4 exists to catch;
--   * 1's UPDATE and DELETE assert ZERO ROWS, and a row this session simply
--     cannot see produces zero rows just as readily as a USING clause does.
--
-- The control's UPDATE names the SAME COLUMNS the takeover does — `user_id`
-- as well as `username` — and that is not decoration. A column-level
-- `revoke update (user_id) on child_logins from authenticated` sails straight
-- past a control that only renames, and then kills the unguarded takeover
-- below as a bare `permission denied for table child_logins`: red, but with
-- the attribution thrown away exactly as it was before this control existed.
-- Postgres checks column privileges against the SET list and not against the
-- values, so repointing the control's own row at UV — the mirror of the
-- takeover, in the family the child DOES manage — is the whole of that proof.
--
-- The parent's positive control in 2 does not cover either: it proves the
-- guard lets SOMEBODY through, not that the CHILD's session could have written
-- anything at all. Every row the child is tested against here is inserted
-- before the session switches — which is precisely how the document-vault
-- probe passed for a release while the teen could not INSERT a document at all.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/child-login-mapping-is-managers-only-check.sql

\set FC '00000000-0000-4000-8000-0000000000c1'
\set UP '00000000-0000-4000-8000-0000000000c2'
\set UK '00000000-0000-4000-8000-0000000000c3'
\set US '00000000-0000-4000-8000-0000000000c4'
\set UT '00000000-0000-4000-8000-0000000000c8'
-- The control household: a second family the SAME child manages.
\set FD '00000000-0000-4000-8000-0000000000ca'
\set UW '00000000-0000-4000-8000-0000000000cb'
\set MW '00000000-0000-4000-8000-0000000000cc'
-- The control repoints its own row at UV, so the control exercises `user_id`
-- — the column the takeover writes — and not only `username`.
\set UV '00000000-0000-4000-8000-0000000000cf'

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

-- ── The negative control's own household ────────────────────────────────────
-- FD is a family the kid created, so `can_manage_family(FD)` answers yes for
-- the very user `can_manage_family(FC)` answers no for. MW is a ward of that
-- house with no login yet, so the control has a member of its own and cannot
-- collide with the sibling's row, the planted row or the parent's third-login.
insert into auth.users (id, email) values (:'UW','c-ward@example.com')  on conflict do nothing;
insert into auth.users (id, email) values (:'UV','c-ward2@example.com') on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FD','Kid''s Own House',:'UK') on conflict do nothing;
-- on_family_created files the creator as a 'parent' already; upsert rather than
-- assume, for the same reason the FC seed re-asserts UP's role — a seed whose
-- roles are wrong would fail the control for a reason that is not the control's.
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-0000000000ce',:'FD',:'UK','Kid (a manager here)','parent',true)
  on conflict (family_id, user_id) do update set role = 'parent', is_active = true;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values (:'MW',:'FD',:'UW','Ward','child',true) on conflict do nothing;

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
  ctl_fam   constant uuid := '00000000-0000-4000-8000-0000000000ca';
  ctl_u     constant uuid := '00000000-0000-4000-8000-0000000000cb';
  ctl_u2    constant uuid := '00000000-0000-4000-8000-0000000000cf';
  ctl_m     constant uuid := '00000000-0000-4000-8000-0000000000cc';
  ctl_row   constant uuid := '00000000-0000-4000-8000-0000000000cd';
  control_ok boolean := true;
begin
  -- ── As the child ────────────────────────────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- ── NEGATIVE CONTROL: the same child, the same policy, the other answer ──
  -- INSERT, UPDATE and DELETE a login mapping in the family this child DOES
  -- manage. All three must land. If any does not, this session never had the
  -- access the refusals below are supposed to be measuring, and the probe says
  -- so instead of reporting a boundary it cannot see.
  begin
    insert into public.child_logins (id, family_id, member_id, user_id, username, created_by)
      values (ctl_row, ctl_fam, ctl_m, ctl_u, 'ward-of-the-kid', kid_u);
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      failures := array_append(failures, 'CONTROL FAILED: this child''s INSERT of a login mapping in the family they DO manage stored 0 rows, so a refusal below would prove nothing about the manager gate');
    end if;
  exception when others then
    control_ok := false;
    failures := array_append(failures, format('CONTROL FAILED: this child was refused a login mapping in the family they DO manage (%s: %s), so a refusal below would prove nothing about the manager gate — it would prove only that something said no', sqlstate, sqlerrm));
  end;

  if control_ok then
    begin
      -- The same two columns the takeover writes: `user_id` first, because a
      -- column-level denial on it is invisible to a rename-only control.
      update public.child_logins set user_id = ctl_u2, username = 'ward-of-the-kid-renamed'
        where id = ctl_row;
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        failures := array_append(failures, 'CONTROL FAILED: this child''s UPDATE of a login mapping they DO manage — repointing user_id, the very column the takeover writes — changed 0 rows, so the zero-row refusals below would prove nothing: a row this session cannot write reports zero either way');
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: this child''s UPDATE of a login mapping they DO manage (repointing user_id, the column the takeover writes) raised %s: %s', sqlstate, sqlerrm));
    end;
  end if;

  if control_ok then
    begin
      delete from public.child_logins where id = ctl_row;
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        failures := array_append(failures, 'CONTROL FAILED: this child''s DELETE of a login mapping they DO manage removed 0 rows, so the zero-row refusal of the sibling delete below would prove nothing');
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: this child''s DELETE of a login mapping they DO manage raised %s: %s', sqlstate, sqlerrm));
    end;
  end if;

  -- The control's row does not outlive the control. Its own DELETE is the third
  -- leg above, so this only matters on the paths where that leg did not run;
  -- it is unconditional anyway, because a stray row in a second family is
  -- exactly the quiet contamination that turns one unattributed check into one
  -- false failure later. The two unique indexes (member_id, user_id) and the
  -- username index are the counts most at risk.
  perform set_config('role','postgres', true);
  delete from public.child_logins where id = ctl_row;
  perform set_config('role','authenticated', true);

  -- A failed control makes every refusal below unreadable, and the statements
  -- below are deliberately unguarded — a revoked UPDATE or DELETE privilege
  -- would abort the block there and bury the diagnosis under a raw "permission
  -- denied for table child_logins". Say WHY the probe cannot speak, here, while
  -- the reason is still in hand. The boundary is not reported as holding and
  -- it is not reported as broken: it is reported as unproven, and the build is
  -- red either way.
  if not control_ok then
    raise exception 'child login mapping boundary UNPROVEN (the control this probe rests on did not hold): %', array_to_string(failures, ' | ');
  end if;

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
  raise notice 'OK child_logins: the same child CAN write a login mapping in the family they manage (control), and in the family they do not they cannot repoint, delete or plant one; a parent can; reads stay open';
end $$;

rollback;
