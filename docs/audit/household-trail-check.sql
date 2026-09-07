-- ── The household trail: who may append, who may read ───────────────────────
-- `public.audit_logs` (0002) is the family's own record of who changed what,
-- rendered at /family/activity as "a running log of changes across your
-- household". The domain service layer appends to it after every committed
-- write, for a person and for Bubaly alike — which is the whole point, because
-- `agent_activity` deliberately records only the assistant.
--
-- That design rests entirely on two policies from `0004` (repaired by `0118`),
-- and they point in OPPOSITE directions:
--
--   audit_insert ... with check (family_id is null or is_family_member(...))
--   audit_select ... using (can_manage_family(...))
--
-- So ANY member may append — including a child ticking off their own chore,
-- which is exactly the actor whose changes the trail was missing — while only a
-- parent or adult may read it back. A trail that a child could not write would
-- have holes in it for the person doing the work; a trail that a child could
-- read is a different product. Both halves are asserted here so that widening
-- either one is a deliberate, visible diff rather than a side effect.
--
--   bash docs/audit/verify-pg.sh up
--   PGHOST=/tmp/pgaudit_db PGPORT=54399 PGUSER=postgres PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/household-trail-check.sql
--
-- Exit is non-zero (via RAISE EXCEPTION) if any invariant fails.
-- The probe removes its own fixtures, so re-running it proves the same thing.

\set FA '00000000-0000-4000-8000-0000000000f1'
\set UC '00000000-0000-4000-8000-00000000ac01'
\set UO '00000000-0000-4000-8000-00000000ac02'
\set FO '00000000-0000-4000-8000-00000000ac0f'

-- ── Fixtures: a child in the anchor family, and an unrelated family ─────────
-- The child is the actor the trail was blind to. `is_active` matters: both
-- helpers require it, so an inactive member would fail for the wrong reason.
insert into auth.users (id, email) values
  (:'UC','trail-child@example.com'), (:'UO','trail-outsider@example.com')
  on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FA', :'UC', 'Trail Child', 'child', true) on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FO','Unrelated Family',:'UO')
  on conflict do nothing;

grant select, insert, update, delete on all tables in schema public to authenticated;

do $$
declare
  n int;
  wrote boolean;
  seen int;
  fails text[] := '{}';
begin
  -- ── 0: RLS is on. Every assertion below is vacuous without it ────────────
  select count(*) into n from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relname = 'audit_logs' and c.relrowsecurity;
  if n <> 1 then fails := fails || 'RLS is DISABLED on audit_logs'::text; end if;

  -- ── 1: a CHILD may append their own family's trail ───────────────────────
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000ac01', true);
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource, metadata)
      values ('00000000-0000-4000-8000-0000000000f1',
              '00000000-0000-4000-8000-00000000ac01', 'update', 'chores',
              '{"title":"Marked \"Make your bed\" done"}'::jsonb);
    wrote := true;
  exception when insufficient_privilege or check_violation then wrote := false;
  end;
  perform set_config('role', 'none', true);
  if not wrote then
    fails := fails || 'a child CANNOT append to their own family trail — every change they make is invisible'::text;
  end if;

  -- ── 2: that child may NOT attribute a change to another family ───────────
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000ac01', true);
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource)
      values ('00000000-0000-4000-8000-00000000ac0f',
              '00000000-0000-4000-8000-00000000ac01', 'delete', 'calendar');
    wrote := true;
  exception when insufficient_privilege or check_violation then wrote := false;
  end;
  perform set_config('role', 'none', true);
  if wrote then
    fails := fails || 'a member CAN forge a trail row for another family'::text;
  end if;

  -- ── 3: a PARENT of the family reads it back ──────────────────────────────
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
  begin
    select count(*) into seen from public.audit_logs
      where family_id = '00000000-0000-4000-8000-0000000000f1';
  exception when insufficient_privilege then seen := -1;
  end;
  perform set_config('role', 'none', true);
  if seen < 1 then
    fails := fails || format('a parent cannot read their own family trail (saw %s)',
                             case when seen < 0 then 'no grant' else seen::text end);
  end if;

  -- ── 4: the child does NOT read it — audit_select is can_manage_family ────
  -- Asserted, not assumed: the trail is a parent's record today, and making it
  -- a child's too is a product change that has to edit this line.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000ac01', true);
  begin
    select count(*) into seen from public.audit_logs
      where family_id = '00000000-0000-4000-8000-0000000000f1';
  exception when insufficient_privilege then seen := 0;
  end;
  perform set_config('role', 'none', true);
  if seen <> 0 then
    fails := fails || format('a child can READ the household trail (%s rows) — audit_select has widened', seen);
  end if;

  -- ── 5: an unrelated family's parent reads nothing of ours ────────────────
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000ac02', true);
  begin
    select count(*) into seen from public.audit_logs
      where family_id = '00000000-0000-4000-8000-0000000000f1';
  exception when insufficient_privilege then seen := 0;
  end;
  perform set_config('role', 'none', true);
  if seen <> 0 then
    fails := fails || format('another family reads our household trail (%s rows)', seen);
  end if;

  if array_length(fails, 1) > 0 then
    raise exception 'HOUSEHOLD TRAIL FAIL: %', array_to_string(fails, '; ');
  end if;
  raise notice 'household trail OK: any member appends, only a parent reads, no family sees another''s';
end $$;

-- Fixtures out, so a second run asserts the same thing against the same state.
delete from public.audit_logs where actor_id = :'UC';
delete from public.family_members where user_id = :'UC';
delete from public.families where id = :'FO';
delete from auth.users where id in (:'UC', :'UO');

select 'household trail probe: ALL INVARIANTS PASSED' as result;
