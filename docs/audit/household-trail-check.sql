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
-- NEGATIVE CONTROL, and it runs FIRST, before any of the checks
-- ---------------------------------------------------------------------------
-- The prose above quotes `audit_insert` as 0118's `family_id is null or
-- is_family_member(family_id)`. That is STALE, and replaying an old migration in
-- your head is how an audit credits a guard a later one replaced. `grep -l
-- audit_insert supabase/migrations` hits 0004, 0118 and 0320; the LAST of those,
-- `0320_audit_logs_says_who_wrote_it.sql`, drops `audit_insert` and re-creates it
-- as
--
--   for insert to authenticated
--   with check (public.is_family_member(family_id) and actor_id = auth.uid())
--
-- so the append predicate under test is that conjunction, and this file asserts
-- each thing it says, one check per clause:
--
--   * `is_family_member(family_id)` — the family pin, unchanged since 0004 — is
--     check 2 (a member forges a row into a family they are not in);
--   * `actor_id = auth.uid()` — the actor pin 0320 added — is check 2b (a member
--     signs a row in their OWN family with the parent's id);
--   * the missing `family_id is null` branch — the household-less row 0320 took
--     away — is check 2c (a member files a row that belongs to no family).
--
-- Restore 0118's predicate verbatim and 2b and 2c go red; drop the family pin
-- and 2 goes red. Nothing after 0320 touches this table's policies. The READ
-- predicate is still 0118's `audit_select`, `using
-- (public.can_manage_family(family_id))`, which 0320 left alone deliberately and
-- says so in its own header. The sibling probe
-- `docs/audit/audit-log-says-who-wrote-it-check.sql` asserts the same pin from
-- 0320's own point of view (who SIGNED); this probe asserts it from the trail's
-- (who may append at all, and who may read), and the two overlap on purpose.
--
-- MECHANISM: RLS, on both halves. Not a trigger, not a CHECK constraint, not a
-- unique index, not a GRANT. `grep -n 'on public\.audit_logs' supabase/
-- migrations` returns nothing but 0002's index and the drop/create policy pairs
-- in 0004, 0118 and 0320 — no trigger on this table (the corpus's one audit trigger
-- writes `social_audit_logs`, 0034, and every `execute format('create trigger
-- …')` loop iterates a named list this table is not on) and no revoke; 0002
-- declares `audit_logs` with no CHECK and no unique index beyond its PK; and
-- 0004 enables row level security on every public BASE TABLE in a loop, this one
-- included. A grep goes stale the day a migration lands, so check 0 MEASURES
-- this from the catalog rather than asserting it from the corpus: `pg_class`
-- says RLS is on; `pg_policies` holds exactly two policies on the table —
-- `audit_insert`, PERMISSIVE, INSERT, to `{authenticated}`, whose WITH CHECK
-- names `is_family_member(family_id)` and `actor_id = auth.uid()` and has no
-- `is null` branch, and `audit_select`, PERMISSIVE, SELECT, whose USING names
-- `can_manage_family(family_id)` — and `pg_trigger` holds no user trigger on it.
-- A permissive third policy would OR straight past both pins; a restrictive one
-- or a guard trigger would refuse 2, 2b and 2c in the policy's place with the
-- WITH CHECK loosened underneath, and the catalog check is the one that sees it.
-- So the control below is built against the two policy predicates and nothing
-- else.
--
-- Why the refusals need one. Checks 2, 2b, 2c, 4 and 5 are refusals, and a
-- refusal is evidence about a policy only if this session could have succeeded:
--
--   * 2, 2b and 2c catch `insufficient_privilege` and credit the WITH CHECK —
--     but a missing or revoked table GRANT raises 42501, a column-level denial
--     raises 42501, a dead `auth.uid()` raises 42501 (it also makes
--     `actor_id = auth.uid()` NULL), and so does a guard TRIGGER, which is how
--     this repository refuses writes in 0223, 0305, 0326 and 0331. Check 1 is a
--     positive append, and it does rule out the crudest of those — but it is NOT
--     the MIRROR of 2: it differs in `action` ('update' vs 'delete'), in
--     `resource` ('chores' vs 'calendar') and in naming `metadata`. So a guard
--     trigger keyed on the SHAPE of the write — `action = 'delete'`, `resource =
--     'calendar'` — refuses 2, 2b and 2c and leaves 1 completely untouched.
--   * 4 and 5 assert ZERO ROWS, and each of them converts a 42501 into its own
--     pass value (`exception when insufficient_privilege then seen := 0`). A row
--     a session simply cannot SEE reports zero exactly as `can_manage_family`
--     saying no does. Nothing else here proves the CHILD's session could read a
--     trail row at all, and nothing at all proves the OUTSIDER's could: check
--     3's reader is a third session, the anchor parent's.
--
-- So each leg is the same actor running the same statement with every field at
-- its LEGAL value — the forgeries below each change exactly one of them — and
-- it must LAND:
--
--   A. the mirror of 2, 2b and 2c at once: the same child, the same four
--      columns, the same 'delete' on 'calendar', `family_id` = the anchor
--      family they ARE in (2 changes this), `actor_id` = their own id (2b
--      changes this), and a `family_id` that is not null (2c changes this). The
--      column list is the mirror on purpose — Postgres checks column privileges
--      against the SET list and not against the values, so a control naming a
--      different set sails straight past a later `revoke insert (…) on
--      audit_logs` and then reports the resulting bare 42501 as the policy.
--   B. the mirror of 4: the SAME child reading `audit_logs` in a SECOND family
--      (FK) that this child created and manages, so `can_manage_family` answers
--      YES for the very session it answers no for in 4. Its row is seeded as
--      postgres before any role switch, so B measures `audit_select` and not
--      `audit_insert`.
--   C. the mirror of 5: the SAME outsider reading `audit_logs` in their OWN
--      household (FO), where they are a manager. This leg also makes 5's label
--      true. 5 calls UO "an unrelated family's parent", and that rested entirely
--      on `handle_new_family` (0257) having filed the creator as a 'parent'
--      member; the seed below now re-asserts that role rather than assuming it,
--      because if that trigger ever stopped firing, 5 would quietly weaken into
--      "a user who manages nothing sees nothing" and still pass.
--
-- Each leg row-counts (the INSERT, via `get diagnostics`) or counts rows (the
-- SELECTs) rather than trusting the absence of an exception, because a BEFORE
-- trigger that returns NULL swallows a row silently and "no error" is not "the
-- write landed". Check 1 row-counts for the same reason, and it has to: leg A
-- puts a row of its own into FA ahead of it, so check 3's `>= 1` is satisfied by
-- A's row alone and no longer corroborates that check 1's row persisted. And
-- each leg catches `others`, not only `insufficient_privilege`, because the
-- confounder being ruled out need not raise 42501 at all.
--
-- If any leg fails, the probe raises UNPROVEN and does not run the checks: not
-- "the boundary holds", not "the boundary is broken", but "this session never
-- had the access the refusals are supposed to be measuring". Red either way.
-- Check 0 keeps its place ahead of the control — it is a catalog precondition
-- rather than a refusal — and the control reuses the same `fails` array so a
-- disabled RLS or a rewritten policy still rides along in the UNPROVEN message.
--
-- The whole probe runs inside ONE transaction that is rolled back at the end,
-- green or red. run-probes.sh drives every docs/audit/*-check.sql at one
-- database in sequence, and `psql -v ON_ERROR_STOP=1` halts at the first RAISE —
-- so a teardown written after the DO block runs only on the green path, and a
-- red run under autocommit used to leave FK (plus the `subscriptions` and
-- `family_ai_settings` rows `handle_new_family` creates for it), its member row
-- and the trail rows behind for every probe that ran after it. Under `begin …
-- rollback` a halted psql closes the connection and the server discards the
-- transaction, so a failed probe leaves exactly what a passing one does:
-- nothing. 0299's deferred `trg_family_keeps_a_manager` never fires either way,
-- since a rolled-back transaction has no commit for it to fire at.
--
--   bash docs/audit/verify-pg.sh up
--   PGHOST=/tmp/pgaudit_db PGPORT=54399 PGUSER=postgres PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/household-trail-check.sql
--
-- Exit is non-zero (via RAISE EXCEPTION) if any invariant fails.
-- The probe rolls its fixtures back, so re-running it proves the same thing.

\set FA '00000000-0000-4000-8000-0000000000f1'
\set UC '00000000-0000-4000-8000-00000000ac01'
\set UO '00000000-0000-4000-8000-00000000ac02'
\set FO '00000000-0000-4000-8000-00000000ac0f'
-- The control's own anchors, in this probe's `ac` style. Every one of these
-- three was grepped across docs/audit and supabase/migrations before being used
-- and appears nowhere else. The rollback does not make that optional: the
-- fixtures are `on conflict do nothing`, so a uuid borrowed from a neighbour
-- whose fixture had committed would silently make THAT probe's row this probe's
-- control, and the leg would measure a household it never seeded.
\set FK '00000000-0000-4000-8000-00000000ac0c'
\set AK '00000000-0000-4000-8000-00000000ac0a'
\set AO '00000000-0000-4000-8000-00000000ac0b'

begin;

-- ── Fixtures: a child in the anchor family, and an unrelated family ─────────
-- The child is the actor the trail was blind to. `is_active` matters: both
-- helpers require it, so an inactive member would fail for the wrong reason.
insert into auth.users (id, email) values
  (:'UC','trail-child@example.com'), (:'UO','trail-outsider@example.com')
  on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FA', :'UC', 'Trail Child', 'child', true) on conflict do nothing;
-- No blanket `grant ... on all tables in schema public` here. The bootstrap's
-- `alter default privileges` already gives `authenticated` full DML on every
-- table a migration creates, so the restatement was redundant — and once
-- migrations began revoking DML deliberately (0300 takes the paywall columns
-- away from the client), it stopped being redundant and started undoing them
-- for every probe that runs after this one against the shared database.
insert into public.families (id, name, created_by) values (:'FO','Unrelated Family',:'UO')
  on conflict do nothing;

-- ── The control's households ────────────────────────────────────────────────
-- FK is a family the CHILD created, so `can_manage_family(FK)` answers yes for
-- the very user `can_manage_family(FA)` answers no for — that difference is the
-- whole of leg B. `handle_new_family` (0257, AFTER INSERT on families) has
-- already filed the creator as a 'parent' member by the time the next statement
-- runs, so in a normal run the upsert takes its UPDATE path and re-asserts the
-- role rather than assuming it; only if that trigger stopped firing would the
-- INSERT path run. Either way the row's id is whatever the database gave it —
-- no fixed id is needed, because nothing here refers to the member row by id.
-- `can_manage_family` is `role in ('parent','adult') and is_active` (0003), and
-- a seed whose roles were wrong would fail the control for a reason that is not
-- the control's.
insert into public.families (id, name, created_by) values (:'FK','Trail Child''s Own House',:'UC')
  on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FK', :'UC', 'Trail Child (a manager here)', 'parent', true)
  on conflict (family_id, user_id) do update set role = 'parent', is_active = true;
-- And the same re-assertion for the outsider in their own house, for leg C. Note
-- what this fixes in check 5 itself: 5 is labelled "an unrelated family's parent"
-- and never established that UO was a parent of anything.
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FO', :'UO', 'Trail Outsider (a manager here)', 'parent', true)
  on conflict (family_id, user_id) do update set role = 'parent', is_active = true;
-- One trail row per control household, appended HERE as postgres — before any
-- role switch — so what legs B and C measure is `audit_select` and not
-- `audit_insert`. Neither lands in FA. Leg A's row DOES land in FA, as does
-- check 1's, so 3 counts two rows where it once counted one (hence check 1's own
-- row count, above), and 4 and 5 now have two rows to fail to see instead of
-- one — the zero they assert is worth more, not less.
insert into public.audit_logs (id, family_id, actor_id, action, resource, metadata)
  values (:'AK', :'FK', :'UC', 'update', 'chores',
          '{"title":"Marked \"Feed the cat\" done"}'::jsonb) on conflict do nothing;
insert into public.audit_logs (id, family_id, actor_id, action, resource)
  values (:'AO', :'FO', :'UO', 'update', 'chores') on conflict do nothing;


do $$
declare
  n int;
  wrote boolean;
  seen int;
  pols text;
  fails text[] := '{}';
  -- The control's anchors, written out in full: psql does not interpolate
  -- :'FK' inside a dollar-quoted block, which is why the checks below spell
  -- their uuids out too.
  child_u    constant uuid := '00000000-0000-4000-8000-00000000ac01';  -- UC
  out_u      constant uuid := '00000000-0000-4000-8000-00000000ac02';  -- UO
  parent_u   constant uuid := '00000000-0000-4000-8000-000000000001';  -- the anchor parent
  anchor_f   constant uuid := '00000000-0000-4000-8000-0000000000f1';  -- FA
  other_f    constant uuid := '00000000-0000-4000-8000-00000000ac0f';  -- FO
  ctl_f      constant uuid := '00000000-0000-4000-8000-00000000ac0c';  -- FK
  control_ok boolean := true;
begin
  -- ── 0: RLS is on, and the policies are the ones this probe names ─────────
  -- Every assertion below is vacuous without RLS, and every refusal below is
  -- credited to a specific predicate: read both back from the catalog, so the
  -- header's migration inventory cannot go stale behind a grep.
  select count(*) into n from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relname = 'audit_logs' and c.relrowsecurity;
  if n <> 1 then fails := fails || 'RLS is DISABLED on audit_logs'::text; end if;

  select count(*) into n from pg_policies
    where schemaname = 'public' and tablename = 'audit_logs' and policyname = 'audit_insert'
      and cmd = 'INSERT' and permissive = 'PERMISSIVE' and roles = '{authenticated}'::name[]
      and with_check ~ '\mis_family_member\(family_id\)'
      and with_check ~ '\mactor_id = auth\.uid\(\)'
      and with_check !~* '\mis null\M';
  if n <> 1 then
    select string_agg(format('%s %s %s to %s check %s', policyname, permissive, cmd, roles, with_check), '; ')
      into pols from pg_policies where schemaname = 'public' and tablename = 'audit_logs' and cmd = 'INSERT';
    fails := fails || format('audit_insert is not 0320''s `for insert to authenticated with check (is_family_member(family_id) and actor_id = auth.uid())` without a null branch — found: %s — so the refusals in 2, 2b and 2c are not the predicate this probe attributes them to', coalesce(pols, 'no INSERT policy'));
  end if;

  select count(*) into n from pg_policies
    where schemaname = 'public' and tablename = 'audit_logs' and policyname = 'audit_select'
      and cmd = 'SELECT' and permissive = 'PERMISSIVE'
      and qual ~ '\mcan_manage_family\(family_id\)';
  if n <> 1 then
    fails := fails || 'audit_select is no longer `using (can_manage_family(family_id))` (0118:113), so the manager-only reads in 3, 4 and 5 are not the policy this probe attributes them to'::text;
  end if;

  select string_agg(format('%s (%s %s)', policyname, permissive, cmd), ', ' order by policyname)
    into pols from pg_policies
    where schemaname = 'public' and tablename = 'audit_logs'
      and policyname not in ('audit_insert', 'audit_select');
  if pols is not null then
    fails := fails || format('audit_logs carries a policy this probe does not know: %s — a permissive one ORs past both pins, a restrictive one refuses in their place', pols);
  end if;

  select string_agg(tgname, ', ' order by tgname) into pols
    from pg_trigger where tgrelid = 'public.audit_logs'::regclass and not tgisinternal;
  if pols is not null then
    fails := fails || format('audit_logs carries a trigger (%s); the header says the only mechanism on this table is RLS, and a guard trigger is the one confounder leg A cannot tell from the policy', pols);
  end if;

  -- ── NEGATIVE CONTROL: the same actors, the same statements, the other answer
  -- Three legs, one for each refusal family below (2/2b/2c, 4 and 5), and they
  -- run FIRST — ahead of check 1 too, which is a positive append but the mirror
  -- of nothing. All three must LAND; if one does not, this session never had
  -- the access the refusals are supposed to be measuring, and the probe says so
  -- instead of reporting a boundary it cannot see. Header has the full reasoning.

  -- A. The mirror of 2, 2b and 2c — the forgeries, with every field legal: the
  --    family this child IS a member of (2 changes this), the child's own id as
  --    actor (2b changes this), a family_id that is not null (2c changes this).
  --    Same four columns as the forgeries (a column-level revoke cannot hide
  --    behind a different SET list), same 'delete' on 'calendar' (a guard
  --    trigger keyed on the shape of the write cannot either).
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', child_u::text, true);
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource)
      values (anchor_f, child_u, 'delete', 'calendar');
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      fails := fails || 'CONTROL A FAILED: this child''s append of the SAME delete-on-calendar row, signed with their own id, into the family they ARE a member of stored 0 rows, so the refusals in 2, 2b and 2c would prove nothing about audit_insert'::text;
    end if;
  exception when others then
    control_ok := false;
    fails := fails || format('CONTROL A FAILED: this child was refused the SAME delete-on-calendar row, signed with their own id, in the family they ARE a member of (%s: %s), so the refusals in 2, 2b and 2c would prove only that SOMETHING said no — a missing or revoked table grant, a narrowed column grant, a dead auth.uid() and a guard trigger keyed on action/resource all say it too', sqlstate, sqlerrm);
  end;
  perform set_config('role', 'none', true);

  -- B. The mirror of 4 — the same child, the same count, in the SECOND family
  --    this child created and manages, where `can_manage_family` answers YES
  --    for the very session it answers no for in 4. The row was seeded as
  --    postgres above, so this reads through `audit_select` alone.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', child_u::text, true);
  begin
    select count(*) into n from public.audit_logs where family_id = ctl_f;
    if n = 0 then
      control_ok := false;
      fails := fails || 'CONTROL B FAILED: this child READ 0 trail rows in the family they DO manage, where one was seeded as postgres — so the zero-row read in 4 would prove nothing about audit_select: this session cannot see a trail row under any predicate'::text;
    end if;
  exception when others then
    control_ok := false;
    fails := fails || format('CONTROL B FAILED: this child''s read of the trail in the family they DO manage raised %s: %s — and 4 turns exactly that 42501 into its own pass value, so the zero-row read there would prove nothing about audit_select', sqlstate, sqlerrm);
  end;
  perform set_config('role', 'none', true);

  -- C. The mirror of 5 — the same outsider, the same count, in their OWN
  --    household, where they are a manager. Nothing else in this probe touches
  --    that session: check 3's reader is the anchor parent and B's is the child,
  --    so without this leg 5's zero has no baseline at all.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', out_u::text, true);
  begin
    select count(*) into n from public.audit_logs where family_id = other_f;
    if n = 0 then
      control_ok := false;
      fails := fails || 'CONTROL C FAILED: the outsider READ 0 trail rows in their OWN family, where one was seeded as postgres and their manager role was re-asserted — so the zero-row read in 5 would prove nothing about can_manage_family: that session cannot see a trail row anywhere'::text;
    end if;
  exception when others then
    control_ok := false;
    fails := fails || format('CONTROL C FAILED: the outsider''s read of their OWN family trail raised %s: %s — and 5 turns exactly that 42501 into its own pass value, so the zero-row read there would prove nothing about can_manage_family', sqlstate, sqlerrm);
  end;
  perform set_config('role', 'none', true);

  -- A failed leg makes every refusal below unreadable, so say WHY here, while
  -- the reason is still in hand, and do not run them. The boundary is reported
  -- neither as holding nor as broken: it is reported as unproven, and the build
  -- is red either way. `fails` is the probe's own array on purpose, so check 0's
  -- verdict rides along — a disabled RLS or a rewritten policy is the first
  -- thing a reader of this message needs to know.
  if not control_ok then
    raise exception 'HOUSEHOLD TRAIL UNPROVEN (the controls this probe rests on did not hold): %',
      array_to_string(fails, '; ');
  end if;

  -- ── 1: a CHILD may append their own family's trail ───────────────────────
  -- Row-counted, not inferred from the absence of an error: leg A has already
  -- put a row into FA, so check 3's `>= 1` no longer tells this row's fate.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000ac01', true);
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource, metadata)
      values ('00000000-0000-4000-8000-0000000000f1',
              '00000000-0000-4000-8000-00000000ac01', 'update', 'chores',
              '{"title":"Marked \"Make your bed\" done"}'::jsonb);
    get diagnostics n = row_count;
    wrote := (n = 1);
  exception when insufficient_privilege or check_violation then wrote := false;
  end;
  perform set_config('role', 'none', true);
  if not wrote then
    fails := fails || 'a child CANNOT append to their own family trail (refused, or 0 rows stored) — every change they make is invisible'::text;
  end if;

  -- ── 2: that child may NOT attribute a change to another family ───────────
  -- Leg A with one field changed: `family_id`, the field `is_family_member`
  -- keys on.
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

  -- ── 2b: that child may NOT sign a row in their OWN family as the parent ──
  -- Leg A with one field changed: `actor_id`, the field 0320's second conjunct
  -- keys on. Same family (FA), same shape — `is_family_member` says yes to this
  -- row, so only `actor_id = auth.uid()` can refuse it. Under 0118's predicate
  -- this row LANDS and /family/activity renders it as the parent's doing.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000ac01', true);
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource)
      values ('00000000-0000-4000-8000-0000000000f1',
              parent_u, 'delete', 'calendar');
    wrote := true;
  exception when insufficient_privilege or check_violation then wrote := false;
  end;
  perform set_config('role', 'none', true);
  if wrote then
    fails := fails || 'a child CAN sign a trail row in their own family with the PARENT''s id — audit_insert no longer pins actor_id = auth.uid() (0320)'::text;
  end if;

  -- ── 2c: that child may NOT file a row that belongs to no household ───────
  -- Leg A with one field changed: `family_id` = null, the branch 0320 removed.
  -- `is_family_member(null)` is false (0003: an `exists` over `family_id =
  -- null`), so under 0320 this is a 42501; under 0118's `family_id is null or …`
  -- it LANDS, invisible to every RLS reader and rendered by the admin security
  -- feed's service client as a genuine platform event.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000ac01', true);
  begin
    insert into public.audit_logs (family_id, actor_id, action, resource)
      values (null,
              '00000000-0000-4000-8000-00000000ac01', 'delete', 'calendar');
    wrote := true;
  exception when insufficient_privilege or check_violation then wrote := false;
  end;
  perform set_config('role', 'none', true);
  if wrote then
    fails := fails || 'a member CAN file a household-less trail row (family_id null) — the branch 0320 removed from audit_insert is back'::text;
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
  raise notice 'household trail OK: pg_policies holds exactly 0320''s audit_insert and 0118''s audit_select and no trigger; the controls landed (the same child appends the same delete-on-calendar row, signed as themselves, in the family they ARE in, and reads the trail where they DO manage; the outsider reads their own household''s), and given that access any member appends as themselves, no one forges another family, another actor or a household-less row, only a parent reads, no family sees another''s';
end $$;

-- Nothing to tear down: the transaction opened above is discarded, fixtures,
-- trail rows and `handle_new_family`'s side rows alike, whether the DO block
-- got here or halted psql at UNPROVEN or FAIL (a closed connection rolls back
-- too). A second run therefore asserts the same thing against the same state.
rollback;

select 'household trail probe: ALL INVARIANTS PASSED' as result;
