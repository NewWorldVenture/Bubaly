-- ── A-17 A restriction may not be removable by the person it restricts ───────
--
-- social_access_permissions OVERRIDES the social role a member would otherwise
-- get from their household role (lib/social/access.ts: "an explicit row wins").
-- The defaults are parent -> admin, adult -> marketing_manager,
-- teen -> content_creator, everyone else -> read_only, so an override is how a
-- parent holds someone BELOW their default.
--
-- 0034 required admin (or manage_access) to create or change such a row, but
-- allowed any family member to DELETE one — and deleting restores the higher
-- default. 0319_social_access_delete_matches_grant.sql makes delete match.
-- (An earlier revision of this header credited "0296"; 0296 is
-- family_credentials_manager_only and never names this table.) This proves it
-- behaviourally, and proves it can still see the old state.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/social-access-symmetry-check.sql

\set FS '00000000-0000-4000-8000-000000005a01'
\set UP '00000000-0000-4000-8000-000000005a02'
\set UA '00000000-0000-4000-8000-000000005a03'
-- The negative control's household: a SECOND family in which the very same
-- restricted adult (UA) is filed as a 'parent', so `is_family_admin(family_id)`
-- answers yes for the user it answers no for in FS. No new auth user is needed —
-- that is the point: same actor, same predicate, other answer.
\set FT '00000000-0000-4000-8000-000000005a04'

-- Seed: one family, its parent, and an adult the parent has pinned to read_only.
insert into auth.users (id, email) values (:'UP','c-parent@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UA','c-adult@example.com')  on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FS','Symmetry House',:'UP') on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FS',:'UP','Parent','parent',true) on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FS',:'UA','Adult','adult',true) on conflict do nothing;
insert into public.social_access_permissions (family_id, user_id, social_role, status, granted_by)
  values (:'FS',:'UA','read_only','active',:'UP') on conflict (family_id, user_id) do update set social_role = 'read_only', status = 'active';

-- No GRANT here, deliberately. `authenticated` holds its privileges on this
-- table from the default privileges a hosted Supabase project ships — `alter
-- default privileges in schema public grant all on tables to anon,
-- authenticated, service_role` — which docs/audit/pg-bootstrap.sh reproduces
-- BEFORE the first migration runs, and no migration grants or revokes this
-- table by name. An earlier revision of this probe re-granted
-- SELECT/INSERT/UPDATE/DELETE to authenticated at this point, as the owner.
-- That erased a revoke — in a migration, or planted as a decoy — before either
-- the control or the invariant could meet it: with the grant line in place,
-- `revoke delete on public.social_access_permissions from authenticated` and
-- then this file exited 0 and printed "not a grant". The negative control below
-- is the assertion that the grant is in place; granting it here made that
-- assertion unfalsifiable.

-- ── NEGATIVE CONTROL, and it runs FIRST, before the refusal it gives meaning to
--
-- WHICH RULE IS ACTUALLY UNDER TEST. 0319, not 0034.
-- `grep -rl social_access_permissions supabase/migrations` returns three files:
--
--   * 0034_social_command_center.sql creates the table and, in a format() loop
--     over a fixed list of social_* tables, its four policies. The literal name
--     `social_access_permissions_delete` therefore appears nowhere in 0034 —
--     the loop builds it as `%1$s_delete` and puts it on
--     `is_family_member(family_id)`. (So `grep -rl
--     social_access_permissions_delete supabase/migrations` returns ONE file,
--     0319, not two.)
--   * 0319_social_access_delete_matches_grant.sql drops that policy by name and
--     re-creates it, `to authenticated`, on
--
--       public.is_family_admin(family_id)
--         or public.social_has_permission(family_id, 'manage_access')
--
--   * AUTHZ-011's pending migration ("a child cannot lift the publish lock or
--     link a document they cannot read", not yet landed when this was written)
--     names the table only in a comment describing how social_has_permission
--     resolves a role; it changes nothing here.
--
-- The only catalog loops over `social\_%` in the whole migration set are the
-- two inside 0034 (its updated_at triggers and its RLS enable), and nothing
-- after 0319 touches this table, its policies or its grants — so 0319 is the
-- governing migration and that disjunction is the predicate under test. A block
-- at the end asserts the live delete policy still carries both of its legs.
--
-- MECHANISM: an RLS policy. The table carries exactly one non-internal trigger,
-- `trg_set_updated_at`, attached by 0034's `for t in … column_name =
-- 'updated_at' and table_name like 'social\_%'` loop (0034:692-704). It is
-- BEFORE UPDATE, and a BEFORE UPDATE trigger cannot fire on a DELETE.
-- `social_write_audit` sits on the account, post and result tables and not on
-- this one. Not a CHECK or a unique index either: beyond its foreign keys the
-- table has a primary key on `id` and `unique (family_id, user_id)`, and a
-- DELETE cannot violate either. So the refusal below, if it is real, can only
-- be the USING clause of `social_access_permissions_delete`. The trigger
-- inventory is asserted rather than assumed, right after the control.
--
-- THE CONTROL. `is_family_admin(p_family_id)` is `role = 'parent' and is_active`
-- (0003), so the same adult, in a second family where they are filed as a
-- parent, gets the OTHER answer from the SAME predicate. FT is that family. The
-- row it deletes is shaped identically to the row under test — an ACTIVE
-- `read_only` override on the acting user's own user_id — and the statement is
-- the one below character for character apart from the family UUID. Exactly one
-- thing changes: the actor's household role in the family the row names, which
-- is the only thing the predicate reads. That delete MUST LAND.
--
-- WHAT IT WOULD CATCH — and what it would not. Without it the invariant below
-- is a bare zero-row count, and zero rows is not attribution. The ways that
-- count reads zero for a reason other than the predicate come in two kinds:
--
--   * LOUD BUT UNATTRIBUTED. A table GRANT revoked or never re-asserted, a
--     column privilege denied, and a guard TRIGGER of the kind this repository
--     uses to refuse writes in 0223, 0305, 0326 and 0331 all RAISE. The
--     invariant's DO block has no exception handler and run-probes.sh runs
--     under ON_ERROR_STOP=1, so each of these was always a red build — but a
--     red that read like a breach. The control meets the same refusal first,
--     catches it, and names it UNPROVEN.
--   * SILENT. Two things make the invariant read zero without raising: a dead
--     `auth.uid()` (a mistyped claim name resolves to null, every helper
--     answers false, and the SELECT policy hides every row), and a BEFORE
--     DELETE trigger that returns NULL, which skips the row without a word.
--     The control catches the first — a null uid fails `is_family_admin` in FT
--     exactly as in FS, so it removes 0 rows and raises. The trigger inventory
--     block catches the second.
--
-- What the control does NOT catch is a SELECT policy narrowed to a predicate
-- that still admits admins — `is_family_admin(family_id) or
-- social_has_permission(family_id,'manage_access')`, the shape "make select
-- match the write verbs" pushes toward. UA is a parent in FT, so the FT row
-- stays visible and the control lands 1 row, while the FS row goes invisible
-- and the invariant reads 0 with the delete policy loosened all the way back to
-- `is_family_member`. That hole is structural: the control's permitting
-- mechanism IS the first leg of the predicate, so no second family can see past
-- a narrowing that shares that leg. It is closed by a different assertion, not a
-- different family — the invariant block first asserts, as UA, that the row it
-- is about to fail to delete is VISIBLE to UA (`count(*) = 1` on the same two
-- columns), and only then counts what the delete removed. (The SELECT policy
-- governs that DELETE because its WHERE reads the existing row, not because of
-- `returning 1`; per CREATE POLICY, SELECT policies apply to any DELETE that
-- needs read access to the rows.)
--
-- The control's WHERE names the same two columns as the invariant's. With
-- table-level privileges in force, as they are here, that costs nothing and
-- buys nothing: a column-level revoke has no effect while the role holds the
-- privilege at table level, so `revoke select (user_id) … from authenticated`
-- cannot silence the invariant on this database. It matters only if the grants
-- are ever moved to column level, at which point the control still fails
-- wherever the invariant would.
--
-- The parent's positive control further down does not cover any of this. It
-- proves the policy lets SOMEBODY through; it says nothing about whether the
-- restricted adult's session could have deleted anything at all — which is the
-- same blind spot that let the document-vault probe pass for a release while
-- the teen could not write a document in the first place.
--
-- The control's row is the acting user's OWN override, deliberately — that is
-- the shape of the row under test. It makes the control sensitive to exactly
-- the hardening this repository keeps adding: a 0344-style BEFORE DELETE
-- trigger reading "nobody lifts their own override, parent or not" would turn
-- this control UNPROVEN while the boundary is intact. That is the honest
-- outcome — the invariant's zero would then be unattributed — and whoever
-- writes that trigger revisits this control.
--
-- It runs in its own transaction and rolls back. run-probes.sh globs every
-- probe in docs/audit and drives them through ONE database in sequence, and a
-- second family that outlived its control is the quiet contamination that turns
-- one unattributed check here into somebody else's false failure later.
begin;

insert into public.families (id, name, created_by) values (:'FT','Symmetry Annex',:'UA') on conflict do nothing;
-- handle_new_family (0257) already files a family's creator as 'parent'; assert
-- it rather than assume it, because a seed whose role is wrong would fail the
-- control for a reason that is not the control's.
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FT',:'UA','Adult (a parent in this house)','parent',true)
  on conflict (family_id, user_id) do update set role = 'parent', is_active = true;
-- The same shape as the row under test. `granted_by` only has a foreign key to
-- satisfy; the predicate never reads it. Note this override makes
-- social_has_permission(FT,'manage_access') false here exactly as it is in FS —
-- so the control turns on `is_family_admin` alone, which is the leg the
-- restricted adult fails in FS.
insert into public.social_access_permissions (family_id, user_id, social_role, status, granted_by)
  values (:'FT',:'UA','read_only','active',:'UP')
  on conflict (family_id, user_id) do update set social_role = 'read_only', status = 'active';

do $$
declare gone int;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000005a03', true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  begin
    with removed as (
      delete from public.social_access_permissions
       where family_id = '00000000-0000-4000-8000-000000005a04'
         and user_id   = '00000000-0000-4000-8000-000000005a03'
      returning 1
    ) select count(*) into gone from removed;
  exception when others then
    raise exception 'A-17 UNPROVEN: the negative control was REFUSED (%: %) — this adult could not delete an identically shaped override in the family where they ARE a parent, so the zero rows below would prove nothing about is_family_admin; a missing table GRANT, a column-level denial and a raising guard trigger all read exactly like this', sqlstate, sqlerrm;
  end;

  perform set_config('role','postgres', true);
  if gone <> 1 then
    raise exception 'A-17 UNPROVEN: the negative control removed % row(s), not 1 — the same adult could not delete an identically shaped override in the family where is_family_admin() answers yes, so the zero-row refusal below is unattributed: a dead auth.uid() or a row this session cannot see counts zero exactly as a USING clause does', gone;
  end if;
  raise notice 'A-17 OK: negative control — the same restricted adult CAN delete an identical override in the family where they are a parent, so a refusal below is not a grant, a column, a raising trigger or a dead auth.uid()';
end $$;

rollback;

-- ── Trigger inventory: nothing on this table fires on DELETE ─────────────────
-- Backs the MECHANISM paragraph at runtime instead of leaving it as prose that
-- was once wrong. tgtype bit 3 (value 8) is "fires on DELETE"; the foreign-key
-- enforcement triggers are internal and excluded. A trigger that RAISES would
-- already have stopped the control above; one that RETURNS NULL would not, and
-- would silence the invariant below by skipping the row — so this asks the
-- catalog, not the behaviour. It runs after the control so that a decoy trigger
-- is reported by the control, whose message is the one that names the cause.
do $$
declare offenders text;
begin
  select string_agg(tgname || ': ' || pg_get_triggerdef(oid), '; ') into offenders
    from pg_trigger
   where tgrelid = 'public.social_access_permissions'::regclass
     and not tgisinternal
     and (tgtype & 8) <> 0;
  if offenders is not null then
    raise exception 'A-17 UNPROVEN: a trigger now fires on DELETE for social_access_permissions (%) — a zero-row delete below can no longer be attributed to the USING clause alone; revisit the MECHANISM paragraph and the negative control', offenders;
  end if;
  raise notice 'A-17 OK: no non-internal trigger on social_access_permissions fires on DELETE, so a refusal below is the policy''s';
end $$;

-- ── Invariant: the restricted adult cannot delete their own restriction ──────
do $$
declare seen int; gone int;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000005a03', true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- The row must be VISIBLE to this session before its non-deletion means
  -- anything. A SELECT policy that hid it would make the count below zero for a
  -- reason that is not the delete policy, and the negative control cannot see
  -- that narrowing when the narrowed policy still admits admins (see above).
  -- Same two columns as the delete's WHERE, on purpose.
  select count(*) into seen
    from public.social_access_permissions
   where family_id = '00000000-0000-4000-8000-000000005a01'
     and user_id   = '00000000-0000-4000-8000-000000005a03';
  if seen <> 1 then
    raise exception 'A-17 UNPROVEN: the restricted adult''s session sees % row(s) for their own override in FS, not 1 — the SELECT policy (or auth.uid()) hides the row under test, so a zero-row delete here would be invisibility and not social_access_permissions_delete', seen;
  end if;

  with removed as (
    delete from public.social_access_permissions
     where family_id = '00000000-0000-4000-8000-000000005a01'
       and user_id   = '00000000-0000-4000-8000-000000005a03'
    returning 1
  ) select count(*) into gone from removed;

  perform set_config('role','postgres', true);
  if gone <> 0 then
    raise exception 'A-17 FAIL: a member deleted their own social restriction (% row(s)); deleting restores their higher default', gone;
  end if;
  raise notice 'A-17 OK: a restricted member can see, but cannot delete, their own social override';
end $$;

-- ── Positive control: a parent still can ─────────────────────────────────────
-- A guard that refuses everyone proves nothing about the boundary.
do $$
declare gone int;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000005a02', true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  with removed as (
    delete from public.social_access_permissions
     where family_id = '00000000-0000-4000-8000-000000005a01'
       and user_id   = '00000000-0000-4000-8000-000000005a03'
    returning 1
  ) select count(*) into gone from removed;

  perform set_config('role','postgres', true);
  if gone <> 1 then
    raise exception 'A-17 FAIL: an admin could not remove an override (% row(s)) — the policy is now too tight', gone;
  end if;
  raise notice 'A-17 OK: an admin can still remove an override (positive control)';
end $$;

-- ── The three write verbs agree ──────────────────────────────────────────────
do $$
declare ins text; upd text; del text;
begin
  select coalesce(pg_get_expr(p.polwithcheck,p.polrelid), pg_get_expr(p.polqual,p.polrelid)) into ins
    from pg_policy p join pg_class c on c.oid=p.polrelid where c.relname='social_access_permissions' and p.polcmd='a';
  select coalesce(pg_get_expr(p.polwithcheck,p.polrelid), pg_get_expr(p.polqual,p.polrelid)) into upd
    from pg_policy p join pg_class c on c.oid=p.polrelid where c.relname='social_access_permissions' and p.polcmd='w';
  select coalesce(pg_get_expr(p.polwithcheck,p.polrelid), pg_get_expr(p.polqual,p.polrelid)) into del
    from pg_policy p join pg_class c on c.oid=p.polrelid where c.relname='social_access_permissions' and p.polcmd='d';
  if del is distinct from ins or del is distinct from upd then
    raise exception 'A-17 FAIL: write verbs disagree — insert=% update=% delete=%', ins, upd, del;
  end if;
  raise notice 'A-17 OK: insert, update and delete carry the same condition';
end $$;

-- ── The predicate is 0319's, not merely self-consistent ──────────────────────
-- Three verbs that agreed on `is_family_admin(family_id)` alone, or on some new
-- helper, would pass the block above. 0319's USING is the disjunction quoted in
-- the header; assert the live delete policy still carries both legs.
do $$
declare del text;
begin
  select pg_get_expr(p.polqual, p.polrelid) into del
    from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relname = 'social_access_permissions' and p.polcmd = 'd';
  if del is null then
    raise exception 'A-17 FAIL: social_access_permissions has no DELETE policy';
  end if;
  if del not like '%is_family_admin(family_id)%'
     or del not like '%social_has_permission(family_id, ''manage_access''%' then
    raise exception 'A-17 FAIL: the delete policy no longer carries 0319''s predicate (is_family_admin(family_id) or social_has_permission(family_id, ''manage_access'')) — it reads: %', del;
  end if;
  raise notice 'A-17 OK: the delete policy still carries 0319''s disjunction';
end $$;

-- ── The probe detects the state it forbids ───────────────────────────────────
begin;
insert into public.social_access_permissions (family_id, user_id, social_role, status, granted_by)
  values (:'FS',:'UA','read_only','active',:'UP') on conflict (family_id, user_id) do update set social_role = 'read_only', status = 'active';
drop policy if exists social_access_permissions_delete on public.social_access_permissions;
create policy social_access_permissions_delete on public.social_access_permissions
  for delete to authenticated using (public.is_family_member(family_id));
do $$
declare gone int;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000005a03', true);
  perform set_config('request.jwt.claim.role','authenticated', true);
  with removed as (
    delete from public.social_access_permissions
     where family_id = '00000000-0000-4000-8000-000000005a01'
       and user_id   = '00000000-0000-4000-8000-000000005a03'
    returning 1
  ) select count(*) into gone from removed;
  perform set_config('role','postgres', true);
  if gone <> 1 then
    raise exception 'A-17 FAIL: the pre-0319 policy was restored and the member still could NOT delete — this probe proves nothing';
  end if;
  raise notice 'A-17 OK: with 0034''s delete policy restored the member CAN remove their restriction — not decoration';
end $$;
rollback;

do $$
declare expr text;
begin
  select coalesce(pg_get_expr(p.polqual,p.polrelid),'') into expr
    from pg_policy p join pg_class c on c.oid=p.polrelid
    where c.relname='social_access_permissions' and p.polcmd='d';
  if expr not like '%is_family_admin%' then
    raise exception 'A-17 FAIL: the planted policy survived the rollback';
  end if;
  raise notice 'A-17 OK: the planted policy was rolled back';
end $$;
